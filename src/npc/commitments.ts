import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import { fields, identifier, integer, list, text } from "./validation.js";

export interface Commitment {
  history?: Omit<Commitment, "history">[];
  id: string; revision: number; ownerId: string; targetId: string; text: string;
  dueAt: number | null; status: "requested" | "open" | "fulfilled" | "cancelled" | "overdue";
  sourceEventIds: string[]; resolutionEventIds: string[]; witnesses: string[];
}
export interface CommitmentChange {
  id: string | null; expectedRevision: number; ownerId: string; targetId: string; text: string;
  dueAt: number | null; status: "requested" | "open" | "fulfilled" | "cancelled";
  sourceText: string; eventId: string | null;
}
export function parseCommitmentChanges(value: unknown): CommitmentChange[] {
  if (value === undefined) return [];
  return list(value, 8, item => {
    const d = fields(item, ["id", "expectedRevision", "ownerId", "targetId", "text", "dueAt", "status", "sourceText", "eventId"]);
    if (!["requested", "open", "fulfilled", "cancelled"].includes(String(d.status))) throw new Error("事项状态无效");
    return { id: d.id === null ? null : text(d.id, 80), expectedRevision: integer(d.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
      ownerId: identifier(d.ownerId), targetId: identifier(d.targetId), text: text(d.text, 600),
      dueAt: d.dueAt === null ? null : integer(d.dueAt, 0, Number.MAX_SAFE_INTEGER), status: d.status as CommitmentChange["status"],
      sourceText: d.sourceText === "" ? "" : text(d.sourceText, 1800), eventId: d.eventId === null ? null : text(d.eventId, 80) };
  });
}

export function commitmentEvidence(world: ExplorationWorld, change: CommitmentChange) {
  const speaker = change.status === "requested" ? change.targetId : change.ownerId;
  return change.status === "fulfilled"
    ? world.npc?.events.find(e => e.id === change.eventId && e.actorId === change.ownerId && e.completedAction)
    : [...(world.npc?.events ?? [])].reverse().find(e => e.actorId === speaker && e.speech?.targetId === (speaker === change.ownerId ? change.targetId : change.ownerId) && change.sourceText.trim() && e.speech.text.includes(change.sourceText));
}

export function applyCommitmentChanges(world: ExplorationWorld, changes: CommitmentChange[], decidingActor?: string): void {
  const s = world.npc;
  if (!s || !changes.length) return;
  const next = structuredClone(s.commitments ?? []);
  const seen = new Set<string>();
  for (const c of changes) {
    if (c.ownerId === c.targetId || [c.ownerId, c.targetId].some(id => id !== "player" && !s.actors.some(n => n.id === id))) throw new Error("事项人物无效");
    const old = c.id === null ? undefined : next.find(x => x.id === c.id);
    if (c.id !== null && (!old || seen.has(c.id))) throw new Error("事项不存在或同轮重复修改");
    if (c.id) seen.add(c.id);
    if (c.expectedRevision !== (old?.revision ?? 0)) throw new Error("事项版本变化");
    if (old && (old.ownerId !== c.ownerId || old.targetId !== c.targetId || ["fulfilled", "cancelled"].includes(old.status))) throw new Error("不能改换事项人物或重写已结束事项");
    if (!old && !["requested", "open"].includes(c.status)) throw new Error("新事项必须是请求或承诺");
    if (old?.status !== "requested" && old && c.status === "requested") throw new Error("承诺不能退回请求");
    if (c.status !== "fulfilled" && !c.sourceText.trim()) throw new Error("事项必须提供对白原文片段");
    const speaker = c.status === "requested" ? c.targetId : c.ownerId;
    if (decidingActor && speaker !== decidingActor) throw new Error("只能提交本人表达的事项");
    const event = commitmentEvidence(world, c);
    if (!event) throw new Error("事项缺少本人真实发言或已完成行动依据");
    if (decidingActor && !event.witnesses.includes(decidingActor)) throw new Error("不能引用本人未接触的事件");
    if (c.status === "fulfilled" && (!old || old.status === "requested")) throw new Error("未接受请求不能直接当作承诺已履行");
    if (old && c.status === "fulfilled" && (old.text !== c.text || old.dueAt !== c.dueAt)) throw new Error("完成时不能改写原事项");
    const item: Commitment = old ?? { id: randomUUID(), revision: 0, ownerId: c.ownerId, targetId: c.targetId, text: c.text, dueAt: c.dueAt, status: c.status, sourceEventIds: [], resolutionEventIds: [], witnesses: [...event.witnesses] };
    if (old && !item.history) { const { history: _history, ...snapshot } = item; item.history = [structuredClone(snapshot)]; }
    item.revision++; item.text = c.text; item.dueAt = c.dueAt; item.status = c.status;
    item.witnesses = [...event.witnesses];
    if (["fulfilled", "cancelled"].includes(c.status)) item.resolutionEventIds.push(event.id);
    else if (!item.sourceEventIds.includes(event.id)) item.sourceEventIds.push(event.id);
    const { history: _history, ...snapshot } = item;
    (item.history ??= []).push(structuredClone(snapshot));
    if (!old) {
      if (next.some(x => x.ownerId === c.ownerId && x.targetId === c.targetId && x.sourceEventIds.includes(event.id) && x.text === c.text)) throw new Error("同一承诺已存在，请复用ID");
      next.push(item);
    }
  }
  s.commitments = next;
}

export function visibleCommitments(world: ExplorationWorld, viewer: string) {
  const knownEvents = new Set((world.npc?.events ?? []).filter(e => e.witnesses.includes(viewer)).map(e => e.id));
  return (world.npc?.commitments ?? []).flatMap(c => {
    const known = [...(c.history ?? [c])].reverse().find(h => h.witnesses.includes(viewer));
    if (!known) return [];
    const { history: _history, ...view } = known as Commitment;
    return [{ ...view, status: view.status === "open" && view.dueAt !== null && view.dueAt <= world.timeMinutes ? "overdue" as const : view.status,
      sourceEventIds: view.sourceEventIds.filter(id => knownEvents.has(id)), resolutionEventIds: view.resolutionEventIds.filter(id => knownEvents.has(id)) }];
  });
}

export const commitmentInstructions = `
【约定写回检查】先逐项检查已提供的requested/open/overdue事项，再生成本轮回应。本人答应取消/改期/接受请求时，必须在commitments输出同一事项id的状态更新，不能只在speeches或narration里表示已经取消/改期。取消使用status=cancelled，保留原ownerId、targetId、text、dueAt和当前revision，sourceText引用本人本轮同意取消的真实台词，eventId=null。若本人尚未同意，保持原状态，不替其取消。
世界时间以分钟计：1小时=60分钟，1时辰=120分钟，半个时辰=60分钟，1天=1440分钟；除非世界已明确另有规则。相对约定的dueAt从承诺实际说出时的世界时刻计算，不能把时辰按小时换算；校正已有约定应更新其ID，不另建副本。
可输出commitments数组维护请求和约定，每项严格包含id、expectedRevision、ownerId、targetId、text、dueAt、status、sourceText、eventId。
ownerId是被请求/承诺履行的人，targetId是另一方。新记录id=null/expectedRevision=0。status=requested必须引用targetId向ownerId提出的真实请求；open必须引用ownerId对targetId的真实承诺；只说了请求不能记为open。
sourceText逐字引用本人实际对白；fulfilled必须eventId引用ownerId已完成行动（completedAction=true），不能用“已经完成”的自述，也不能改变原text/dueAt；cancelled须引用本人取消对白。无动作依据不要标完成。
更新已有事项需其id和revision，不能改换双方。dueAt为明确的世界分钟，含糊“改日”为null。没有约定变化用[]，禁止凭空发明或重复登记。
`;
