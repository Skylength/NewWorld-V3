import { Agent } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { awaitWithSignal } from "../agent/abort.js";
import { terminatedStream, type PiModelRuntime } from "../agent/runtime.js";
import type { ExplorationContext, ExplorationRun } from "./types.js";

export interface WorldModelOptions {
  runtime: PiModelRuntime;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  onProgress?: (update: Partial<Pick<ExplorationRun, "phase" | "rawResponse" | "modelRequests" | "usage">>) => void;
}

/** A bounded world turn still runs through the real Pi Agent, including in scripted tests. */
export async function runWorldModel(context: ExplorationContext, options: WorldModelOptions): Promise<string> {
  if (context.systemPrompt.length + context.userPrompt.length > 24_000) throw new Error("上下文超过 24000 字符，本次未发送模型请求。");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxTokens = options.maxOutputTokens ?? 4096;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("模型预算无效");
  const controller = new AbortController();
  let finished = false;
  let requests = 0;
  let raw = "";
  let timedOut = false;
  const progress: NonNullable<WorldModelOptions["onProgress"]> = update => {
    if (!finished && !controller.signal.aborted) options.onProgress?.(update);
  };
  const { model, streamSimple } = options.runtime;
  const agent = new Agent({
    initialState: { model, systemPrompt: context.systemPrompt, tools: [], thinkingLevel: "off" },
    streamFn: (selected, transcript, streamOptions) => {
      if (controller.signal.aborted || finished) return terminatedStream(selected, "aborted", "世界回合已取消");
      if (requests >= 1) return terminatedStream(selected, "error", "世界回合只允许一次模型请求");
      if (getCurrentSystemPrompt(transcript.messages) !== context.systemPrompt) return terminatedStream(selected, "error", "模型上下文与记录不一致");
      requests++;
      progress({ phase: "模型正在生成", modelRequests: requests });
      return streamSimple(selected, transcript, { ...streamOptions, maxRetries: 0, maxTokens });
    },
    beforeToolCall: async () => ({ block: true, terminate: true, reason: "区域探索回合不执行模型工具" }),
    finishTurn: async () => ({ action: "end" }),
  });
  const onAbort = () => { controller.abort(options.signal?.reason); agent.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("世界回合超时"));
    agent.abort();
  }, timeoutMs);
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      raw += event.assistantMessageEvent.delta;
      progress({ rawResponse: raw });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      // Some compatible providers omit usage; their adapter reports zeros. Display unknown instead of invented free use.
      if (usage.totalTokens > 0) progress({ usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens } });
    }
  });
  try {
    await awaitWithSignal(controller.signal, () => agent.prompt(context.userPrompt));
    if (controller.signal.aborted) throw new Error("世界回合已取消");
    const message = [...agent.state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
    if (!message || message.stopReason !== "stop" || message.content.some(b => b.type === "toolCall")) {
      throw new Error(message?.errorMessage || "模型未返回完整结果（可能达到输出上限）；未提交世界变化。");
    }
    raw = message.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    progress({ rawResponse: raw, phase: "检查世界变化" });
    if (!raw) throw new Error("模型返回空结果，未提交世界变化。");
    return raw;
  } catch (error) {
    if (timedOut) throw new Error(`模型超过 ${Math.round(timeoutMs / 1000)} 秒，已停止且未提交世界变化。`);
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    if (controller.signal.aborted) agent.abort();
  }
}
