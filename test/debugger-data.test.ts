import assert from "node:assert/strict";
import test from "node:test";
import { buildExplorationContext } from "../src/exploration/context.js";
import { applyWorldTurn, createInitialWorld } from "../src/exploration/state.js";
import type { ExplorationContext, ExplorationModelCall, ExplorationRun, WorldTurnDraft } from "../src/exploration/types.js";
import { buildTimeline, compareContexts, contextBreakdown, deriveStages, filterRuns, runMetrics, runOutcome } from "../web/exploration/debug-data.js";

const startedAt = "2026-10-15T08:00:00.000Z";
const at = (milliseconds: number) => new Date(Date.parse(startedAt) + milliseconds).toISOString();
const usage = (totalTokens: number) => ({ input: totalTokens - 10, output: 10, totalTokens });
function context(): ExplorationContext {
  return buildExplorationContext(createInitialWorld("projection-world"), "观察山门");
}
function call(role: ExplorationModelCall["role"], overrides: Partial<ExplorationModelCall> = {}): ExplorationModelCall {
  return {
    role, model: role === "structure" ? "gpt-6-luna" : "gpt-6.1-sol", status: "completed",
    context: context(), rawResponse: "", modelRequests: 1, usage: null,
    startedAt: at(1000), finishedAt: at(4000), durationMs: 3000, error: null, ...overrides,
  };
}
function run(overrides: Partial<ExplorationRun> = {}): ExplorationRun {
  return {
    id: "run-1", worldId: "projection-world", action: "观察山门", baseRevision: 0,
    status: "completed", phase: "已保存", model: "gpt-6-luna → gpt-6.1-sol", startedAt,
    finishedAt: at(10000), durationMs: 10000, modelRequests: 2, context: context(),
    rawResponse: "", draft: null, changes: [], usage: null, error: null,
    stage: "done", calls: [call("structure"), call("text", { startedAt: at(5000), finishedAt: at(9000), durationMs: 4000 })],
    ...overrides,
  };
}
function draft(overrides: Partial<WorldTurnDraft> = {}): WorldTurnDraft {
  return { narration: "石阶旁添了一道刻痕。", elapsedMinutes: 1, destinationId: "gate", createRegions: [], enrichRegions: [], events: [], ...overrides };
}
const stageStatuses = (record: ExplorationRun) => Object.fromEntries(deriveStages(record).map(stage => [stage.id, stage.status]));

test("legacy single-call history does not invent a text call or fully instrumented validation", () => {
  const record = run({ model: "historical-single-model", modelRequests: 1 });
  delete record.calls;
  delete record.stage;
  const stages = deriveStages(record);
  assert.equal(stages.some(stage => stage.id === "text" || stage.id === "validation"), false);
  assert.deepEqual(stages.map(stage => stage.model).filter(Boolean), ["historical-single-model"]);
  assert.ok(stages.every(stage => stage.legacy && stage.durationMs === null));
  assert.equal(stages.find(stage => stage.id === "commit")?.status, "completed");
});

test("a known legacy failure or cancellation stays visible without inventing its internal failure stage", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const record = run({ status, modelRequests: 1 });
    delete record.calls;
    delete record.stage;
    assert.equal(deriveStages(record)[0]?.status, status);
    assert.equal(deriveStages(record).find(stage => stage.id === "commit")?.status, "pending");
  }
});

test("completed dual-route history exposes only measured model durations", () => {
  const stages = deriveStages(run());
  assert.deepEqual(stages.map(stage => stage.status), Array(5).fill("completed"));
  assert.deepEqual(stages.filter(stage => stage.call).map(stage => stage.model), ["gpt-6-luna", "gpt-6.1-sol"]);
  assert.equal(stages.find(stage => stage.id === "structure")?.durationMs, 3000);
  for (const id of ["context", "validation", "commit"]) assert.equal(stages.find(stage => stage.id === id)?.durationMs, null);
});

test("a model response completed before validation failed: the failed stage wins and later stages never completed", () => {
  const record = run({ status: "failed", stage: "validation", failureStage: "validation", calls: [call("structure")], modelRequests: 1 });
  assert.deepEqual(stageStatuses(record), { context: "completed", structure: "completed", validation: "failed", text: "pending", commit: "pending" });
});

test("invalid final prose fails the text stage even when the transport call completed", () => {
  const record = run({ status: "failed", stage: "text", failureStage: "text", error: "文本阶段返回了结构或代码" });
  assert.equal(record.calls![1]!.status, "completed");
  assert.equal(stageStatuses(record).text, "failed");
  assert.equal(stageStatuses(record).commit, "pending");
});

