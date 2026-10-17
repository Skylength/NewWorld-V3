import type { ModelConfig } from "./model.js";

export const DEFAULT_TEXT_MODEL = "gpt-6.1-sol";
export const DEFAULT_STRUCTURE_MODEL = "gpt-6-luna";

/** Shared endpoint/credentials, separate model roles. Explicit role variables override defaults. */
export function resolveModelRoutes(env: Record<string, string | undefined> = process.env): {
  text: ModelConfig | undefined;
  structure: ModelConfig | undefined;
  judge: ModelConfig | undefined;
} {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const textId = env.LLM_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
  const structureId = env.LLM_STRUCTURE_MODEL?.trim() || DEFAULT_STRUCTURE_MODEL;
  const shared = apiKey ? { apiKey, ...(baseUrl ? { baseUrl } : {}) } : undefined;
  const judgeKey = env.ACCEPTANCE_JUDGE_API_KEY?.trim() || apiKey;
  const judgeBase = env.ACCEPTANCE_JUDGE_BASE_URL?.trim() || baseUrl;
  return {
    text: shared ? { ...shared, modelId: textId } : undefined,
    structure: shared ? { ...shared, modelId: structureId } : undefined,
    judge: judgeKey ? { apiKey: judgeKey, modelId: env.ACCEPTANCE_JUDGE_MODEL?.trim() || structureId, ...(judgeBase ? { baseUrl: judgeBase } : {}) } : undefined,
  };
}
