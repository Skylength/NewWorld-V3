import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The model boundary is replaceable; Pi still owns the agent/tool loop. */
export interface PiModelRuntime {
  model: Model<Api>;
  streamSimple: StreamFn;
}

/** Follow Pi's stream error contract without contacting a provider. */
export function terminatedStream(model: Model<Api>, reason: "error" | "aborted", message: string) {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason,
    error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: reason, errorMessage: message, timestamp: Date.now(),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  return stream;
}
