import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { PiModelRuntime } from "../agent/runtime.js";
import { awaitWithSignal } from "../agent/abort.js";

export interface ScriptedResponse {
  content: AssistantMessage["content"];
  stopReason?: "stop" | "toolUse" | "length" | "error";
  errorMessage?: string;
  preview?: string;
}

export type ScriptedTurn = (
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
) => ScriptedResponse | Promise<ScriptedResponse>;

export function reply(text: string): ScriptedResponse {
  return { content: [{ type: "text", text }] };
}

export function recallCall(query: string, argumentsOverride: Record<string, unknown> = {}): ScriptedResponse {
  return {
    content: [{ type: "toolCall", id: "recall-1", name: "recall", arguments: { query, ...argumentsOverride } }],
    stopReason: "toolUse",
  };
}

/** Scripted responses enter Pi's real streaming boundary, never a second agent loop. */
export function createScriptedRuntime(turns: ScriptedTurn[]): {
  runtime: PiModelRuntime;
  requests: TranscriptContext[];
} {
  const requests: TranscriptContext[] = [];
  const model: PiModelRuntime["model"] = {
    id: "scripted-npc",
    name: "Scripted NPC (mechanism verification only)",
    api: "openai-completions",
    provider: "newworld-scripted",
    baseUrl: "http://unused.invalid",
    input: ["text"],
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    requests,
    runtime: {
      model,
      streamSimple: (_model, context, options) => {
        const index = requests.length;
        requests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
        const stream = createAssistantMessageEventStream();
        const message = (response: ScriptedResponse): AssistantMessage => ({
          role: "assistant",
          content: response.content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: response.stopReason ?? "stop",
          ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
          timestamp: Date.now(),
        });
        void (async () => {
          try {
            const turn = turns[index];
            if (!turn) throw new Error("Unexpected model request #" + (index + 1));
            const response = await awaitWithSignal(options?.signal, async () => turn(context, options));
            const final = message(response);
            stream.push({ type: "start", partial: final });
            if (response.preview) {
              stream.push({ type: "text_delta", contentIndex: 0, delta: response.preview, partial: final });
            }
            if (final.stopReason === "error") {
              stream.push({ type: "error", reason: "error", error: final });
            } else {
              stream.push({ type: "done", reason: final.stopReason === "length" ? "length" : final.stopReason === "toolUse" ? "toolUse" : "stop", message: final });
            }
          } catch (error) {
            const final = message({
              content: [],
              stopReason: "error",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            if (options?.signal?.aborted) final.stopReason = "aborted";
            stream.push({ type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final });
          }
        })();
        return stream;
      },
    },
  };
}

export function scriptedScenarioRuntime(fixture: string): PiModelRuntime {
  if (fixture === "already-known") {
    return createScriptedRuntime([() => reply("昨晚我答应陈叔，把这份退烧药留给他的孩子，不能失信。")]).runtime;
  }
  if (fixture === "unknown") {
    return createScriptedRuntime([
      () => recallCall("留药"),
      () => reply("我一时想不起具体原因，也没查到相关记忆。请容我先核实一下。"),
    ]).runtime;
  }
  return createScriptedRuntime([
    () => recallCall("留药"),
    () => reply("昨晚我答应陈叔，把最后一份退烧药留给他的孩子。我得守信，咱们再看看其他办法。"),
  ]).runtime;
}
