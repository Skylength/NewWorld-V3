import type { ActorScope, MemoryHit, MemoryReader } from "../actors/types.js";

export interface MemoryEntry extends MemoryHit, ActorScope {
  keywords: string[];
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export class InMemoryMemoryReader implements MemoryReader {
  constructor(private readonly entries: readonly MemoryEntry[]) {}

  async recall(
    scope: ActorScope,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MemoryHit[]> {
    if (signal?.aborted) throw new Error("记忆查询已取消");

    const needle = normalize(query);
    if (needle.length === 0) return [];

    // 先用宿主绑定的世界与角色筛选，再做关键词匹配；绝不把其他范围的数据交给模型。
    const scoped = this.entries.filter(
      (entry) => entry.worldId === scope.worldId && entry.actorId === scope.actorId,
    );

    const matches = scoped
      .map((entry) => {
        const normalizedKeywords = entry.keywords.map(normalize);
        const normalizedText = normalize(entry.text);
        const score = normalizedKeywords.reduce((total, keyword) => {
          if (keyword === needle) return total + 3;
          if (keyword.includes(needle) || needle.includes(keyword)) return total + 2;
          if (normalizedText.includes(keyword) && needle.includes(keyword)) return total + 1;
          return total;
        }, normalizedText.includes(needle) ? 2 : 0);
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
      .slice(0, limit)
      .map(({ entry }) => ({ id: entry.id, text: entry.text }));

    if (signal?.aborted) throw new Error("记忆查询已取消");
    return matches;
  }
}
