import type { ExplorationWorld, ExplorationContext } from "../exploration/types.js";
import { createHash } from "node:crypto";
import type { Npc } from "../npc/types.js";
import { fields, list, text } from "../npc/validation.js";

export interface MemorySummary {
  audience: "self" | "shared"; signature: string; text: string;
  evidenceIds: string[]; throughExperienceCount: number;
}
export function summarySignature(npc: Npc): string {
  return createHash("sha256").update(JSON.stringify([npc.mode, npc.identityRevision ?? 0, npc.profile?.revision ?? 0, npc.beliefs, npc.relations])).digest("hex");
}
export function usableSummary(npc: Npc, audience: "self" | "shared"): MemorySummary | null {
  const s = npc.memorySummary;
  if (s && (typeof s.text !== "string" || s.text.length > 2400 || !Array.isArray(s.evidenceIds) || !s.evidenceIds.length || !Number.isSafeInteger(s.throughExperienceCount) || s.throughExperienceCount < 0 || s.throughExperienceCount > npc.experiences.length || !["self", "shared"].includes(s.audience))) return null;
  if (!s || s.signature !== summarySignature(npc) || (audience === "shared" && s.audience !== "shared")) return null;
  const ids = new Set(npc.experiences.map(e => e.id));
  return s.evidenceIds.every(id => ids.has(id)) ? s : null;
}
export function prepareSummary(world: ExplorationWorld) {
  const knownToPlayer = new Set((world.npc?.events ?? []).filter(e => e.witnesses.includes("player")).map(e => e.id));
  for (const id of world.npc?.playerAttention?.trackedCharacterIds ?? []) {
    const npc = world.npc?.actors.find(n => n.id === id);
    if (!npc) continue;
    const audience = npc.mode === "agent" ? "self" as const : "shared" as const;
    const experiences = audience === "self" ? npc.experiences : npc.experiences.filter(e => knownToPlayer.has(e.id));
    const signature = summarySignature(npc);
    const previous = usableSummary(npc, audience);
    const from = previous?.throughExperienceCount ?? 0;
    const pending = experiences.slice(from);
    if (pending.length < 20 && pending.reduce((n, e) => n + e.text.length, 0) < 6000) continue;
    if (npc.summaryAttempt?.signature === signature && experiences.length <= npc.summaryAttempt.experienceCount) continue;
    const selected = [];
    let chars = 0;
    for (const e of pending) {
      const size = JSON.stringify(e).length;
      if (chars + size > 8000) break;
      selected.push(e); chars += size;
    }
    if (!selected.length) continue;
    const systemPrompt = '整理人物已经接触的经历摘要。只概括材料，不补造人物设定、承诺履行或他人意愿。说过的话保留来源和不确定性。返回严格JSON：{"text":"最多2400字符的摘要","evidenceIds":["支撑摘要的实际经历ID"]}。可结合旧摘要，旧摘要是派生参考，不能改写原始事实。';
    const userPrompt = JSON.stringify({ previous: previous ? { text: previous.text, evidenceIds: previous.evidenceIds } : null, experiences: selected });
    if (userPrompt.length + systemPrompt.length > 12000) continue;
    const context: ExplorationContext = { systemPrompt, userPrompt, characters: systemPrompt.length + userPrompt.length, activeRegionIds: [], modules: [] };
    return { npcId: id, signature, audience, experienceCount: experiences.length, throughExperienceCount: from + selected.length,
      evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...selected.map(e => e.id)])], context };
  }
  return null;
}
export function parseSummary(raw: string, input: NonNullable<ReturnType<typeof prepareSummary>>): MemorySummary {
  const d = fields(JSON.parse(raw), ["text", "evidenceIds"]);
  const evidenceIds = list(d.evidenceIds, input.evidenceIds.length, value => text(value, 80));
  if (!evidenceIds.length || evidenceIds.some(id => !input.evidenceIds.includes(id))) throw new Error("摘要必须引用提供的原始经历");
  return { audience: input.audience, signature: input.signature, text: text(d.text, 2400), evidenceIds: [...new Set(evidenceIds)], throughExperienceCount: input.throughExperienceCount };
}
