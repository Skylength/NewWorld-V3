import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import type { ProfileChange } from "./types.js";
import { fields, identifier, integer, list, text } from "./validation.js";

export function parseProfileChanges(value: unknown): ProfileChange[] {
  if (value === undefined) return [];
  return list(value, 16, item => {
    const d = fields(item, ["npcId", "expectedRevision", "topic", "text", "sourceKind", "reference", "supersedesId"]);
    if (!["player_setting", "world_creation", "executed_event"].includes(String(d.sourceKind))) throw new Error("人物资料来源无效");
    return {
      npcId: identifier(d.npcId), expectedRevision: integer(d.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
      topic: text(d.topic, 60), text: text(d.text, 600), sourceKind: d.sourceKind as ProfileChange["sourceKind"],
      reference: text(d.reference, 2000), supersedesId: d.supersedesId === null ? null : text(d.supersedesId, 80),
    };
  });
}

/** Apply a whole batch atomically; facts are private until an actual disclosure. */
export function applyProfileChanges(world: ExplorationWorld, changes: ProfileChange[], turnId: string, action: string): void {
  const actors = world.npc?.actors ?? [];
  const staged = new Map<string, NonNullable<(typeof actors)[number]["profile"]>>();
  const baseVersions = new Map(actors.map(n => [n.id, n.profile?.revision ?? 0]));
  for (const change of changes) {
    const npc = actors.find(n => n.id === change.npcId);
    if (!npc) throw new Error("待更新人物不存在");
    if (change.expectedRevision !== baseVersions.get(npc.id)) throw new Error("人物资料版本已变化");
    if (change.sourceKind === "player_setting" && !action.includes(change.reference)) throw new Error("人物设定必须引用玩家原输入");
    if (change.sourceKind === "world_creation" && change.reference !== "current_turn") throw new Error("创作资料必须引用当前回合");
    if (change.sourceKind === "executed_event") {
      const event = world.npc?.events.find(e => e.id === change.reference);
      if (!event || event.kind !== "action" || !event.witnesses.includes(npc.id)) throw new Error("人物资料必须引用本人接触的执行事件，不能把自述当事实");
    }
    const profile = staged.get(npc.id) ?? structuredClone(npc.profile ?? { revision: 0, facts: [] });
    staged.set(npc.id, profile);
    const previous = change.supersedesId === null ? undefined : profile.facts.find(f => f.id === change.supersedesId && f.status === "active");
    if (change.supersedesId !== null && (!previous || previous.topic !== change.topic)) throw new Error("被修订资料不存在、已失效或主题不一致");
    if (previous && change.sourceKind === "world_creation") throw new Error("普通创作不能覆盖已成立的人物资料");
    const active = profile.facts.filter(f => f.status === "active" && f.topic === change.topic);
    if (active.some(f => f.text === change.text)) continue;
    if (active.length && !previous) throw new Error("同一主题已有资料，请明确修订，不能追加矛盾版本");
    if (previous) previous.status = "superseded";
    profile.facts.push({ id: randomUUID(), topic: change.topic, text: change.text,
      source: { kind: change.sourceKind, turnId, reference: change.sourceKind === "world_creation" ? turnId : change.reference },
      supersedesId: previous?.id ?? null, status: "active" });
    profile.revision++;
  }
  for (const [id, profile] of staged) actors.find(n => n.id === id)!.profile = profile;
}

export const profileInstructions = `
【明确设定写回】本轮玩家明确要求补充/确定人物背景、经历或性格时，先对照已有persona与有效profile事实：已有相同内容不重复；尚未保存且不冲突的新设定必须写入profileChanges，不能只在对白或narration中遵守却省略持久更新。每个独立主题分别记录，并用player_setting引用本轮创作原文。姓名/公开简介仍使用identityChanges。不要把问话或传闻识别为明确设定。
【人物资料增量】可额外输出profileChanges数组，没有变化用[]。每项严格包含npcId、expectedRevision、topic、text、sourceKind、reference、supersedesId。
只补充明确成立的人物资料，不重造人物，不把一次情绪或角色自述当客观人设。topic是稳定且具体的资料主题，text最多600字。
sourceKind=player_setting时reference逐字引用本轮玩家明确的创作设定；普通问话、人物说话和假设不能充当设定。
sourceKind=world_creation仅补未确定内容，reference固定current_turn；executed_event仅引用实际存在的本人行动经历ID，不猜ID。
expectedRevision使用人物目录的profileRevision，新人物为0。同批同人物用同一个初始版本。
supersedesId通常为null；同主题已有资料时须引用目录中的原事实ID，且必须有明确设定修订或实际变化依据，不能用普通续写覆盖。
这些档案是人物自有资料；来源中的玩家创作备注不是她听见的台词，新增秘密不能直接写进公开观察或正文。
`;
