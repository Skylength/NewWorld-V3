import type { ExplorationWorld } from "../exploration/types.js";
import type { WorldTurnDraft } from "../exploration/types.js";
import { randomUUID } from "node:crypto";
import { fields, identifier, integer, list, text } from "./validation.js";

export interface IdentityChange {
  description?: string;
  npcId: string;
  expectedRevision: number;
  name: string | null;
  alias: string | null;
  scopeId: string;
  sourceKind: "player_setting" | "speech";
  sourceText: string;
}

/** Model IDs for new characters are local references; the host owns durable IDs. */
export function bindCreatedCharacters(world: ExplorationWorld, supplied: WorldTurnDraft): WorldTurnDraft {
  const draft = structuredClone(supplied);
  const ids = new Map<string, string>();
  for (const seed of draft.createNpcs ?? []) {
    if (ids.has(seed.id) || world.npc?.actors.some(n => n.id === seed.id)) throw new Error("新人物引用重复或已存在，请复用原人物");
    ids.set(seed.id, "npc_" + randomUUID().replaceAll("-", ""));
  }
  const bind = (id: string) => ids.get(id) ?? id;
  for (const seed of draft.createNpcs ?? []) seed.id = bind(seed.id);
  for (const c of draft.profileChanges ?? []) c.npcId = bind(c.npcId);
  for (const c of draft.identityChanges ?? []) c.npcId = bind(c.npcId);
  for (const c of draft.commitments ?? []) { c.ownerId = bind(c.ownerId); c.targetId = bind(c.targetId); }
  for (const c of draft.portrayalChanges ?? []) {
    c.npcId = bind(c.npcId);
    for (const r of c.relations) r.targetId = bind(r.targetId);
  }
  for (const c of draft.director?.interactions ?? []) c.targetId = bind(c.targetId);
  for (const c of draft.director?.speeches ?? []) { c.speakerId = bind(c.speakerId); c.targetId = bind(c.targetId); }
  return draft;
}

export function parseIdentityChanges(value: unknown): IdentityChange[] {
  if (value === undefined) return [];
  return list(value, 8, item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("身份更新必须为对象");
    const { description, ...base } = item as Record<string, unknown>;
    const d = fields(base, ["npcId", "expectedRevision", "name", "alias", "scopeId", "sourceKind", "sourceText"]);
    if (d.sourceKind !== "player_setting" && d.sourceKind !== "speech") throw new Error("身份补充来源无效");
    if (d.name === null && d.alias === null && description === undefined) throw new Error("身份补充至少包含姓名、称呼或公开简介");
    return { npcId: identifier(d.npcId), expectedRevision: integer(d.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
      ...(description === undefined ? {} : { description: text(description, 600) }),
      name: d.name === null ? null : text(d.name, 80), alias: d.alias === null ? null : text(d.alias, 80),
      scopeId: identifier(d.scopeId), sourceKind: d.sourceKind, sourceText: text(d.sourceText, 2000) };
  });
}

/** Name revelation changes the display identity, never the character ID or history. */
export function applyIdentityChanges(world: ExplorationWorld, changes: IdentityChange[], turnId: string, action: string): void {
  const actors = world.npc?.actors ?? [];
  const staged = new Map<string, typeof actors[number]>();
  for (const c of changes) {
    if (staged.has(c.npcId)) throw new Error("同轮不能重复修改同一人物身份");
    const original = actors.find(n => n.id === c.npcId);
    if (!original || (original.identityRevision ?? 0) !== c.expectedRevision) throw new Error("人物不存在或身份版本已变化");
    if (!world.regions.some(r => r.id === c.scopeId) || !original.knownLocations.includes(c.scopeId)) throw new Error("称呼作用域必须是人物已知地点");
    const values = [c.name, c.alias].filter((s): s is string => s !== null);
    if (values.some(s => !c.sourceText.includes(s))) throw new Error("姓名和称呼必须出现在来源原文中");
    let reference = c.sourceText;
    if (c.sourceKind === "player_setting") {
      if (!action.includes(c.sourceText)) throw new Error("身份设定必须引用玩家原输入");
    } else {
      const event = [...(world.npc?.events ?? [])].reverse().find(e => e.actorId === c.npcId && e.speech?.text.includes(c.sourceText) && e.witnesses.includes("player"));
      if (!event) throw new Error("公开姓名必须引用该人物实际说出且玩家听见的原话");
      reference = event.id;
      if (c.name !== null && original.nameKnown !== false && original.name !== c.name) throw new Error("已有姓名不能仅凭新的自述被覆盖");
    }
    const next = structuredClone(original);
    next.aliases ??= [{ text: original.name, scopeId: original.locationId }];
    for (const value of values) {
      if (!next.aliases.some(a => a.text === value && a.scopeId === c.scopeId)) next.aliases.push({ text: value, scopeId: c.scopeId });
    }
    if (c.name !== null) { next.name = c.name; next.nameKnown = true; }
    if (c.description !== undefined) next.description = c.description;
    next.identityRevision = c.expectedRevision + 1;
    (next.identityHistory ??= []).push({ turnId, previousName: original.name, name: next.name, previousDescription: original.description, description: next.description, sourceKind: c.sourceKind, reference });
    staged.set(c.npcId, next);
  }
  for (const [id, next] of staged) Object.assign(actors.find(n => n.id === id)!, next);
}

export const identityInstructions = `
【身份延续】先按人物目录的ID、称呼及其scopeId复用同一人物，不能为换称呼而重新创建。同名或同地本身不证明同一身份；不同归属的同职务人物可以并存，需结合归属、简介与交往记录识别。多个候选不明确时自然澄清，不默认造人。
新增人物的description只记录公开外观与身份，不写“真名尚未介绍”等会变化的知情状态，该状态由nameKnown维护。identityChanges可额外带description，在公开姓名/称呼补充时同步整理简介：保留有效的已公开特征，移除过时身份描述，不新增秘密或未发生行动。目录nameKnown优先于旧简介中的姓名未知措辞。
可输出identityChanges数组：每项严格为{npcId,expectedRevision,name,alias,scopeId,sourceKind,sourceText}。name/alias不修改时为null；expectedRevision取identityRevision（新人物0），每人每轮最多一项。
description为可选补充字段，可以仅修改description并将name/alias都设null。玩家明确要求整理公开简介时，必须在identityChanges中保存新description并引用这段设定；不能只在叙述里承认、却保留旧简介。这里只更新公开资料，私人性格/背景仍走profileChanges。
这用于公开姓名或称呼的补充。sourceKind=player_setting须逐字引用玩家明确指定公开称呼/姓名的原输入；隐秘真名只存私有profileChanges，不在这里公开。普通问句不构成设定。
sourceKind=speech须逐字引用该人物实际向玩家公开说出的原话（可来自本轮普通人物speeches），不能预写独立人物未说的介绍。姓名/别称必须出现在原话中，scopeId是人物已知地点。已有明确姓名不因一句矛盾自述重写。
`;