test("cancelled structural work does not light up validation, text, or commit", () => {
  const record = run({ status: "cancelled", stage: "structure", failureStage: "structure", calls: [call("structure", { status: "cancelled" })], modelRequests: 1 });
  assert.deepEqual(stageStatuses(record), { context: "completed", structure: "cancelled", validation: "pending", text: "pending", commit: "pending" });
});

test("waterfall preserves recorded start offsets and duration proportions, with an unattributed residual", () => {
  const record = run();
  const before = structuredClone(record);
  const timeline = buildTimeline(record);
  assert.equal(timeline.totalMs, 10000);
  assert.deepEqual(timeline.bars.map(bar => ({ start: bar.startMs, duration: bar.durationMs, left: bar.left, width: bar.width })), [
    { start: 1000, duration: 3000, left: 10, width: 30 },
    { start: 5000, duration: 4000, left: 50, width: 40 },
  ]);
  assert.equal(timeline.otherMs, 3000);
  assert.equal(timeline.bars.some(bar => bar.role === "validation"), false, "the unexplained gap must not be presented as validation time");
  assert.deepEqual(record, before, "rendering the waterfall must not change the saved evidence");
});

test("missing call timestamps stay unrecorded rather than receiving guessed sequential bars", () => {
  const timeline = buildTimeline(run({ calls: [call("structure", { startedAt: "", finishedAt: null, durationMs: 3000 })] }));
  assert.deepEqual(timeline.bars, []);
  assert.equal(timeline.unrecorded, 1);
  assert.equal(timeline.otherMs, null, "unrecorded model work cannot all be attributed to host overhead");
  const unknown = buildTimeline(run({ startedAt: "", finishedAt: null, durationMs: null, calls: [] }));
  assert.equal(unknown.totalMs, null);
  assert.equal(unknown.otherMs, null);
});

test("live waterfall advances from the recorded start and completed history remains fixed", () => {
  const record = run({ status: "running", stage: "structure", finishedAt: null, durationMs: null, calls: [call("structure", { status: "running", finishedAt: null, durationMs: null })] });
  const first = buildTimeline(record, Date.parse(at(4000)));
  const second = buildTimeline(record, Date.parse(at(6000)));
  assert.equal(first.totalMs, 4000);
  assert.equal(first.bars[0]?.durationMs, 3000);
  assert.equal(second.totalMs, 6000);
  assert.equal(second.bars[0]?.durationMs, 5000);
  assert.equal(second.bars[0]?.live, true);
  assert.deepEqual(buildTimeline(run(), Date.parse(at(100000))), buildTimeline(run(), Date.parse(at(200000))));
});

test("timestamp-only durations are legitimate evidence and overlapping calls use their union", () => {
  const timeline = buildTimeline(run({ durationMs: null, calls: [
    call("structure", { startedAt: at(1000), finishedAt: at(7000), durationMs: null }),
    call("text", { startedAt: at(5000), finishedAt: at(9000), durationMs: null }),
  ] }));
  assert.equal(timeline.totalMs, 10000);
  assert.equal(timeline.otherMs, 2000);
  assert.equal(timeline.bars[0]?.durationMs, 6000);
});

test("context composition accounts for every character in both prompts without pretending to report tokens", () => {
  const actual = context();
  const result = contextBreakdown(actual);
  assert.equal(result.total, actual.systemPrompt.length + actual.userPrompt.length);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.characters, 0), result.total);
  assert.ok(Math.abs(result.segments.reduce((sum, segment) => sum + segment.percent, 0) - 100) < 0.00001);
  for (const module of actual.modules) assert.equal(result.segments.find(segment => segment.id === module.id)?.characters, module.text.length);
  assert.equal(result.segments.find(segment => segment.id === "system")?.text, actual.systemPrompt);
  assert.equal(result.segments.find(segment => segment.id === "framing")?.text, actual.userPrompt);
  assert.equal("tokens" in result, false);
});

test("legacy module summaries absent from the actual prompt cannot masquerade as a precise decomposition", () => {
  const actual: ExplorationContext = {
    systemPrompt: "system", userPrompt: "This is the only recorded user input. It contains no saved world module.",
    modules: [{ id: "old-world", kind: "world", title: "旧模块摘要", reason: "旧格式", text: "未实际发送的摘要" }],
    activeRegionIds: [], characters: 0,
  };
  const result = contextBreakdown(actual);
  assert.deepEqual(result.segments.map(segment => segment.id), ["system", "user-message"]);
  assert.equal(result.segments[1]?.text, actual.userPrompt);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.characters, 0), result.total);
});

