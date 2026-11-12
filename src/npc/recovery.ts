import type { ExplorationWorld } from "../exploration/types.js";
import { integer, text } from "./validation.js";
import { usableSummary } from "../memory/summaries.js";

/** Validate additive character data before the service writes a recovered snapshot. */
export function validateCharacterRecords(world: ExplorationWorld): void {
  const s = world.npc;
  if (!s) return;
  const actorIds = new Set(["player", ...s.actors.map(n => n.id)]);
  const eventIds = new Set(s.events.map(e => e.id));
  for (const npc of s.actors) {
    if (npc.memorySummary && (!usableSummary(npc, npc.mode === "agent" ? "self" : "shared") || (npc.memorySummary.audience === "shared" && npc.memorySummary.evidenceIds.some(id => !s.events.some(e => e.id === id && e.witnesses.includes("player")))))) delete npc.memorySummary;
    if (npc.profile === undefined) continue;
    if (!npc.profile || !Array.isArray(npc.profile.facts)) throw new Error("人物档案结构无效");
    integer(npc.profile.revision, 0, Number.MAX_SAFE_INTEGER);
    const facts = new Map<string, typeof npc.profile.facts[number]>();
    const active = new Set<string>();
    for (const f of npc.profile.facts) {
      if (!f || !f.source || !["active", "superseded"].includes(f.status)) throw new Error("人物资料状态无效");
      text(f.id, 80); text(f.topic, 60); text(f.text, 600); text(f.source.turnId, 80); text(f.source.reference, 2000);
      if (facts.has(f.id) || (f.status === "active" && active.has(f.topic))) throw new Error("人物资料存在重复身份或有效主题");
      if (!["player_setting", "world_creation", "executed_event"].includes(f.source.kind)) throw new Error("人物资料来源无效");
      if (f.source.kind === "executed_event" && !npc.experiences.some(e => e.id === f.source.reference)) throw new Error("人物资料引用未知经历");
      if (f.supersedesId !== null) {
        const old = facts.get(f.supersedesId);
        if (!old || old.topic !== f.topic || old.status !== "superseded") throw new Error("人物资料修订链无效");
      }
      facts.set(f.id, f); if (f.status === "active") active.add(f.topic);
    }
  }
  if (s.commitments === undefined) return;
  if (!Array.isArray(s.commitments)) throw new Error("事项存档无效");
  const ids = new Set<string>();
  for (const c of s.commitments) {
    if (!c || ids.has(c.id)) throw new Error("事项身份无效或重复");
    text(c.id, 80); ids.add(c.id);
    if (c.history !== undefined && !Array.isArray(c.history)) throw new Error("事项历史无效");
    let revision = 0;
    for (const item of c.history ?? []) {
      if (!item || item.id !== c.id || item.ownerId !== c.ownerId || item.targetId !== c.targetId || item.revision <= revision || item.revision > c.revision) throw new Error("事项历史版本或身份无效");
      revision = item.revision;
    }
    for (const item of [c, ...(c.history ?? [])]) {
      integer(item.revision, 1, Number.MAX_SAFE_INTEGER); text(item.text, 600);
      if (!actorIds.has(item.ownerId) || !actorIds.has(item.targetId) || item.ownerId === item.targetId) throw new Error("事项参与者无效");
      if (item.dueAt !== null) integer(item.dueAt, 0, Number.MAX_SAFE_INTEGER);
      if (!["requested", "open", "fulfilled", "cancelled", "overdue"].includes(item.status)) throw new Error("事项状态无效");
      if (!Array.isArray(item.witnesses) || item.witnesses.some(id => !actorIds.has(id))) throw new Error("事项知情范围无效");
      if (!Array.isArray(item.sourceEventIds) || !item.sourceEventIds.length || !Array.isArray(item.resolutionEventIds) || [...item.sourceEventIds, ...item.resolutionEventIds].some(id => !eventIds.has(id))) throw new Error("事项引用不存在的事件");
      if (["fulfilled", "cancelled"].includes(item.status) && !item.resolutionEventIds.length) throw new Error("事项结束没有事件依据");
    }
  }
}
