import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createScenarioFixture } from "../fixtures/npc-scenarios.js";
import { runActorReply, type ActorRunEvent, type RunReplyOptions } from "../src/actors/run-reply.js";
import type { ActorRunRequest } from "../src/actors/types.js";
import { InMemoryMemoryReader } from "../src/memory/in-memory.js";
import { createScriptedRuntime, recallCall, reply, type ScriptedTurn } from "../src/acceptance/scripted-model.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function start(
  turns: ScriptedTurn[],
  overrides: Partial<Omit<RunReplyOptions, "model" | "modelRuntime">> = {},
  fixtureName = "recall-needed",
  suppliedRequest?: ActorRunRequest,
) {
  const fixture = createScenarioFixture(fixtureName);
  const scripted = createScriptedRuntime(turns);
  const events: ActorRunEvent[] = [];
  const request = suppliedRequest ?? {
    runId: "test-run",
    scope: fixture.scenario.scope,
    observation: { source: "player" as const, text: fixture.scenario.observation },
  };
  const promise = runActorReply(request, {
    actorRepository: fixture.actorRepository,
    memoryReader: fixture.memoryReader,
    ...overrides,
    modelRuntime: scripted.runtime,
    onEvent: (event) => {
      events.push(JSON.parse(JSON.stringify(event)) as ActorRunEvent);
      overrides.onEvent?.(event);
    },
  });
  return { fixture, events, requests: scripted.requests, promise };
}

test("direct reply completes without forcing recall", async () => {
  const run = start([() => reply("我得守信。")]);
  assert.deepEqual(await run.promise, { status: "completed", runId: "test-run", reply: "我得守信。" });
  assert.equal(run.requests.length, 1);
  assert.equal(run.fixture.reads.length, 0);
  assert.equal(run.events.filter((event) => event.type === "run_finished").length, 1);
});

test("Pi executes recall and includes its result in the next model request", async () => {
  const run = start([
    () => {
      const call = recallCall("留药");
      call.content.unshift({ type: "text", text: "我先查一下。" });
      return call;
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /陈叔/);
      return reply("昨晚答应陈叔留药，不能失信。");
    },
  ]);
  const result = await run.promise;
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.reply, "昨晚答应陈叔留药，不能失信。");
  assert.equal(run.requests.length, 2);
  assert.deepEqual(run.fixture.reads[0]?.scope, { worldId: "river-town", actorId: "doctor-lin" });
  assert.doesNotMatch(JSON.stringify(run.requests), /北仓|巡山队|wu-secret-ledger|mountain-lin-memory/);
});

test("same actor and memory IDs remain isolated across worlds", async () => {
  const reader = new InMemoryMemoryReader([
    { worldId: "river-town", actorId: "doctor-lin", id: "same-id", text: "河镇约定", keywords: ["约定"] },
    { worldId: "other-world", actorId: "doctor-lin", id: "same-id", text: "异世界秘密", keywords: ["约定"] },
  ]);
  const run = start([() => recallCall("约定"), () => reply("核实好了。")], { memoryReader: reader });
  assert.equal((await run.promise).status, "completed");
  assert.match(JSON.stringify(run.requests[1]), /河镇约定/);
  assert.doesNotMatch(JSON.stringify(run.requests), /异世界秘密/);
});

for (const [name, args] of [
  ["whitespace query", { query: "   " }],
  ["too long query", { query: "药".repeat(201) }],
  ["out of range limit", { limit: 6 }],
  ["fractional limit", { limit: 1.5 }],
  ["string limit", { limit: "2" }],
  ["null limit", { limit: null }],
  ["non-string query", { query: 123 }],
  ["undeclared identity", { actorId: "merchant-wu", worldId: "mountain-world" }],
] as const) {
  test("recall rejects " + name + " without reading memory", async () => {
    const run = start([
      () => recallCall("留药", args),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError);
        return reply("这次没有查到可靠记忆。");
      },
    ]);
    assert.equal((await run.promise).status, "completed");
    assert.equal(run.fixture.reads.length, 0);
  });
}

test("empty recall hits are returned honestly and leave fixture unchanged", async () => {
  const run = start([() => recallCall("留药"), () => reply("暂时记不清。")], {}, "unknown");
  const before = run.fixture.snapshot();
  assert.equal((await run.promise).status, "completed");
  assert.deepEqual(run.fixture.reads[0]?.hits, []);
  assert.match(JSON.stringify(run.requests[1]), /hits/);
  assert.deepEqual(run.fixture.snapshot(), before);
});

test("memory failure is visible to the next model as a tool error", async () => {
  const run = start([
    () => recallCall("留药"),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result.content), /storage unavailable/);
      return reply("记忆查询出了问题，我先核实。");
    },
  ], { memoryReader: { async recall() { throw new Error("storage unavailable"); } } });
  assert.equal((await run.promise).status, "completed");
});