test("legacy oversized module metadata falls back to the original input, with no negative slices", () => {
  const actual = context();
  actual.userPrompt = "旧格式输入";
  const result = contextBreakdown(actual);
  assert.deepEqual(result.segments.map(segment => segment.id), ["system", "user-message"]);
  assert.ok(result.segments.every(segment => segment.characters >= 0));
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.characters, 0), actual.systemPrompt.length + actual.userPrompt.length);
});

test("context diff distinguishes unloaded location from an updated retained module and newly loaded material", () => {
  const before = context();
  const after = structuredClone(before);
  after.modules = after.modules.filter(module => module.id !== "location:gate");
  after.modules.find(module => module.id === "world-core")!.text += "世界发生变化。";
  after.modules.push({ id: "location:cell", kind: "location", title: "地牢", reason: "当前位置", text: "石室" });
  const snapshot = structuredClone({ before, after });
  const diff = compareContexts(before, after);
  assert.equal(diff.find(module => module.id === "location:gate")?.status, "removed");
  assert.equal(diff.find(module => module.id === "world-core")?.status, "changed");
  assert.equal(diff.find(module => module.id === "location:cell")?.status, "added");
  assert.equal(diff.find(module => module.id === "location:qingyun")?.status, "unchanged");
  assert.deepEqual({ before, after }, snapshot);
});

test("historical outcome uses names from that request and created result, independent of the current world", () => {
  const world = createInitialWorld("projection-world");
  const oldContext = buildExplorationContext(world, "前往渡口");
  const update = draft({ destinationId: "ferry", createRegions: [{ id: "ferry", name: "旧渡口", parentId: null, summary: "江边。", details: [], state: {}, opportunities: [] }] });
  const applied = applyWorldTurn(world, update, { id: "turn-1", action: "前往渡口", createdAt: startedAt });
  const record = run({ context: oldContext, draft: update, changes: applied.changes });
  const historical = runOutcome(record);
  assert.deepEqual(historical.from, { id: "gate", name: "山门" });
  assert.deepEqual(historical.to, { id: "ferry", name: "旧渡口" });
  assert.equal(historical.committed, true);
  applied.world.regions.find(region => region.id === "ferry")!.name = "改名后的新港";
  world.regions.find(region => region.id === "gate")!.name = "如今的废墟";
  assert.deepEqual(runOutcome(record), historical);
});

test("returning to an unloaded old region resolves its historical name from the recorded registry", () => {
  const record = run({ changes: [{ kind: "moved", regionId: "qingyun", label: "移动", before: "gate", after: "qingyun" }] });
  record.context.modules = record.context.modules.filter(module => module.id !== "location:qingyun");
  assert.deepEqual(runOutcome(record).to, { id: "qingyun", name: "青云宗" });
});

test("failed drafts are candidates, including their prior recorded state, and never masquerade as a committed world", () => {
  const world = createInitialWorld("projection-world");
  world.regions.find(region => region.id === "gate")!.state["门锁"] = "关闭";
  const update = draft({
    destinationId: "cell", createRegions: [{ id: "cell", name: "候选地牢", parentId: "qingyun", summary: "石室。", details: [], state: {}, opportunities: [] }],
    enrichRegions: [{ id: "gate", addDetails: ["石阶上有碎片。"], stateChanges: { 门锁: "打开" }, addOpportunities: [], reason: "尝试开门" }],
  });
  const record = run({ status: "failed", stage: "text", failureStage: "text", context: buildExplorationContext(world, "打开门"), draft: update });
  const before = structuredClone({ world, record });
  const outcome = runOutcome(record);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.to.name, "候选地牢");
  assert.equal(outcome.from.name, "山门");
  assert.deepEqual(outcome.groups.find(group => group.regionId === "gate")?.changes.find(change => change.kind === "state"), { kind: "state", label: "门锁", before: "关闭", after: "打开" });
  assert.equal(outcome.groups.find(group => group.regionId === "cell")?.changes.find(change => change.kind === "created")?.label, "候选新区域");
  assert.deepEqual({ world, record }, before);
});

test("a rejected duplicate-ID creation cannot rename the historical point of departure", () => {
  const update = draft({ createRegions: [{ id: "gate", name: "候选地牢", parentId: "qingyun", summary: "模型误用了已有 ID。", details: [], state: {}, opportunities: [] }] });
  assert.throws(() => applyWorldTurn(createInitialWorld("projection-world"), update, { id: "turn-1", action: "寻找地牢", createdAt: startedAt }));
  const outcome = runOutcome(run({ status: "failed", stage: "validation", failureStage: "validation", draft: update }));
  assert.equal(outcome.committed, false);
  assert.deepEqual(outcome.from, { id: "gate", name: "山门" });
  assert.match(outcome.groups[0]?.changes[0]?.after ?? "", /候选地牢/, "the rejected candidate should remain inspectable without rewriting history");
});

