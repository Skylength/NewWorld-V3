import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import type { Npc, NpcDecision } from "./types.js";
import { actor, emit, learnContacts, location, notify, speak, state } from "./state.js";
import type { CapabilityRegistry } from "./capabilities.js";

function stopPlan(world: ExplorationWorld, npc: Npc, error: unknown): void {
  if (!npc.plan) return;
  npc.plan.status = "interrupted";
  npc.plan.dueAt = null;
  npc.plan.error = error instanceof Error ? error.message : String(error);
  emit(world, npc.id, "action", "行动未完成：" + npc.plan.error, [npc.id]);
  npc.pending.push("行动受阻，需要重新选择");
}

/** A selected plan advances without inference until a new choice is required. */
export function executePlan(world: ExplorationWorld, npc: Npc, registry: CapabilityRegistry): void {
  const plan = npc.plan;
  if (!plan || plan.status !== "running") return;
  while (plan.index < plan.steps.length) {
    const step = plan.steps[plan.index]!;
    try {
      const capability = registry.get(step);
      if (plan.dueAt === null) {
        const duration = capability.duration({ world, npc }, step.args);
        if (!Number.isSafeInteger(duration) || duration < 0 || duration > 525600) throw new Error("能力耗时无效");
        plan.dueAt = world.timeMinutes + duration;
        emit(world, npc.id, "action", `开始活动：${plan.purpose}（步骤 ${plan.index + 1}/${plan.steps.length}）`, [npc.id]);
      }
      if (plan.dueAt > world.timeMinutes) return;
      // Conditions are rechecked against the current shared world, not the original decision.
      capability.duration({ world, npc }, step.args);
      capability.execute({ world, npc }, step.args);
      plan.index++; plan.dueAt = null;
    } catch (error) { stopPlan(world, npc, error); return; }
  }
  plan.status = "completed";
  // Respect an explicit later check-in; completing an immediate send must not force another inference.
  if (npc.wakeAt === null) npc.pending.push("当前方案已经完成，需要安排接下来做什么");
}

export function commitDecision(world: ExplorationWorld, id: string, decision: NpcDecision, registry: CapabilityRegistry): void {
  const npc = actor(world, id);
  if (npc.mode !== "agent") throw new Error("普通人物不能运行独立 Agent");
  const known = new Set(npc.experiences.map(e => e.id));
  for (const b of [...decision.beliefs, ...decision.relations]) {
    if (!b.evidenceIds.length || b.evidenceIds.some(e => !known.has(e))) throw new Error("认知修订必须引用自己的真实经历");
  }
  for (const r of decision.relations) {
    if (r.targetId === id || !npc.contacts.some(c => c.id === r.targetId)) throw new Error("不能修改未知对象的关系");
  }
  if (new Set(decision.relations.map(r => r.targetId)).size !== decision.relations.length) throw new Error("同轮不能重复修订同一关系");
  for (const step of decision.plan?.steps ?? []) registry.get(step);
  // Validate communication before applying private revisions; host also commits a clone atomically.
  if (decision.speech && location(world, decision.speech.targetId) !== npc.locationId) throw new Error("对白对象不在场，请使用通信能力");
  npc.pending = [];
  npc.beliefs = [...npc.beliefs, ...decision.beliefs].slice(-40);
  for (const relation of decision.relations) {
    npc.relations = npc.relations.filter(r => r.targetId !== relation.targetId);
    npc.relations.push(relation);
  }
  if (decision.goals !== null) npc.goals = decision.goals;
  npc.wakeAt = decision.wakeAfterMinutes === null ? null : world.timeMinutes + decision.wakeAfterMinutes;
  if (decision.planDisposition !== "keep" && npc.plan?.status === "running") {
    npc.plan.status = "cancelled";
    emit(world, id, "action", "放弃原方案，已发生的步骤与消耗保留。", [id]);
  }
  if (decision.planDisposition === "cancel") npc.plan = null;
  if (decision.plan) {
    npc.plan = { ...decision.plan, id: randomUUID(), index: 0, status: "running", startedAt: world.timeMinutes, dueAt: null, error: null };
  }
  if (decision.speech) speak(world, id, decision.speech.targetId, decision.speech.text);
  executePlan(world, npc, registry);
}

export function settleDue(world: ExplorationWorld, registry: CapabilityRegistry): void {
  for (const npc of state(world).actors) {
    learnContacts(world, npc);
    if (npc.mode !== "agent") continue;
    executePlan(world, npc, registry);
    if (npc.wakeAt !== null && npc.wakeAt <= world.timeMinutes) {
      npc.wakeAt = null;
      if (!npc.pending.includes("预约的思考时刻已到")) npc.pending.push("预约的思考时刻已到");
    }
  }
  for (const letter of state(world).letters) {
    if (letter.status !== "in_transit" || letter.dueAt > world.timeMinutes) continue;
    if (location(world, letter.toId) !== letter.address) {
      letter.status = "failed";
      emit(world, letter.fromId, "action", `发往${letter.toId}的消息未送达：收件人不在已知地址。`, [letter.fromId]);
      notify(world, letter.fromId, "消息未送达，需要考虑后续安排");
      continue;
    }
    letter.status = "delivered";
    emit(world, letter.fromId, "message", `${letter.channel === "letter" ? "来信" : "传音"}（${actor(world, letter.fromId).name}）：${letter.text}`, [letter.toId]);
    emit(world, letter.fromId, "action", `消息已送达${letter.toId}。`, [letter.fromId]);
    notify(world, letter.toId, "收到新的通信，请自行判断");
  }
}

export function nextDue(world: ExplorationWorld, target: number): number {
  const times = state(world).actors.flatMap(n => n.mode === "agent" ? [n.wakeAt, n.plan?.status === "running" ? n.plan.dueAt : null] : []);
  times.push(...state(world).letters.filter(l => l.status === "in_transit").map(l => l.dueAt));
  return Math.min(target, ...times.filter((t): t is number => t !== null && t !== undefined && t > world.timeMinutes));
}

export function pendingActor(world: ExplorationWorld): Npc | undefined {
  return state(world).actors.find(n => n.mode === "agent" && n.pending.length > 0);
}
