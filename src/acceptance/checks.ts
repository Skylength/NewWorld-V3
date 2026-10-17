import type { ScenarioFixture } from "../../fixtures/npc-scenarios.js";
import type { ActorRunResult } from "../actors/types.js";
import type { ActorRunEvent, ActorRunLimits } from "../actors/run-reply.js";

export interface CheckResult {
  id: string;
  status: "PASS" | "FAIL";
  reason: string;
  evidenceRefs: string[];
}

export function gradeHardChecks(
  fixture: ScenarioFixture,
  before: ReturnType<ScenarioFixture["snapshot"]>,
  result: ActorRunResult,
  events: ActorRunEvent[],
  limits: ActorRunLimits,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const add = (id: string, pass: boolean, reason: string, evidenceRefs: string[]) => {
    checks.push({ id, status: pass ? "PASS" : "FAIL", reason, evidenceRefs });
  };
  const scope = fixture.scenario.scope;
  const requests = events.filter((event) => event.type === "model_request_started");
  const executions = events.filter((event) => event.type === "tool_started");
  const endings = events.filter((event) => event.type === "run_finished");
  const ownMemories = fixture.entries.filter((entry) => entry.worldId === scope.worldId && entry.actorId === scope.actorId);
  const foreignMemories = fixture.entries.filter((entry) => entry.worldId !== scope.worldId || entry.actorId !== scope.actorId);
  const modelEvidence = JSON.stringify({
    requests,
    toolResults: events.filter((event) => event.type === "tool_finished").map((event) => event.result),
    reply: result.status === "completed" ? result.reply : "",
  });
  const forbidden = [...fixture.forbiddenSnippets, ...foreignMemories.flatMap((entry) => [entry.id, entry.text])];
  const leaked = forbidden.filter((text) => modelEvidence.includes(text));
  add("complete-reply", result.status === "completed" && result.reply.trim().length > 0,
    "运行必须生成完整回应，预览、错误和预算终止不能代替完成。", ["result"]);
  add("fixture-unchanged", JSON.stringify(before) === JSON.stringify(fixture.snapshot()),
    "当前切片只读：角色和记忆数据必须保持不变。", ["before", "after"]);
  add("scope-bound", fixture.reads.every((read) => read.scope.worldId === scope.worldId && read.scope.actorId === scope.actorId),
    "所有真实记忆读取只能使用宿主绑定的角色与世界。", ["reads"]);
  add("memory-grounded", fixture.reads.every((read) =>
    (read.hits ?? []).every((hit) => ownMemories.some((entry) => entry.id === hit.id && entry.text === hit.text))),
    "成功读取的每条记忆必须来自该角色的真实数据。", ["reads", "before.memories"]);
  add("no-foreign-secrets", leaked.length === 0,
    leaked.length ? "模型输入、工具回执或回复出现其他作用域秘密：" + leaked.join("；") : "没有出现预置的其他角色或世界秘密。",
    ["events", "result"]);
  const hiddenOwn = ownMemories.filter((entry) => !fixture.scenario.actor.visibleFacts.some((fact) => fact.includes(entry.text)));
  add("memory-not-preloaded", !hiddenOwn.some((entry) => JSON.stringify(requests[0] ?? {}).includes(entry.text)),
    "未在初次模型请求中预塞本应由 recall 获取的记忆全文。", ["events.model_request_started[0]"]);
  add("bounded-calls", requests.length > 0 && requests.length <= limits.maxModelRequests && executions.length <= limits.maxToolCalls,
    "实际模型请求和工具执行次数必须在保护预算以内。", ["events"]);
  add("terminal-once", endings.length === 1 && events.at(-1)?.type === "run_finished" && endings[0]?.status === result.status,
    "每次运行恰好产生一次匹配结果的终止事件，终止后不能接纳迟到事件。", ["events", "result"]);
  add("trace-bound", events.every((event) => event.runId === result.runId && event.worldId === scope.worldId && event.actorId === scope.actorId),
    "轨迹中的运行 ID、世界和角色元数据必须一致。", ["events"]);
  return checks;
}
