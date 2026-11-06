import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import type { PiModelRuntime } from "../agent/runtime.js";
import type { CapabilityRegistry } from "./capabilities.js";
import { actor, state } from "./state.js";
import { commitDecision, nextDue, pendingActor, settleDue } from "./engine.js";
import { runDecision } from "./decision.js";
import type { NpcRun } from "./types.js";

export interface NpcAdvanceBudget { decisions: number; perActor: Map<string, number> }

/** Each checkpoint is a complete snapshot. A failed inference leaves its input pending. */
export async function advanceNpcs(initial: ExplorationWorld, target: number, options: {
  registry: CapabilityRegistry;
  runtime: () => PiModelRuntime;
  signal: AbortSignal;
  persist: (world: ExplorationWorld) => void;
  redact: (text: string) => string;
  timeoutMs?: number;
  budget?: NpcAdvanceBudget;
}): Promise<{ world: ExplorationWorld; done: boolean }> {
  let world = structuredClone(initial);
  if (!Number.isSafeInteger(target) || target < world.timeMinutes || target - world.timeMinutes > 525600) throw new Error("时间推进范围无效");
  state(world).advance = { target, status: "running", reason: null };
  const budget = options.budget ?? { decisions: 0, perActor: new Map<string, number>() };
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 180000;
  const checkpoint = () => { world.revision++; options.persist(world); };
  const pause = (reason: string) => {
    state(world).advance = { target, status: "paused", reason }; checkpoint();
    return { world, done: false };
  };
  for (let step = 0; step < 100; step++) {
    if (options.signal.aborted) return pause("操作已取消，已提交的进度保留");
    if (performance.now() - started >= timeoutMs) return pause("整次推进达到时间预算，等待继续");
    settleDue(world, options.registry);
    const npc = pendingActor(world);
    if (npc) {
      if (budget.decisions >= 6 || (budget.perActor.get(npc.id) ?? 0) >= 2) return pause("达到本次决策预算，等待继续（最多6次激活，同一人物最多2次）");
      budget.decisions++; budget.perActor.set(npc.id, (budget.perActor.get(npc.id) ?? 0) + 1);
      const run: NpcRun = { id: randomUUID(), npcId: npc.id, time: world.timeMinutes, status: "running", requests: 0, tools: 0, inputTokens: null, outputTokens: null, context: "", raw: "", error: null };
      state(world).runs.push(run);
      state(world).runs = state(world).runs.slice(-100);
      checkpoint();
      try {
        const decision = await runDecision(world, npc.id, options.registry, options.runtime(), run, { signal: options.signal, timeoutMs: Math.min(60000, timeoutMs - (performance.now() - started)), onProgress: checkpoint });
        if (options.signal.aborted) throw new Error("操作取消");
        const next = structuredClone(world);
        commitDecision(next, npc.id, decision, options.registry);
        state(next).runs.find(r => r.id === run.id)!.status = "completed";
        world = next;
        checkpoint();
      } catch (error) {
        run.status = options.signal.aborted ? "cancelled" : "failed";
        run.error = options.redact(error instanceof Error ? error.message : String(error));
        run.raw = options.redact(run.raw);
        // No silent retries. The same pending observation survives for explicit continuation.
        return pause(run.error);
      }
      continue;
    }
    if (world.timeMinutes >= target) {
      state(world).advance = null; checkpoint(); return { world, done: true };
    }
    world.timeMinutes = nextDue(world, target);
    checkpoint();
  }
  return pause("达到100次程序推进上限，等待继续");
}

export function recoverNpcs(world: ExplorationWorld): void {
  const s = state(world);
  if (s.version !== 1 || !Array.isArray(s.actors) || !Array.isArray(s.events) || !Array.isArray(s.letters) || !Array.isArray(s.runs) || !Array.isArray(s.receipts)) throw new Error("NPC 存档结构或版本无效，原文件保留");
  if (new Set(s.actors.map(n => n.id)).size !== s.actors.length) throw new Error("NPC 存档包含重复身份");
  for (const npc of s.actors) {
    if (!["background", "agent"].includes(npc.mode) || !world.regions.some(r => r.id === npc.locationId) || !Array.isArray(npc.pending) || !Array.isArray(npc.experiences) || !Array.isArray(npc.contacts) || !Array.isArray(npc.knownLocations)) throw new Error("NPC 存档状态无效");
    if (npc.plan && (!Array.isArray(npc.plan.steps) || !Number.isInteger(npc.plan.index) || npc.plan.index < 0 || npc.plan.index > npc.plan.steps.length)) throw new Error("NPC 计划进度无效");
  }
  for (const run of s.runs) if (run.status === "running") {
    run.status = "failed"; run.error = "进程中断；已占请求保留，用量可能未知，未自动重试。";
  }
  if (s.advance) { s.advance.status = "paused"; s.advance.reason = "世界恢复到已保存时刻；点击继续完成未结束的推进。"; }
  // Referenced actors must survive recovery; do not guess replacement identities.
  for (const letter of s.letters) { actor(world, letter.fromId); if (letter.toId !== "player") actor(world, letter.toId); }
}
