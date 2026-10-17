import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createScriptedRuntime, reply, type ScriptedResponse, type ScriptedTurn } from "../src/acceptance/scripted-model.js";
import { resolveModelRoutes } from "../src/agent/routing.js";
import type { PiModelRuntime } from "../src/agent/runtime.js";
import { ExplorationError, ExplorationService } from "../src/exploration/service.js";
import { ExplorationStore } from "../src/exploration/store.js";
import type { ExplorationModelCall, WorldTurnDraft } from "../src/exploration/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const structure: WorldTurnDraft = {
  narration: "结构阶段确认：玩家已抵达南疆渡口。", elapsedMinutes: 90, destinationId: "ferry",
  createRegions: [
    { id: "south", name: "南疆", parentId: null, summary: "温暖多雨的南方。", details: [], state: {}, opportunities: [] },
    { id: "ferry", name: "南疆渡口", parentId: "south", summary: "江边的渡口。", details: ["岸边有一座木棚。"], state: { gate: "木门关闭" }, opportunities: ["观察木棚"] },
  ], enrichRegions: [], events: ["抵达南疆渡口"],
};
const narration = "江风吹动岸边的芦苇。你停在渡口，眼前木棚的门仍然关着。";

function runtime(id: string, turns: ScriptedTurn[], options: { ignoreAbort?: boolean; usage?: { input: number; output: number } } = {}) {
  const scripted = createScriptedRuntime(turns);
  scripted.runtime.model.id = id;
  const wrapped: PiModelRuntime = {
    model: scripted.runtime.model,
    streamSimple: (model, context, streamOptions) => {
      const { signal: _ignored, ...withoutSignal } = streamOptions ?? {};
      const inner = scripted.runtime.streamSimple(model, context, options.ignoreAbort ? withoutSignal : streamOptions);
      if (!options.usage) return inner;
      const usage: AssistantMessage["usage"] = {
        ...options.usage, totalTokens: options.usage.input + options.usage.output,
        cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const output = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of await inner) {
          if (event.type === "done") event.message.usage = structuredClone(usage);
          else if (event.type === "error") event.error.usage = structuredClone(usage);
          else event.partial.usage = structuredClone(usage);
          output.push(event);
        }
      })();
      return output;
    },
  };
  return { runtime: wrapped, requests: scripted.requests };
}

