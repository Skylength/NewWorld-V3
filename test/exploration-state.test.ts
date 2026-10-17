import assert from "node:assert/strict";
import test from "node:test";
import { buildExplorationContext } from "../src/exploration/context.js";
import { applyWorldTurn, createInitialWorld, parseWorldTurnDraft } from "../src/exploration/state.js";
import type { ExplorationWorld, RegionCreate, WorldTurnDraft } from "../src/exploration/types.js";

function draft(overrides: Partial<WorldTurnDraft> = {}): WorldTurnDraft {
  return { narration: "山风吹过石阶。", elapsedMinutes: 1, destinationId: "gate", createRegions: [], enrichRegions: [], events: [], ...overrides };
}

function region(id: string, parentId: string | null = null, name = id): RegionCreate {
  return { id, name, parentId, summary: `${name} 的初步环境。`, details: [], state: {}, opportunities: [] };
}

function apply(world: ExplorationWorld, update: WorldTurnDraft) {
  return applyWorldTurn(world, update, { id: `turn-${world.turns.length + 1}`, action: "观察或前往目的地", createdAt: "2026-10-15T00:00:00.000Z" });
}

test("initial world has only the sect and gate, with no predetermined destination", () => {
  const world = createInitialWorld("test-world");
  assert.deepEqual(world.regions.map((entry) => entry.id), ["qingyun", "gate"]);
  assert.equal(world.playerLocationId, "gate");
  world.regions[0]!.details.push("changed");
  assert.equal(createInitialWorld("other").regions[0]!.details.includes("changed"), false);
});

test("new regions accept a later-created parent and can be enriched in the same atomic turn", () => {
  const original = createInitialWorld("test-world");
  const snapshot = structuredClone(original);
  const result = apply(original, draft({
    destinationId: "ferry",
    createRegions: [region("ferry", "south", "渡口"), region("south", null, "南疆")],
    enrichRegions: [{ id: "ferry", addDetails: ["渡口有一株古树。"], stateChanges: { "渡船": "靠岸" }, addOpportunities: ["询问船夫。"], reason: "抵达时发现" }],
    elapsedMinutes: 240,
  }));
  assert.deepEqual(original, snapshot);
  assert.equal(result.world.playerLocationId, "ferry");
  assert.equal(result.world.timeMinutes, 240);
  assert.equal(result.world.regions.find((entry) => entry.id === "ferry")!.state["渡船"], "靠岸");
  assert.equal(result.world.turns[0]!.fromId, "gate");
  assert.equal(result.world.turns[0]!.toId, "ferry");
  assert.equal(result.world.turns[0]!.changes.length, result.changes.length);
});

test("observation deduplicates existing details while state changes replace or delete values", () => {
  let world = createInitialWorld("test-world");
  const detail = world.regions[1]!.details[0]!;
  world = apply(world, draft({ enrichRegions: [{ id: "gate", addDetails: [detail, "石碑背面有刻痕。", " 石碑背面有刻痕。 "], stateChanges: { "标记": "一个圆圈", "门锁": "关闭" }, addOpportunities: ["检查石碑。", "检查石碑。"], reason: "检查与标记" }] })).world;
  let gate = world.regions.find((entry) => entry.id === "gate")!;
  assert.deepEqual(gate.details, [detail, "石碑背面有刻痕。"]);
  assert.equal(gate.opportunities.filter((entry) => entry === "检查石碑。").length, 1);
  assert.equal(gate.revision, 2);
  world = apply(world, draft({ enrichRegions: [{ id: "gate", addDetails: [], stateChanges: { "标记": "两个圆圈", "门锁": null }, addOpportunities: [], reason: "修改标记并移除门锁" }] })).world;
  gate = world.regions.find((entry) => entry.id === "gate")!;
  assert.deepEqual(gate.state, { "标记": "两个圆圈" });
  assert.equal(gate.revision, 3);
  const unchanged = apply(world, draft({ enrichRegions: [{ id: "gate", addDetails: [detail], stateChanges: { "标记": "两个圆圈", "不存在": null }, addOpportunities: [], reason: "再次确认" }] }));
  assert.equal(unchanged.changes.length, 0);
  assert.equal(unchanged.world.regions.find((entry) => entry.id === "gate")!.revision, 3);
});

test("leaving and returning reuses location identity and preserves changed environment", () => {
  let world = createInitialWorld("test-world");
  world = apply(world, draft({ destinationId: "dungeon", createRegions: [{ ...region("dungeon", "qingyun", "地牢"), state: { "牢门": "上锁" } }] })).world;
  world = apply(world, draft({ destinationId: "dungeon", enrichRegions: [{ id: "dungeon", addDetails: ["西墙有潮湿的裂隙。"], stateChanges: { "牢门": "打开", "墙面标记": "玩家刻下的圆圈" }, addOpportunities: [], reason: "开门并留下标记" }] })).world;
  world = apply(world, draft()).world;
  world = apply(world, draft({ destinationId: "dungeon" })).world;
  assert.equal(world.regions.filter((entry) => entry.name === "地牢").length, 1);
  assert.deepEqual(world.regions.find((entry) => entry.id === "dungeon")!.state, { "牢门": "打开", "墙面标记": "玩家刻下的圆圈" });
  assert.equal(world.regions.find((entry) => entry.id === "dungeon")!.createdTurn, 1);
});

