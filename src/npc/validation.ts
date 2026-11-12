import { parseCommitmentChanges } from "./commitments.js";
import type { ActionStep, Belief, NpcDecision, NpcSeed, Relation } from "./types.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
  return value as Record<string, unknown>;
}
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const data = record(value);
  if (Object.keys(data).some(k => !allowed.includes(k)) || allowed.some(k => !Object.hasOwn(data, k))) throw new Error("NPC 协议字段缺少或包含未知字段");
  return data;
}
export function text(value: unknown, max = 600): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`文本需要 1–${max} 字符`);
  return value.trim();
}
export function identifier(value: unknown): string {
  const result = text(value, 80);
  if (!/^[a-z][a-z0-9_-]*$/.test(result) || ["__proto__", "constructor", "prototype"].includes(result)) throw new Error("NPC 标识无效");
  return result;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`数值需要 ${min}–${max} 的整数`);
  return value;
}
export function list<T>(value: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`数组最多 ${max} 项`);
  return value.map(parse);
}
export function parseSeed(value: unknown): NpcSeed {
  const raw = record(value);
  const { description = "", persona = "", goals = [], displayLabel, nameKnown, appearance, ...required } = raw;
  const d = fields(required, ["id", "name", "locationId"]);
  const id = identifier(d.id);
  if (id === "player") throw new Error("人物不能使用玩家 ID");
  if (appearance !== undefined && appearance !== "start" && appearance !== "arrival") throw new Error("人物出现阶段无效");
  if (nameKnown !== undefined && typeof nameKnown !== "boolean") throw new Error("nameKnown 必须为布尔值");
  if (d.name === null && nameKnown === true) throw new Error("未知姓名不能标记为已知");
  if (displayLabel !== undefined) text(displayLabel, 80);
  const optionalText = (v: unknown, max: number) => v === "" || v === null ? "" : text(v, max);
  return { id, name: d.name === null ? text(displayLabel, 80) : text(d.name, 80), nameKnown: d.name !== null && nameKnown !== false,
    ...(appearance === undefined ? {} : { appearance }),
    description: optionalText(description, 600), persona: optionalText(persona, 1200),
    goals: list(goals, 5, v => text(v, 200)), locationId: identifier(d.locationId) };
}
export function belief(value: unknown): Belief {
  const d = fields(value, ["text", "evidenceIds"]);
  return { text: text(d.text), evidenceIds: list(d.evidenceIds, 8, v => text(v, 80)) };
}
export function relation(value: unknown): Relation {
  const d = fields(value, ["targetId", "text", "evidenceIds", "affinity", "trust", "respect", "fear", "ties"]);
  return { targetId: identifier(d.targetId), text: text(d.text), evidenceIds: list(d.evidenceIds, 8, v => text(v, 80)), affinity: integer(d.affinity, -100, 100), trust: integer(d.trust, -100, 100), respect: integer(d.respect, -100, 100), fear: integer(d.fear, 0, 100), ties: list(d.ties, 8, v => text(v, 200)) };
}
function step(value: unknown): ActionStep {
  const d = fields(value, ["capability", "version", "args"]);
  return { capability: identifier(d.capability), version: integer(d.version, 1, 100), args: record(d.args) };
}
export function parseDecision(raw: string): NpcDecision {
  if (raw.length > 24_000) throw new Error("NPC 决策过大");
  const { commitments, ...base } = record(JSON.parse(raw));
  const d = fields(base, ["speech", "beliefs", "relations", "goals", "plan", "planDisposition", "wakeAfterMinutes"]);
  if (!["keep", "replace", "cancel"].includes(String(d.planDisposition))) throw new Error("无效计划处置");
  const speech = d.speech === null ? null : fields(d.speech, ["targetId", "text"]);
  const plan = d.plan === null ? null : fields(d.plan, ["purpose", "steps", "interruptOnMessage"]);
  if (plan && typeof plan.interruptOnMessage !== "boolean") throw new Error("interruptOnMessage 必须是布尔值");
  if ((d.planDisposition === "replace") !== Boolean(plan)) throw new Error("替换计划需要新方案，其他处置不能提供方案");
  const steps = plan ? list(plan.steps, 5, step) : [];
  if (plan && !steps.length) throw new Error("方案至少包含一个步骤");
  return {
    commitments: parseCommitmentChanges(commitments),
    speech: speech ? { targetId: identifier(speech.targetId), text: text(speech.text, 1800) } : null,
    beliefs: list(d.beliefs, 4, belief), relations: list(d.relations, 4, relation),
    goals: d.goals === null ? null : list(d.goals, 5, v => text(v, 200)),
    plan: plan ? { purpose: text(plan.purpose, 300), steps, interruptOnMessage: plan.interruptOnMessage as boolean } : null,
    planDisposition: d.planDisposition as NpcDecision["planDisposition"],
    wakeAfterMinutes: d.wakeAfterMinutes === null ? null : integer(d.wakeAfterMinutes, 1, 525600),
  };
}