test("candidate state comparisons use the recorded registry when the region detail was not loaded", () => {
  const world = createInitialWorld("projection-world");
  world.regions.push({ id: "south", name: "南疆", parentId: null, summary: "远方地区。", details: [], opportunities: [], state: { 禁令: "禁止夜行" }, createdTurn: 0, updatedTurn: 0, revision: 1 });
  const recordedContext = buildExplorationContext(world, "询问禁令");
  assert.equal(recordedContext.modules.some(module => module.id === "location:south" || module.id === "related:south"), false);
  const update = draft({ enrichRegions: [{ id: "south", addDetails: [], addOpportunities: [], stateChanges: { 禁令: "解除" }, reason: "候选更新" }] });
  const outcome = runOutcome(run({ status: "failed", stage: "validation", failureStage: "validation", context: recordedContext, draft: update }));
  assert.equal(outcome.groups.find(group => group.regionId === "south")?.changes.find(change => change.label === "禁令")?.before, "禁止夜行");
});

test("a region's detail and state changes stay in one comparison group", () => {
  const changes = applyWorldTurn(createInitialWorld("projection-world"), draft({ enrichRegions: [{
    id: "gate", addDetails: ["石碑背面有字。"], stateChanges: { 标记: "圆圈" }, addOpportunities: ["检查字迹"], reason: "查看并标记",
  }] }), { id: "turn-1", action: "检查石碑", createdAt: startedAt }).changes;
  const outcome = runOutcome(run({ changes }));
  assert.equal(outcome.groups.length, 1);
  assert.equal(outcome.groups[0]?.name, "山门");
  assert.equal(outcome.groups[0]?.changes.length, changes.length);
  assert.equal(outcome.changeCount, changes.length);
});

test("run filtering combines status and trimmed case-insensitive search without reordering the store", () => {
  const records = [
    run({ id: "old", action: "前往南疆", model: "LUNA" }),
    run({ id: "failed", action: "查看地牢", status: "failed", error: "JSON parse failed" }),
    run({ id: "new", action: "返回山门", status: "cancelled" }),
  ];
  const before = structuredClone(records);
  assert.deepEqual(filterRuns(records).map(record => record.id), ["new", "failed", "old"]);
  assert.deepEqual(filterRuns(records, { status: "failed", query: "  json  " }).map(record => record.id), ["failed"]);
  assert.deepEqual(filterRuns(records, { query: "南疆" }).map(record => record.id), ["old"]);
  assert.deepEqual(filterRuns(records, { query: "luna" }).map(record => record.id), ["new", "failed", "old"]);
  assert.deepEqual(filterRuns(records, { status: "completed", query: "地牢" }), []);
  assert.deepEqual(records, before);
});

test("unknown usage remains unknown while partial call usage is explicitly partial", () => {
  assert.deepEqual(runMetrics(run()), { durationMs: 10000, requests: 2, knownTokens: null, usageComplete: false, callCount: 2 });
  const partial = runMetrics(run({ calls: [call("structure", { usage: usage(100) }), call("text")] }));
  assert.equal(partial.knownTokens, 100);
  assert.equal(partial.usageComplete, false);
  const complete = runMetrics(run({ calls: [call("structure", { usage: usage(100) }), call("text", { usage: usage(200) })] }));
  assert.equal(complete.knownTokens, 300);
  assert.equal(complete.usageComplete, true);
});

test("starting a second call cannot turn the prior aggregate usage into a complete two-call total", () => {
  // service.ts publishes a newly pushed call before its first progress callback refreshes run.usage.
  const record = run({ status: "running", stage: "text", usage: usage(100), calls: [call("structure", { usage: usage(100) }), call("text", { status: "running", usage: null, finishedAt: null, durationMs: null })] });
  const metrics = runMetrics(record);
  assert.equal(metrics.knownTokens, 100);
  assert.equal(metrics.usageComplete, false);
});

test("legacy usage can be read without inventing modern per-call measurements", () => {
  const record = run({ usage: usage(300), modelRequests: 1 });
  delete record.calls;
  const metrics = runMetrics(record);
  assert.equal(metrics.knownTokens, 300);
  assert.equal(metrics.usageComplete, true);
  assert.equal(metrics.callCount, 1);
  const timeline = buildTimeline(record);
  assert.deepEqual(timeline.bars, []);
  assert.equal(timeline.unrecorded, 1);
});
