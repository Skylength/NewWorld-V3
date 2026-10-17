import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { buildActorSystemPrompt, buildObservationMessage } from "./context.js";
import type {
  ActorRepository,
  ActorRunRequest,
  ActorRunResult,
  MemoryReader,
} from "./types.js";
import { createRecallTool } from "../memory/recall-tool.js";
import { createPiModel, type ModelConfig } from "../agent/model.js";
import { terminatedStream, type PiModelRuntime } from "../agent/runtime.js";
import { awaitWithSignal } from "../agent/abort.js";

export interface ActorRunLimits {
  maxModelRequests: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface ActorRunEvent {
  type: string;
  runId: string;
  worldId: string;
  actorId: string;
  at: string;
  [key: string]: unknown;
}

interface RunReplyDependencies {
  actorRepository: ActorRepository;
  memoryReader: MemoryReader;
  limits?: Partial<ActorRunLimits>;
  signal?: AbortSignal;
  onEvent?: (event: ActorRunEvent) => void;
}

export type RunReplyOptions = RunReplyDependencies & (
  | { model: ModelConfig; modelRuntime?: never }
  | { modelRuntime: PiModelRuntime; model?: never }
);

const DEFAULT_LIMITS: ActorRunLimits = {
  maxModelRequests: 4,
  maxToolCalls: 3,
  timeoutMs: 120_000,
};

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function textFrom(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function traceMessage(message: Message): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content
        .filter((block) => block.type !== "thinking")
        .map((block) => block.type === "text"
          ? { type: block.type, text: block.text }
          : { type: block.type, name: block.name, arguments: block.arguments }),
      stopReason: message.stopReason,
    };
  }
  if (message.role === "system") {
    return { role: message.role, content: message.content, sections: message.sections };
  }
  if (message.role === "toolResult") {
    return {
      role: message.role,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
    };
  }
  return { role: message.role, content: message.content };
}