test("caller mutation cannot switch the run's bound actor scope", async () => {
  const request: ActorRunRequest = {
    runId: "test-run",
    scope: { worldId: "river-town", actorId: "doctor-lin" },
    observation: { source: "player", text: "为什么不卖？" },
  };
  const run = start([() => recallCall("留药"), () => reply("我得守信。")], {}, "recall-needed", request);
  request.scope.actorId = "merchant-wu";
  request.scope.worldId = "other-world";
  assert.equal((await run.promise).status, "completed");
  assert.deepEqual(run.fixture.reads[0]?.scope, { worldId: "river-town", actorId: "doctor-lin" });
});

test("pre-cancelled runs never request a model", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = start([], { signal: controller.signal });
  assert.equal((await run.promise).status, "aborted");
  assert.equal(run.requests.length, 0);
});

test("cancelling a model request clears listeners and emits one terminal event", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const run = start([async () => {
    started.resolve();
    return new Promise(() => {});
  }], { signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal((await run.promise).status, "aborted");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await flush();
  assert.equal(run.events.filter((event) => event.type === "run_finished").length, 1);
  assert.equal(run.events.at(-1)?.type, "run_finished");
});

test("late memory results after cancellation cannot complete the run", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const late = deferred<never[]>();
  const run = start([() => recallCall("留药"), () => reply("迟到回复")], {
    signal: controller.signal,
    memoryReader: { async recall() { started.resolve(); return late.promise; } },
  });
  await started.promise;
  controller.abort();
  assert.equal((await run.promise).status, "aborted");
  const eventCount = run.events.length;
  late.resolve([]);
  await flush();
  assert.equal(run.events.length, eventCount);
  assert.equal(run.requests.length, 1);
});

test("total timeout bounds actor loading even if a repository ignores its signal", { timeout: 2_000 }, async () => {
  const late = deferred<undefined>();
  const run = start([], {
    actorRepository: { load: () => late.promise },
    limits: { timeoutMs: 10 },
  });
  const result = await run.promise;
  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.code, "time_budget_exceeded");
  assert.equal(run.requests.length, 0);
  late.resolve(undefined);
  await flush();
  assert.equal(run.events.at(-1)?.type, "run_finished");
});

test("model request budget stops Pi before an extra provider request", async () => {
  const run = start([() => recallCall("留药"), () => reply("不应执行")], {
    limits: { maxModelRequests: 1, maxToolCalls: 3 },
  });
  const result = await run.promise;
  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.code, "model_request_budget_exceeded");
  assert.equal(run.requests.length, 1);
});

test("tool budget prevents extra execution within one multi-call response", async () => {
  const run = start([() => ({
    content: [
      { type: "toolCall", id: "a", name: "recall", arguments: { query: "留药" } },
      { type: "toolCall", id: "b", name: "recall", arguments: { query: "陈叔" } },
    ],
    stopReason: "toolUse",
  })], { limits: { maxToolCalls: 1 } });
  assert.equal((await run.promise).status, "budget_exceeded");
  assert.equal(run.fixture.reads.length, 1);
  assert.equal(run.requests.length, 1);
  assert.equal(run.events.filter((event) => event.type === "tool_started").length, 1);
});

test("continued recall loops terminate at a finite model budget", async () => {
  const run = start(Array.from({ length: 5 }, () => () => recallCall("留药")), {
    limits: { maxModelRequests: 3, maxToolCalls: 5 },
  });
  assert.equal((await run.promise).status, "budget_exceeded");
  assert.equal(run.requests.length, 3);
  assert.equal(run.fixture.reads.length, 3);
});

test("streamed preview followed by model error never becomes completed", async () => {
  const run = start([() => ({
    content: [{ type: "text", text: "半句回复" }],
    preview: "半句回复",
    stopReason: "error",
    errorMessage: "provider failed",
  })]);
  const result = await run.promise;
  assert.equal(result.status, "failed");
  assert.equal("reply" in result, false);
  assert.ok(run.events.some((event) => event.type === "reply_delta"));
});

test("empty and length-limited responses are not submitted", async () => {
  const empty = start([() => ({ content: [] })]);
  assert.equal((await empty.promise).status, "failed");
  const truncated = start([() => ({ ...reply("未完"), stopReason: "length" })]);
  assert.equal((await truncated.promise).status, "failed");
});

test("invalid actor or empty observation fails before any model request", async () => {
  const missing = start([], { actorRepository: { async load() { return undefined; } } });
  assert.equal((await missing.promise).status, "failed");
  assert.equal(missing.requests.length, 0);
  const empty = start([], {}, "recall-needed", {
    runId: "test-run", scope: { worldId: "river-town", actorId: "doctor-lin" },
    observation: { source: "player", text: " " },
  });
  assert.equal((await empty.promise).status, "failed");
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.events.filter((event) => event.type === "run_finished").length, 1);
});

test("observer exceptions do not change the NPC result", async () => {
  const run = start([() => reply("照常回应。")], { onEvent() { throw new Error("broken observer"); } });
  assert.equal((await run.promise).status, "completed");
});
