import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { PiModelRuntime } from "./runtime.js";

export interface ModelConfig {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export function createPiModel(config: ModelConfig): PiModelRuntime {
  const providerId = "newworld-openai-compatible";
  const baseUrl = (config.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const auth: ApiKeyAuth = {
    name: "NewWorld LLM API key",
    check: async () => config.apiKey ? { type: "api_key", source: "LLM_API_KEY" } : undefined,
    resolve: async () => config.apiKey
      ? { auth: { apiKey: config.apiKey }, source: "LLM_API_KEY" }
      : undefined,
  };
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    // The generic compatible endpoint has no catalog metadata; keep conservative defaults.
    contextWindow: config.contextWindow ?? 32_000,
    maxTokens: config.maxTokens ?? 4_096,
  };

  const models = createModels();
  models.setProvider(createProvider({
    id: providerId,
    name: "NewWorld OpenAI-compatible endpoint",
    baseUrl,
    auth: { apiKey: auth },
    models: [model],
    api: openAICompletionsApi(),
  }));

  const registeredModel = models.getModel(providerId, model.id);
  if (!registeredModel) throw new Error("Pi 未能注册模型：" + model.id);

  return {
    model: registeredModel as Model<"openai-completions">,
    streamSimple: models.streamSimple.bind(models),
  };
}