function traceTool(tool: Tool): Record<string, unknown> {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function emit(options: RunReplyOptions, request: ActorRunRequest, type: string, fields: Record<string, unknown> = {}): void {
  try {
    options.onEvent?.({
      type,
      runId: request.runId,
      worldId: request.scope.worldId,
      actorId: request.scope.actorId,
      at: new Date().toISOString(),
      ...fields,
    });
  } catch {
    // Observability must not change the result of the NPC run.
  }
}

function failure(request: ActorRunRequest, code: string, message: string): ActorRunResult {
  return { status: "failed", runId: request.runId, code, message };
}

export async function runActorReply(request: ActorRunRequest, options: RunReplyOptions): Promise<ActorRunResult> {
  request = { ...request, scope: { ...request.scope }, observation: { ...request.observation } };
  let settled = false;
  const publish = (type: string, fields: Record<string, unknown> = {}) => {
    if (!settled) emit(options, request, type, fields);
  };
  publish("run_started");
  let result: ActorRunResult = failure(request, "run_failed", "运行未能完成");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runController: AbortController | undefined;
  let activeAgent: Agent | undefined;
  let unsubscribe: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  let budgetCode: string | undefined;
  let modelRequestCount = 0;
  let completedModelResponseCount = 0;
  let toolCallCount = 0;
  let timeoutReached = false;

  try {
    if (!request.runId.trim()) {
      result = failure(request, "invalid_run_id", "runId 不能为空");
      return result;
    }
    if (!request.scope.worldId.trim() || !request.scope.actorId.trim()) {
      result = failure(request, "invalid_scope", "worldId 和 actorId 不能为空");
      return result;
    }
    if (!request.observation.text.trim()) {
      result = failure(request, "empty_observation", "观察内容不能为空");
      return result;
    }
    if (options.signal?.aborted) {
      result = { status: "aborted", runId: request.runId, code: "caller_aborted", message: "调用方已取消本次运行" };
      return result;
    }

    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (
      !Number.isInteger(limits.maxModelRequests) || limits.maxModelRequests <= 0 ||
      !Number.isInteger(limits.maxToolCalls) || limits.maxToolCalls <= 0 ||
      !Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0
    ) {
      result = failure(request, "invalid_budget", "模型请求数、工具调用数必须是正整数，超时必须是正数");
      return result;
    }

    if (!options.modelRuntime && (!options.model.apiKey.trim() || !options.model.modelId.trim())) {
      result = failure(request, "missing_model_config", "发送模型请求前必须配置 LLM_API_KEY 和 LLM_MODEL");
      return result;
    }

    runController = new AbortController();
    onAbort = () => {
      runController?.abort(options.signal?.reason);
      activeAgent?.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      result = { status: "aborted", runId: request.runId, code: "caller_aborted", message: "调用方已取消本次运行" };
      return result;
    }
    timer = setTimeout(() => {
      timeoutReached = true;
      runController?.abort(new Error("NPC run timeout"));
      activeAgent?.abort();
    }, limits.timeoutMs);

    const actor = await awaitWithSignal(runController.signal, () => options.actorRepository.load(request.scope, runController?.signal));
    if (timeoutReached) {
      result = { status: "budget_exceeded", runId: request.runId, code: "time_budget_exceeded", message: "运行超过 " + limits.timeoutMs + "ms，已停止" };
      return result;
    }
    if (options.signal?.aborted) {
      result = { status: "aborted", runId: request.runId, code: "caller_aborted", message: "本次 NPC 运行已取消" };
      return result;
    }
    if (!actor || actor.profile.id !== request.scope.actorId) {
      result = failure(request, "actor_not_found", "该世界中找不到指定角色");
      return result;
    }

    const { model, streamSimple } = options.modelRuntime ?? createPiModel(options.model);
    const memoryTool = createRecallTool(request.scope, options.memoryReader, ({ query, limit }) => {
      publish("tool_started", { toolName: "recall", query, limit });
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: buildActorSystemPrompt(actor),
        model,
        tools: [memoryTool],
        thinkingLevel: "off",
      },
      streamFn: (selectedModel, context, streamOptions) => {
        if (settled || runController?.signal.aborted || streamOptions?.signal?.aborted) {
          return terminatedStream(selectedModel, "aborted", "NPC run already cancelled");
        }
        if (modelRequestCount >= limits.maxModelRequests) {
          budgetCode = "model_request_budget_exceeded";
          return terminatedStream(selectedModel, "error", "NPC model request budget exceeded");
        }
        modelRequestCount += 1;
        publish("model_request_started", {
          requestNumber: modelRequestCount,
          model: selectedModel.id,
          provider: selectedModel.provider,
          systemPrompt: getCurrentSystemPrompt(context.messages),
          tools: getCurrentTools(context.messages).map(traceTool),
          messages: context.messages.map((message) => traceMessage(message as Message)),
        });
        // Disable provider-internal retries so one Pi request remains one budgeted request.
        return streamSimple(selectedModel, context, { ...streamOptions, maxRetries: 0 });
      },
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }, signal) => {
        if (settled || runController?.signal.aborted || signal?.aborted) {
          return { block: true, terminate: true, reason: "本次 NPC 运行已取消。" };
        }
        if (toolCallCount >= limits.maxToolCalls) {
          budgetCode = "tool_call_budget_exceeded";
          publish("tool_budget_blocked", {
            toolName: toolCall.name,
            maxToolCalls: limits.maxToolCalls,
          });
          return { block: true, terminate: true, reason: "本次 NPC 运行的工具调用预算已用完。" };
        }
        toolCallCount += 1;
        return undefined;
      },
      finishTurn: async ({ message }) => {
        if (budgetCode) return { action: "end" };
        if (modelRequestCount >= limits.maxModelRequests && hasToolCall(message)) {
          budgetCode = "model_request_budget_exceeded";
          return { action: "end" };
        }
        return undefined;
      },
    });
    activeAgent = agent;
    if (runController.signal.aborted) agent.abort();

    unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        publish("reply_delta", { delta: event.assistantMessageEvent.delta });
      } else if (event.type === "message_end" && isAssistantMessage(event.message)) {
        completedModelResponseCount += 1;
        publish("model_request_finished", {
          requestNumber: completedModelResponseCount,
          stopReason: event.message.stopReason,
          errorMessage: event.message.errorMessage,
        });
      } else if (event.type === "tool_execution_start") {
        publish("tool_call_received", {
          toolName: event.toolName,
          arguments: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        publish("tool_finished", {
          toolName: event.toolName,
          isError: event.isError,
          result: event.result,
        });
      }
    });

    await awaitWithSignal(runController.signal, () => agent.prompt(buildObservationMessage(request.observation)));

    const finalMessage = [...agent.state.messages].reverse().find(isAssistantMessage);
    if (timeoutReached) {
      result = { status: "budget_exceeded", runId: request.runId, code: "time_budget_exceeded", message: "运行超过 " + limits.timeoutMs + "ms，已停止" };
    } else if (options.signal?.aborted || finalMessage?.stopReason === "aborted") {
      result = { status: "aborted", runId: request.runId, code: "caller_aborted", message: "本次 NPC 运行已取消" };
    } else if (budgetCode) {
      result = { status: "budget_exceeded", runId: request.runId, code: budgetCode, message: "本次 NPC 运行已达到保护预算；未提交不完整回应" };
    } else if (!finalMessage || finalMessage.stopReason === "error") {
      result = failure(request, "model_error", finalMessage?.errorMessage ?? agent.state.errorMessage ?? "模型未能生成回应");
    } else if (finalMessage.stopReason !== "stop" || hasToolCall(finalMessage)) {
      result = failure(request, "incomplete_response", "模型运行结束时没有得到完整的最终角色回应");
    } else {
      const reply = textFrom(finalMessage);
      result = reply
        ? { status: "completed", runId: request.runId, reply }
        : failure(request, "empty_response", "模型没有生成可提交的角色回应");
    }
  } catch (error) {
    result = timeoutReached
      ? { status: "budget_exceeded", runId: request.runId, code: "time_budget_exceeded", message: "本次 NPC 运行已超时" }
      : options.signal?.aborted
        ? { status: "aborted", runId: request.runId, code: "caller_aborted", message: "本次 NPC 运行已取消" }
        : failure(request, "run_failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (runController?.signal.aborted) activeAgent?.abort();
    unsubscribe?.();
    publish("run_finished", {
      status: result.status,
      modelRequests: modelRequestCount,
      toolCalls: toolCallCount,
      code: result.status === "completed" ? undefined : result.code,
      result,
    });
    settled = true;
  }

  return result;
}
