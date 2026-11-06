/** Bounded lexical retrieval for Chinese and space-delimited text. No cross-actor storage. */
export function memoryTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase().slice(0, 4000);
  const terms = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length <= 16) terms.add(word);
      for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
    } else if (word.length > 1) terms.add(word);
  }
  return [...terms].filter(t => t.length > 1).slice(0, 256);
}

export function relevantMemories<T extends { text: string; time: number }>(items: readonly T[], query: string, limit: number): T[] {
  const terms = memoryTerms(query);
  return items.map((item, index) => {
    const text = item.text.normalize("NFKC").toLocaleLowerCase();
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? Math.min(term.length, 8) : 0), 0);
    return { item, index, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.item.time - a.item.time || b.index - a.index)
    .slice(0, limit).map(x => x.item);
}
