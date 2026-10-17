import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ActorScope, MemoryReader } from "../actors/types.js";
import { awaitWithSignal } from "../agent/abort.js";

const RecallParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200, description: "用于查找你自己相关记忆的简短关键词或问题" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "最多返回几条，默认 3" })),
}, { additionalProperties: false });

function parseRecallArguments(args: unknown): { query: string; limit: number } {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("recall 参数必须是对象");
  const values = args as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "query" && key !== "limit")) {
    throw new Error("recall 只接受 query 和 limit，不允许选择角色或世界");
  }
  if (typeof values.query !== "string") throw new Error("query 必须是字符串");
  const query = values.query.trim();
  if (!query.length || query.length > 200) throw new Error("query 必须是 1 到 200 个字符的非空查询");
  const limit = values.limit === undefined ? 3 : values.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("limit 必须是 1 到 5 之间的整数");
  }
  return { query, limit };
}

export function createRecallTool(
  scope: ActorScope,
  memoryReader: MemoryReader,
  onStarted?: (call: { query: string; limit: number }) => void,
): AgentTool<typeof RecallParameters> {
  const boundScope = Object.freeze({ worldId: scope.worldId, actorId: scope.actorId });
  return {
    name: "recall",
    label: "查询自己的记忆",
    description: "只读查询你自己与当前处境相关的私人记忆。可能没有命中；不要假设一定存在答案。",
    parameters: RecallParameters,
    // Validate raw values before Pi's schema conversion can coerce them.
    prepareArguments: parseRecallArguments,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const { query, limit } = parseRecallArguments(params);

      onStarted?.({ query, limit });
      const hits = await awaitWithSignal(signal, () => memoryReader.recall(boundScope, query, limit, signal));
      return {
        content: [{ type: "text", text: JSON.stringify({ hits }, null, 2) }],
        details: { query, limit, hitCount: hits.length },
      };
    },
  };
}