test("strict draft parsing rejects unknown fields, invalid IDs, oversized data and wrong scalar types", () => {
  const invalid: unknown[] = [
    { ...draft(), playerIntent: "被代写" },
    { ...draft(), elapsedMinutes: 0.5 },
    { ...draft(), elapsedMinutes: -1 },
    { ...draft(), elapsedMinutes: 525601 },
    { ...draft(), narration: "x".repeat(6001) },
    { ...draft(), destinationId: "../../secret" },
    { ...draft(), createRegions: Array.from({ length: 6 }, (_, i) => region(`r${i}`)) },
    { ...draft(), createRegions: [{ ...region("new"), details: ["x".repeat(601)] }] },
    { ...draft(), enrichRegions: Array.from({ length: 9 }, () => ({ id: "gate", addDetails: [], stateChanges: {}, addOpportunities: [], reason: "重复" })) },
    { ...draft(), createRegions: [{ ...region("new"), revision: 4 }] },
    { ...draft(), createRegions: [{ ...region("new"), state: { "门": true } }] },
    { ...draft(), events: [42] },
  ];
  for (const update of invalid) assert.throws(() => parseWorldTurnDraft(JSON.stringify(update)), /世界更新无效/);
  assert.throws(() => parseWorldTurnDraft("```json\n{}\n```"), /不是合法 JSON/);
  assert.throws(() => parseWorldTurnDraft('{"narration":"a","elapsedMinutes":0,"destinationId":"gate","createRegions":[],"enrichRegions":[{"id":"gate","addDetails":[],"stateChanges":{"__proto__":"x"},"addOpportunities":[],"reason":"x"}],"events":[]}'), /状态名无效/);
  assert.deepEqual(parseWorldTurnDraft(JSON.stringify(draft())), draft());
});

test("invalid references, duplicate IDs/names and parent cycles leave the complete original unchanged", () => {
  const world = createInitialWorld("test-world");
  const snapshot = structuredClone(world);
  const updates = [
    draft({ destinationId: "missing" }),
    draft({ createRegions: [region("gate")] }),
    draft({ createRegions: [region("other", "qingyun", "山门")] }),
    draft({ createRegions: [region("same"), region("same")] }),
    draft({ createRegions: [region("orphan", "missing")] }),
    draft({ createRegions: [region("one", "two"), region("two", "one")] }),
    draft({ createRegions: [region("self", "self")] }),
    draft({ createRegions: [region("valid")], enrichRegions: [{ id: "missing", addDetails: [], stateChanges: {}, addOpportunities: [], reason: "不存在" }] }),
  ];
  for (const update of updates) {
    assert.throws(() => apply(world, update), /世界更新无效/);
    assert.deepEqual(world, snapshot);
  }
});

test("direct apply validates too and resulting change records cannot mutate saved turns", () => {
  const world = createInitialWorld("test-world");
  assert.throws(() => apply(world, draft({ elapsedMinutes: Number.NaN })), /整数/);
  const result = apply(world, draft({ createRegions: [region("south", null, "南疆")], destinationId: "south" }));
  result.changes[0]!.after = "tampered";
  assert.notEqual(result.world.turns[0]!.changes[0]!.after, "tampered");
});

test("context loads the current ancestry, unloads departed regions, and treats exact mentions as related only", () => {
  let world = createInitialWorld("test-world");
  world = apply(world, draft({ createRegions: [region("south", null, "南疆"), region("ferry", "south", "渡口")], destinationId: "ferry" })).world;
  const context = buildExplorationContext(world, "观察这里");
  assert.deepEqual(context.activeRegionIds, ["south", "ferry"]);
  assert.deepEqual(context.modules.filter((entry) => entry.kind === "location").map((entry) => entry.title), ["南疆", "渡口"]);
  assert.equal(context.modules.some((entry) => entry.kind === "location" && entry.title === "青云宗"), false);
  assert.equal(context.modules.some((entry) => entry.kind === "related"), false);
  assert.match(context.userPrompt, /"playerLocationId":"ferry"/);
  assert.equal(context.characters, context.systemPrompt.length + context.userPrompt.length);
  const related = buildExplorationContext(world, "青云宗是什么样的？只是询问，继续留在此处。");
  assert.deepEqual(related.activeRegionIds, ["south", "ferry"]);
  assert.equal(related.modules.some((entry) => entry.kind === "related" && entry.title === "青云宗"), true);
  assert.equal(buildExplorationContext(world, "delegate").modules.some((entry) => entry.id === "related:gate"), false);
  assert.equal(buildExplorationContext(world, "查看 gate").modules.some((entry) => entry.id === "related:gate"), true);
});

