import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createScriptedRuntime, reply, type ScriptedResponse, type ScriptedTurn } from "../src/acceptance/scripted-model.js";
import { ExplorationError, ExplorationService } from "../src/exploration/service.js";
import { ExplorationStore } from "../src/exploration/store.js";
import type { WorldTurnDraft } from "../src/exploration/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function draft(overrides: Partial<WorldTurnDraft> = {}): WorldTurnDraft {
  return {
    narration: "你站在青云宗山门前。", elapsedMinutes: 1, destinationId: "gate",
    createRegions: [], enrichRegions: [], events: [], ...overrides,
  };
}
function arrival(): WorldTurnDraft {
  return draft({
    narration: "经过旅程，你抵达南疆的芦苇渡口。", elapsedMinutes: 180, destinationId: "reed-ferry",
    createRegions: [
      { id: "south", name: "南疆", parentId: null, summary: "温暖湿润的南方地区。", details: [], state: {}, opportunities: [] },
      { id: "reed-ferry", name: "芦苇渡口", parentId: "south", summary: "南疆北缘的一处渡口。", details: ["岸边搭着木棚。"], state: { gate: "木门关闭" }, opportunities: ["检查木棚"] },
    ], events: ["抵达南疆芦苇渡口"],
  });
}
async function fixture(t: TestContext, turns: ScriptedTurn[], options: { timeoutMs?: number; ignoreAbort?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-service-"));
  const scripted = createScriptedRuntime(turns);
  const textScripted = createScriptedRuntime(turns.map(() => () => reply("你观察周围，记住眼前的景象。")));
  const modelRuntime = options.ignoreAbort ? {
    ...scripted.runtime,
    streamSimple: ((model, context, streamOptions) => {
      const { signal: _ignored, ...rest } = streamOptions ?? {};
      return scripted.runtime.streamSimple(model, context, rest);
    }) satisfies typeof scripted.runtime.streamSimple,
  } : scripted.runtime;
  const service = new ExplorationService({ directory, modelRuntime, textModelRuntime: textScripted.runtime, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  t.after(async () => {
    service.cancel();
    await service.waitForIdle();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, directory, scripted, textScripted };
}

test("exploration creates, enriches, changes, leaves and revisits the same region across restart", async t => {
  const outputs = [
    arrival(),
    draft({ destinationId: "reed-ferry", narration: "木棚柱上刻着旧渡船的名字。", enrichRegions: [{ id: "reed-ferry", addDetails: ["木柱刻着归雁号三个字。"], stateChanges: {}, addOpportunities: ["询问归雁号的来历"], reason: "玩家检查木棚" }] }),
    draft({ destinationId: "reed-ferry", narration: "你打开木门，并在柱上留下记号。", enrichRegions: [{ id: "reed-ferry", addDetails: [], stateChanges: { gate: "木门已打开", mark: "柱上有玩家刻下的圆圈" }, addOpportunities: [], reason: "玩家开门并留下记号" }] }),
    draft({ elapsedMinutes: 180, narration: "你返回青云宗山门。" }),
    draft({ destinationId: "reed-ferry", elapsedMinutes: 180, narration: "你回到芦苇渡口，木门仍敞着，圆圈记号还在。" }),
  ];
  const { service, directory, scripted } = await fixture(t, outputs.map(output => (context, options) => {
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.maxTokens, 4096);
    assert.deepEqual(getCurrentTools(context.messages), []);
    return reply(JSON.stringify(output));
  }));
  const initial = service.getView();
  assert.equal(initial.world.playerLocationId, "gate");
  assert.deepEqual(initial.nextContext.activeRegionIds, ["qingyun", "gate"]);
  assert.equal(initial.world.regions.some(region => region.id === "south"), false);
  const actions = ["快进到南疆", "检查渡口木棚", "打开木门并刻下圆圈", "返回青云宗山门", "重返芦苇渡口"];
  for (const [index, action] of actions.entries()) {
    const runId = service.startTurn(action);
    await service.waitForIdle();
    const view = service.getView();
    const run = view.runs.at(-1)!;
    assert.equal(run.id, runId);
    assert.equal(run.status, "completed", run.error ?? "");
    assert.equal(run.modelRequests, 2);
    assert.equal(run.rawResponse, JSON.stringify(outputs[index]));
    assert.equal(run.context.systemPrompt, getCurrentSystemPrompt(scripted.requests[index]!.messages));
    assert.equal(run.usage, null, "zero/absent provider usage must not be presented as measured usage");
    assert.equal(view.world.revision, index + 1);
    assert.equal(view.world.turns.length, index + 1);
    assert.equal(view.activeRunId, null);
    assert.deepEqual(view.nextContext.activeRegionIds, index === 3 ? ["qingyun", "gate"] : ["south", "reed-ferry"]);
  }
  const final = service.exportSave();
  const ferry = final.world.regions.find(region => region.id === "reed-ferry")!;
  assert.equal(final.world.regions.filter(region => region.id === "reed-ferry").length, 1);
  assert.ok(ferry.details.includes("岸边搭着木棚。"));
  assert.ok(ferry.details.includes("木柱刻着归雁号三个字。"));
  assert.equal(ferry.state.gate, "木门已打开");
  assert.equal(ferry.state.mark, "柱上有玩家刻下的圆圈");
  assert.ok(ferry.opportunities.includes("询问归雁号的来历"));
  assert.equal(final.world.timeMinutes - initial.world.timeMinutes, 542);
  assert.equal(scripted.requests.length, 5);
  assert.ok(final.runs[0]!.changes.some(change => change.kind === "created" && change.regionId === "south"));
  assert.ok(final.runs[2]!.changes.some(change => change.kind === "state" && change.regionId === "reed-ferry"));
  const restarted = new ExplorationService({ directory, modelRuntime: scripted.runtime });
  assert.deepEqual(restarted.exportSave(), final);
  assert.deepEqual(restarted.getView().nextContext.activeRegionIds, ["south", "reed-ferry"]);
  restarted.newWorld();
  assert.notEqual(restarted.getView().world.id, final.world.id);
  assert.equal(restarted.listSaves().length, 2);
  restarted.loadWorld(final.world.id);
  assert.deepEqual(restarted.exportSave(), final);
  const detached = restarted.getView();
  detached.world.regions.length = 0;
  assert.equal(restarted.getView().world.regions.length, final.world.regions.length, "views are isolated snapshots");
});

for (const [name, output] of [
  ["invalid JSON", "this is not JSON"],
  ["missing destination after a proposed creation", JSON.stringify({ ...arrival(), destinationId: "missing-place" })],
  ["incomplete output", JSON.stringify(draft()).slice(0, -1)],
] as const) {
  test(`invalid exploration ${name} records failure without mutating the world`, async t => {
    const { service, directory, scripted, textScripted } = await fixture(t, [() => reply(output)]);
    const before = service.getView().world;
    const runId = service.startTurn("尝试前往一个新地点");
    await service.waitForIdle();
    const view = service.getView();
    assert.deepEqual(view.world, before);
    assert.equal(view.runs[0]?.id, runId);
    assert.equal(view.runs[0]?.status, "failed");
    assert.equal(view.runs[0]?.rawResponse, output);
    assert.ok(view.runs[0]?.error);
    assert.deepEqual(view.runs[0]?.changes, []);
    assert.equal(scripted.requests.length, 1);
    assert.equal(textScripted.requests.length, 0, "invalid structure must not reach the narration model");
    const persisted = new ExplorationStore(directory).load(before.id);
    assert.deepEqual(persisted.world, before);
    assert.equal(persisted.runs[0]?.status, "failed");
  });
}

test("cancelled exploration ignores a late provider result even after switching worlds", { timeout: 3_000 }, async t => {
  const entered = deferred<void>();
  const late = deferred<ScriptedResponse>();
  const { service, directory, scripted } = await fixture(t, [async () => { entered.resolve(); return late.promise; }], { ignoreAbort: true });
  const before = service.getView().world;
  service.startTurn("前往南疆");
  await entered.promise;
  assert.equal(service.cancel(), true);
  await service.waitForIdle();
  assert.deepEqual(service.getView().world, before);
  assert.equal(service.getView().runs[0]?.status, "cancelled");
  assert.equal(service.cancel(), false);
  service.newWorld();
  const newSave = service.exportSave();
  late.resolve(reply(JSON.stringify(arrival())));
  await flush();
  await flush();
  assert.deepEqual(service.exportSave(), newSave);
  assert.equal(scripted.requests.length, 1);
  const oldSave = new ExplorationStore(directory).load(before.id);
  assert.deepEqual(oldSave.world, before);
  assert.equal(oldSave.runs[0]?.status, "cancelled");
});

test("exploration timeout bounds an uncooperative provider and rejects its late result", { timeout: 3_000 }, async t => {
  const late = deferred<ScriptedResponse>();
  const { service, scripted } = await fixture(t, [() => late.promise], { timeoutMs: 20, ignoreAbort: true });
  const before = service.getView().world;
  service.startTurn("前往南疆");
  await service.waitForIdle();
  const failed = service.exportSave();
  assert.deepEqual(failed.world, before);
  assert.equal(failed.runs[0]?.status, "failed");
  assert.match(failed.runs[0]?.error ?? "", /超过|超时/);
  assert.equal(scripted.requests.length, 1);
  late.resolve(reply(JSON.stringify(arrival())));
  await flush();
  assert.deepEqual(service.exportSave(), failed);
});

test("an active turn prevents concurrent submissions, loads and new-world transitions", { timeout: 3_000 }, async t => {
  const entered = deferred<void>();
  const late = deferred<ScriptedResponse>();
  const { service, scripted } = await fixture(t, [async () => { entered.resolve(); return late.promise; }]);
  const before = service.getView().world;
  const runId = service.startTurn("观察山门");
  await entered.promise;
  assert.equal(service.getView().activeRunId, runId);
  for (const operation of [() => service.startTurn("另一个行动"), () => service.newWorld(), () => service.loadWorld(before.id)]) {
    assert.throws(operation, error => error instanceof ExplorationError && error.statusCode === 409);
  }
  assert.equal(service.getView().runs.length, 1);
  assert.deepEqual(service.getView().world, before);
  late.resolve(reply(JSON.stringify(draft())));
  await service.waitForIdle();
  assert.equal(service.getView().runs[0]?.status, "completed");
  assert.equal(scripted.requests.length, 1);
});

test("missing model configuration and invalid actions fail before scheduling or writing a run", async t => {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new ExplorationService({ directory });
  const before = service.exportSave();
  assert.equal(service.getView().config.configured, false);
  assert.throws(() => service.startTurn("前往南疆"), error => error instanceof ExplorationError && error.statusCode === 503);
  for (const action of ["", "  ", "字".repeat(2001)]) {
    assert.throws(() => service.startTurn(action), error => error instanceof ExplorationError && error.statusCode === 400);
  }
  assert.deepEqual(service.exportSave(), before);
});

test("restart marks unfinished persisted runs as failed without replaying model calls", { timeout: 3_000 }, async t => {
  const entered = deferred<void>();
  const { service, directory } = await fixture(t, [async () => { entered.resolve(); return new Promise(() => {}); }]);
  const before = service.getView().world;
  service.startTurn("前往南疆");
  await entered.promise;
  const unfinished = service.exportSave();
  assert.equal(unfinished.runs[0]?.status, "running");
  service.cancel();
  await service.waitForIdle();
  new ExplorationStore(directory).save(unfinished);
  const freshRuntime = createScriptedRuntime([]);
  const recovered = new ExplorationService({ directory, modelRuntime: freshRuntime.runtime });
  assert.deepEqual(recovered.getView().world, before);
  assert.equal(recovered.getView().activeRunId, null);
  assert.equal(recovered.getView().runs[0]?.status, "failed");
  assert.match(recovered.getView().runs[0]?.error ?? "", /上次进程|中断/);
  assert.equal(recovered.getView().runs[0]?.calls?.[0]?.status, "failed", "interrupted model stages must not remain running in the debug graph");
  assert.ok(recovered.getView().runs[0]?.calls?.[0]?.finishedAt);
  assert.equal(recovered.getView().runs[0]?.failureStage, "structure");
  assert.equal(freshRuntime.requests.length, 0);
  assert.equal(new ExplorationStore(directory).load(before.id).runs[0]?.status, "failed");
});

test("a legal oversized world update is rejected while the original save remains playable", async t => {
  const oversized = draft({
    narration: "你走进藏经楼，查看大量书架与铭文。",
    destinationId: "archive-hall",
    createRegions: [{
      id: "archive-hall", name: "藏经楼", parentId: "qingyun", summary: "宗门收藏典籍的楼阁。",
      details: Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 处铭文：${"a".repeat(540)}`),
      state: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`书架 ${index + 1}`, "b".repeat(500)])),
      opportunities: [],
    }],
  });
  const simple = draft({ narration: "你在山门稍作休息。", elapsedMinutes: 5 });
  const { service, directory, scripted, textScripted } = await fixture(t, [
    () => reply(JSON.stringify(oversized)),
    () => reply(JSON.stringify(simple)),
  ]);
  const before = service.getView().world;
  service.startTurn("进入藏经楼，仔细查看书架与铭文");
  await service.waitForIdle();
  const rejected = service.getView();
  assert.equal(rejected.runs[0]?.status, "failed");
  assert.deepEqual(rejected.runs[0]?.draft, oversized, "the candidate must have passed draft parsing");
  assert.match(rejected.runs[0]?.error ?? "", /下一轮必要上下文过大/);
  assert.deepEqual(rejected.world, before);
  assert.deepEqual(new ExplorationStore(directory).load(before.id).world, before);
  assert.equal(rejected.activeRunId, null);
  assert.equal(textScripted.requests.length, 0, "capacity is checked before generating narration");

  service.startTurn("那就在山门休息五分钟");
  await service.waitForIdle();
  const continued = service.getView();
  assert.equal(continued.runs[1]?.status, "completed", continued.runs[1]?.error ?? "");
  assert.equal(continued.runs[0]?.status, "failed", "the rejected attempt remains in the debug history");
  assert.equal(continued.world.revision, before.revision + 1);
  assert.equal(continued.world.turns.length, before.turns.length + 1);
  assert.equal(continued.world.playerLocationId, "gate");
  assert.equal(continued.world.timeMinutes, before.timeMinutes + 5);
  assert.deepEqual(continued.world.regions, before.regions);
  assert.equal(scripted.requests.length, 2, "each user attempt makes exactly one structure request, without retries");
  assert.equal(textScripted.requests.length, 1, "only the accepted structure reaches narration");
  assert.deepEqual(new ExplorationStore(directory).load(before.id), service.exportSave());
});