async function fixture(t: TestContext, structureRuntime: PiModelRuntime | undefined, textRuntime: PiModelRuntime | undefined, timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-routing-"));
  const service = new ExplorationService({
    directory,
    ...(structureRuntime ? { modelRuntime: structureRuntime } : {}),
    ...(textRuntime ? { textModelRuntime: textRuntime } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  t.after(async () => {
    service.cancel();
    await service.waitForIdle();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, directory };
}

function userPrompt(context: TranscriptContext): string {
  const message = [...context.messages].reverse().find(message => message.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("");
}

test("model routes default to Sol text and Luna structure/judging on the supplied endpoint", () => {
  const routes = resolveModelRoutes({ LLM_API_KEY: " fixture-key ", LLM_BASE_URL: " https://fixture.invalid/v1 ", LLM_MODEL: "old-single-model" });
  assert.deepEqual(routes.text, { apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", modelId: "gpt-6.1-sol" });
  assert.deepEqual(routes.structure, { apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", modelId: "gpt-6-luna" });
  assert.deepEqual(routes.judge, routes.structure);
  assert.deepEqual(resolveModelRoutes({}), { text: undefined, structure: undefined, judge: undefined });
});

test("explicit role and judge settings override defaults without changing shared live credentials", () => {
  const routes = resolveModelRoutes({
    LLM_API_KEY: "shared-key", LLM_BASE_URL: "https://shared.invalid/v1", LLM_TEXT_MODEL: "text-choice", LLM_STRUCTURE_MODEL: "structure-choice",
    ACCEPTANCE_JUDGE_API_KEY: "judge-key", ACCEPTANCE_JUDGE_BASE_URL: "https://judge.invalid/v1", ACCEPTANCE_JUDGE_MODEL: "judge-choice",
  });
  assert.deepEqual(routes.text, { apiKey: "shared-key", baseUrl: "https://shared.invalid/v1", modelId: "text-choice" });
  assert.deepEqual(routes.structure, { apiKey: "shared-key", baseUrl: "https://shared.invalid/v1", modelId: "structure-choice" });
  assert.deepEqual(routes.judge, { apiKey: "judge-key", baseUrl: "https://judge.invalid/v1", modelId: "judge-choice" });
});

for (const role of ["structure", "text"] as const) {
  test(`a ${role}-only configuration cannot start a partial turn`, async t => {
    const only = runtime(`only-${role}`, []);
    const { service } = await fixture(t, role === "structure" ? only.runtime : undefined, role === "text" ? only.runtime : undefined);
    const before = service.exportSave();
    assert.equal(service.getView().config.configured, false);
    assert.throws(() => service.startTurn("前往南疆"), error => error instanceof ExplorationError && error.statusCode === 503);
    assert.deepEqual(service.exportSave(), before);
    assert.equal(only.requests.length, 0);
  });
}

test("Luna's validated state reaches Sol through Pi, and only Sol's text becomes the persisted narration", async t => {
  const textEntered = deferred<void>();
  const textResult = deferred<ScriptedResponse>();
  const luna = runtime("fixture-luna", [(context, options) => {
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.maxTokens, 4096);
    assert.deepEqual(getCurrentTools(context.messages), []);
    assert.match(userPrompt(context), /前往南疆/);
    return reply(JSON.stringify(structure));
  }], { usage: { input: 120, output: 60 } });
  const sol = runtime("fixture-sol", [(context, options) => {
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.maxTokens, 2048);
    assert.deepEqual(getCurrentTools(context.messages), []);
    const prompt = userPrompt(context);
    assert.match(prompt, /南疆渡口/);
    assert.match(prompt, /木门关闭/);
    assert.match(prompt, /结构阶段确认/);
    textEntered.resolve();
    return textResult.promise;
  }], { usage: { input: 80, output: 30 } });
  const { service, directory } = await fixture(t, luna.runtime, sol.runtime);
  const before = service.getView().world;
  const config = service.getView().config;
  assert.equal(config.configured, true);
  assert.equal(config.structureModel, "fixture-luna");
  assert.equal(config.textModel, "fixture-sol");
  assert.equal(config.maxModelRequests, 2);
  service.startTurn("前往南疆");
  await textEntered.promise;
  assert.deepEqual(service.getView().world, before, "validated structure is still a candidate while narration is running");
  assert.deepEqual(new ExplorationStore(directory).load(before.id).world, before);
  textResult.resolve(reply(narration));
  await service.waitForIdle();
  const saved = service.exportSave();
  const run = saved.runs[0]!;
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(saved.world.playerLocationId, "ferry");
  assert.equal(saved.world.turns[0]?.narration, narration);
  assert.notEqual(saved.world.turns[0]?.narration, structure.narration);
  assert.equal(saved.world.regions.find(region => region.id === "ferry")?.state.gate, "木门关闭");
  assert.equal(saved.world.timeMinutes, before.timeMinutes + 90);
  assert.equal(run.modelRequests, 2);
  assert.equal(luna.requests.length, 1);
  assert.equal(sol.requests.length, 1);
  assert.deepEqual(run.usage, { input: 200, output: 90, totalTokens: 290 });
  assert.equal(run.rawResponse, JSON.stringify(structure));
  assert.equal(run.calls?.length, 2);
  for (const [index, source] of [luna, sol].entries()) {
    const call: ExplorationModelCall = run.calls![index]!;
    assert.equal(call.role, index === 0 ? "structure" : "text");
    assert.equal(call.model, source.runtime.model.id);
    assert.equal(call.status, "completed");
    assert.equal(call.modelRequests, 1);
    assert.equal(call.rawResponse, index === 0 ? JSON.stringify(structure) : narration);
    assert.equal(call.context.systemPrompt, getCurrentSystemPrompt(source.requests[0]!.messages));
    assert.equal(call.context.userPrompt, userPrompt(source.requests[0]!));
    assert.ok(call.durationMs !== null && call.durationMs >= 0);
    assert.ok(call.finishedAt);
    assert.equal(call.error, null);
  }
  assert.deepEqual(run.calls![0]!.usage, { input: 120, output: 60, totalTokens: 180 });
  assert.deepEqual(run.calls![1]!.usage, { input: 80, output: 30, totalTokens: 110 });
  assert.deepEqual(new ExplorationStore(directory).load(before.id), saved);
});

for (const [label, response] of [
  ["provider failure", { ...reply(""), stopReason: "error", errorMessage: "text provider unavailable" }],
  ["empty text", reply("   ")],
  ["truncated text", { ...reply("故事只写了一半"), stopReason: "length" }],
] as const) {
  test(`Sol ${label} preserves the original world and records the failed stage without retry`, async t => {
    const luna = runtime("fixture-luna", [() => reply(JSON.stringify(structure))]);
    const sol = runtime("fixture-sol", [() => response]);
    const { service, directory } = await fixture(t, luna.runtime, sol.runtime);
    const before = service.getView().world;
    service.startTurn("前往南疆");
    await service.waitForIdle();
    const run = service.getView().runs[0]!;
    assert.equal(run.status, "failed");
    assert.ok(run.error);
    assert.deepEqual(service.getView().world, before);
    assert.deepEqual(new ExplorationStore(directory).load(before.id).world, before);
    assert.deepEqual(run.changes, []);
    assert.equal(run.modelRequests, 2);
    assert.equal(luna.requests.length, 1);
    assert.equal(sol.requests.length, 1);
    assert.deepEqual(run.calls?.map(call => call.status), ["completed", "failed"]);
    assert.ok(run.calls?.[1]?.error);
  });
}

test("cancelling Sol ignores a late reply even after selecting a different world", { timeout: 3_000 }, async t => {
  const textEntered = deferred<void>();
  const late = deferred<ScriptedResponse>();
  const luna = runtime("fixture-luna", [() => reply(JSON.stringify(structure))]);
  const sol = runtime("fixture-sol", [() => { textEntered.resolve(); return late.promise; }], { ignoreAbort: true });
  const { service, directory } = await fixture(t, luna.runtime, sol.runtime);
  const before = service.getView().world;
  service.startTurn("前往南疆");
  await textEntered.promise;
  assert.equal(service.cancel(), true);
  await service.waitForIdle();
  const cancelled = service.getView().runs[0]!;
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.calls?.map(call => call.status), ["completed", "cancelled"]);
  assert.deepEqual(service.getView().world, before);
  service.newWorld();
  const next = service.exportSave();
  late.resolve(reply(narration));
  await flush();
  await flush();
  assert.deepEqual(service.exportSave(), next);
  const previous = new ExplorationStore(directory).load(before.id);
  assert.deepEqual(previous.world, before);
  assert.equal(previous.runs[0]?.status, "cancelled");
  assert.equal(sol.requests.length, 1);
});

test("both model stages share one deadline rather than receiving separate full timeouts", { timeout: 3_000 }, async t => {
  const structureEntered = deferred<void>();
  const structureResult = deferred<ScriptedResponse>();
  const textEntered = deferred<void>();
  const textResult = deferred<ScriptedResponse>();
  const luna = runtime("fixture-luna", [() => { structureEntered.resolve(); return structureResult.promise; }]);
  const sol = runtime("fixture-sol", [() => { textEntered.resolve(); return textResult.promise; }], { ignoreAbort: true });
  const { service } = await fixture(t, luna.runtime, sol.runtime, 100);
  const before = service.getView().world;
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  service.startTurn("前往南疆");
  await structureEntered.promise;
  elapsed = 75;
  t.mock.timers.tick(75);
  structureResult.resolve(reply(JSON.stringify(structure)));
  await textEntered.promise;
  elapsed = 99;
  t.mock.timers.tick(24);
  await flush();
  assert.equal(service.getView().runs[0]?.status, "running");
  elapsed = 100;
  t.mock.timers.tick(1);
  await flush();
  const failed = service.exportSave();
  assert.equal(failed.runs[0]?.status, "failed", "Sol only has the 25 ms left after Luna");
  assert.equal(failed.runs[0]?.failureStage, "text");
  assert.match(failed.runs[0]?.error ?? "", /超过|超时/);
  assert.deepEqual(failed.runs[0]?.calls?.map(call => call.status), ["completed", "failed"]);
  assert.equal(failed.runs[0]?.modelRequests, 2);
  assert.deepEqual(failed.world, before);
  await service.waitForIdle();
  textResult.resolve(reply(narration));
  await flush();
  assert.deepEqual(service.exportSave(), failed);
});

test("a missing provider usage value stays unknown while the other stage keeps its measured usage", async t => {
  const luna = runtime("fixture-luna", [() => reply(JSON.stringify(structure))], { usage: { input: 120, output: 60 } });
  const sol = runtime("fixture-sol", [() => reply(narration)]);
  const { service } = await fixture(t, luna.runtime, sol.runtime);
  service.startTurn("前往南疆");
  await service.waitForIdle();
  const run = service.getView().runs[0]!;
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(run.calls?.[0]?.usage, { input: 120, output: 60, totalTokens: 180 });
  assert.equal(run.calls?.[1]?.usage, null);
  assert.equal(run.usage, null, "partial measured usage cannot be reported as the entire turn's total");
  assert.equal(run.modelRequests, 2);
});

test("legacy single-model records remain loadable without fabricating per-stage calls", async t => {
  const luna = runtime("fixture-luna", [() => reply(JSON.stringify(structure))]);
  const sol = runtime("fixture-sol", [() => reply(narration)]);
  const { service, directory } = await fixture(t, luna.runtime, sol.runtime);
  service.startTurn("前往南疆");
  await service.waitForIdle();
  const legacy = service.exportSave();
  delete legacy.runs[0]!.calls;
  legacy.runs[0]!.modelRequests = 1;
  legacy.runs[0]!.model = "legacy-single-model";
  new ExplorationStore(directory).save(legacy);
  const unused = runtime("new-runtime", []);
  const restarted = new ExplorationService({ directory, modelRuntime: unused.runtime, textModelRuntime: unused.runtime });
  assert.deepEqual(restarted.exportSave(), legacy);
  assert.equal(restarted.getView().runs[0]?.calls, undefined);
  assert.equal(unused.requests.length, 0);
});