test("context retains six recent turns and current state overrides historical scene text", () => {
  let world = createInitialWorld("test-world");
  for (let i = 0; i < 8; i += 1) world = apply(world, draft({ narration: `观察第 ${i + 1} 次。` })).world;
  const context = buildExplorationContext(world, "继续");
  const history = context.modules.find((entry) => entry.kind === "history")!;
  const turns = JSON.parse(history.text) as { number: number }[];
  assert.deepEqual(turns.map((turn) => turn.number), [3, 4, 5, 6, 7, 8]);
  assert.match(context.systemPrompt, /当前 state 优先于历史描述/);
  assert.match(context.systemPrompt, /提及、询问、回忆某地不能自动移动/);
});

test("returning by a description retains old destination state beyond the six-turn history window", () => {
  let world = createInitialWorld("test-world");
  world = apply(world, draft({
    narration: "你来到黑石牢房。",
    destinationId: "blackstone_cell",
    createRegions: [{
      ...region("blackstone_cell", "qingyun", "黑石牢房"),
      summary: "青云宗地下的一处地牢，牢门最初上锁。",
      details: ["西墙最下方有一条通向旧水渠的狭缝。"],
      state: { "牢门": "上锁" },
    }],
  })).world;
  world = apply(world, draft({
    destinationId: "blackstone_cell",
    enrichRegions: [{
      id: "blackstone_cell",
      addDetails: Array.from({ length: 12 }, (_, index) => `牢房内确认的第 ${index + 2} 条环境细节。`),
      stateChanges: { "牢门": "打开", "墙面标记": "玩家刻下的圆圈" },
      addOpportunities: Array.from({ length: 8 }, (_, index) => `可以检查第 ${index + 1} 处细节。`),
      reason: "调查牢房并开门留下标记",
    }],
  })).world;
  world = apply(world, draft({ narration: "你回到山门。" })).world;
  for (let i = 0; i < 7; i += 1) world = apply(world, draft({ narration: "你留在山门观察山景。" })).world;

  const returning = buildExplorationContext(world, "回到原来的地牢");
  assert.deepEqual(returning.activeRegionIds, ["qingyun", "gate"]);
  assert.equal(returning.modules.some((entry) => entry.id === "related:blackstone_cell"), false);
  const history = returning.modules.find((entry) => entry.kind === "history")!;
  assert.doesNotMatch(history.text, /blackstone_cell|黑石牢房/);
  const registry = JSON.parse(returning.modules.find((entry) => entry.kind === "registry")!.text) as {
    id: string; name: string; summary: string; state: Record<string, string>;
  }[];
  const entry = registry.find((entry) => entry.id === "blackstone_cell")!;
  assert.equal(entry.name, "黑石牢房");
  assert.match(entry.summary, /地牢/);
  assert.deepEqual(entry.state, { "牢门": "打开", "墙面标记": "玩家刻下的圆圈" });
  assert.match(returning.systemPrompt, /本轮抵达只依据目录中的简介与最新 state 描述/);
  assert.match(returning.systemPrompt, /events 仅是日志，不能替代持久记录/);

});

test("loaded regions preserve their earliest facts and opportunities after growing past former cutoffs", () => {
  let world = createInitialWorld("test-world");
  world = apply(world, draft({
    destinationId: "blackstone_cell",
    createRegions: [{
      ...region("blackstone_cell", "qingyun", "黑石牢房"),
      details: ["西墙最下方有一条通向旧水渠的狭缝。"],
      state: { "牢门": "打开" },
      opportunities: ["检查西墙狭缝。"],
    }],
  })).world;
  world = apply(world, draft({
    destinationId: "blackstone_cell",
    enrichRegions: [{
      id: "blackstone_cell",
      addDetails: Array.from({ length: 12 }, (_, index) => `牢房内确认的第 ${index + 2} 条环境细节。`),
      stateChanges: {},
      addOpportunities: Array.from({ length: 8 }, (_, index) => `可以检查第 ${index + 2} 处细节。`),
      reason: "继续调查牢房",
    }],
  })).world;
  world = apply(world, draft()).world;
  world = apply(world, draft({ destinationId: "blackstone_cell" })).world;
  const context = buildExplorationContext(world, "检查最初发现的西墙狭缝");
  const location = context.modules.find((entry) => entry.id === "location:blackstone_cell")!;
  const loaded = JSON.parse(location.text) as { details: string[]; opportunities: string[]; state: Record<string, string> };
  assert.equal(loaded.details.length, 13);
  assert.equal(loaded.details[0], "西墙最下方有一条通向旧水渠的狭缝。");
  assert.equal(loaded.state["牢门"], "打开");
  assert.equal(loaded.opportunities.length, 9);
  assert.equal(loaded.opportunities[0], "检查西墙狭缝。");
});
