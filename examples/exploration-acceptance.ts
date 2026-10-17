import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { ExplorationService } from "../src/exploration/service.js";
import { createScriptedRuntime, reply } from "../src/acceptance/scripted-model.js";
import type { WorldTurnDraft } from "../src/exploration/types.js";
import { resolveModelRoutes } from "../src/agent/routing.js";

const actions = [
  "离开宗门，快进到南疆的一个渡口。让我到达并观察当地。",
  "我留在这个渡口，仔细查看岸边建筑、渡船与行人的活动，寻找值得进一步了解的细节。",
  "我捡起一块小石头，在岸边一块普通木牌背面刻下“归途记号-青禾”，作为以后辨认的标记。",
  "我离开整个南疆，快进到青云宗山脚一处此前没有探索过的小茶棚坐一会儿。",
  "我回到之前南疆的那个渡口，检查木牌背面的“归途记号-青禾”是否还在。",
];
const base = (destinationId: string, narration: string): WorldTurnDraft => ({ narration, elapsedMinutes: 5, destinationId, createRegions: [], enrichRegions: [], events: [] });
function scriptedDrafts(): WorldTurnDraft[] {
  return [
    { ...base("ferry", "你抵达南疆渡口，岸边停着一艘渡船。"), createRegions: [
      { id: "south", name: "南疆", parentId: null, summary: "温暖潮湿的南方地域。", details: [], state: {}, opportunities: [] },
      { id: "ferry", name: "青水渡", parentId: "south", summary: "通向南疆内陆的渡口。", details: ["河岸停着渡船。"], state: {}, opportunities: ["可以观察码头。"] },
    ] },
    { ...base("ferry", "你看见渡船船头系着一串铜铃，旧木牌上贴着渡船时刻。"), enrichRegions: [
      { id: "ferry", addDetails: ["渡船船头系着铜铃。", "岸边有一块旧木牌。"], stateChanges: {}, addOpportunities: ["可以查看木牌。"], reason: "玩家调查当地" },
    ] },
    { ...base("ferry", "你在木牌背面刻下归途记号-青禾。"), enrichRegions: [
      { id: "ferry", addDetails: [], stateChanges: { "木牌背面": "刻着归途记号-青禾" }, addOpportunities: [], reason: "玩家留下标记" },
    ] },
    { ...base("tea", "你离开南疆，回到青云宗山脚的一处茶棚。"), createRegions: [
      { id: "tea", name: "山脚茶棚", parentId: "qingyun", summary: "青云宗山脚的一处茶棚。", details: ["棚下摆着木凳。"], state: {}, opportunities: ["可以坐下喝茶。"] },
    ] },
    base("ferry", "你回到青水渡，木牌背面的归途记号-青禾仍在。"),
  ];
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const args = process.argv.slice(2);
  let mode = "scripted";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i] ?? "";
    else throw new Error("未知参数：" + args[i]);
  }
  if (mode !== "scripted" && mode !== "live") throw new Error("mode 必须是 scripted 或 live");
  const routes = resolveModelRoutes();
  if (mode === "live" && (!routes.structure || !routes.text)) throw new Error("真实模型验收缺少模型配置，未发送请求。");
  const directory = resolve("reports/exploration", new Date().toISOString().replace(/[:.]/g, "-") + "-" + mode + "-" + randomUUID().slice(0, 6));
  mkdirSync(directory, { recursive: true });
  const service = new ExplorationService({
    directory: join(directory, "saves"),
    ...(mode === "scripted" ? {
      modelRuntime: createScriptedRuntime(scriptedDrafts().map(draft => () => reply(JSON.stringify(draft)))).runtime,
      textModelRuntime: createScriptedRuntime(scriptedDrafts().map(draft => () => reply(draft.narration))).runtime,
    } : { model: routes.structure!, textModel: routes.text! }),
  });
  const results: { step: number; status: string; checks: { name: string; passed: boolean }[]; error: string | null }[] = [];
  let firstDestination = "";
  let firstRegionName = "";
  let failed = false;
  const onInterrupt = () => service.cancel();
  process.on("SIGINT", onInterrupt);
  try {
    for (const [index, action] of actions.entries()) {
      const before = service.exportSave().world;
      console.log(`${mode} ${index + 1}/5：${action}`);
      service.startTurn(action);
      await service.waitForIdle();
      const view = service.getView();
      const run = view.runs.at(-1)!;
      const checks = [
        { name: "回合完整提交", passed: run.status === "completed" },
        { name: "结构与文本各一次请求", passed: run.modelRequests === 2 && run.calls?.length === 2 && run.calls.every(c => c.modelRequests === 1) },
        { name: "位置上下文对应存档", passed: view.nextContext.activeRegionIds.includes(view.world.playerLocationId) },
      ];
      if (index === 0) {
        firstDestination = view.world.playerLocationId;
        firstRegionName = view.world.regions.find(r => r.id === firstDestination)?.name ?? "";
        checks.push({ name: "动态创建并抵达新地点", passed: !before.regions.some(r => r.id === firstDestination) && view.world.regions.length > before.regions.length });
      } else if (index === 1) {
        checks.push({ name: "在原地点逐渐丰富", passed: view.world.playerLocationId === firstDestination && run.changes.some(c => c.regionId === firstDestination && (c.kind === "enriched" || c.kind === "state")) });
      } else if (index === 2) {
        checks.push({ name: "环境变化写入持续状态", passed: JSON.stringify(view.world.regions.find(r => r.id === firstDestination)?.state).includes("归途记号-青禾") });
      } else if (index === 3) {
        checks.push({ name: "离开并创建新落脚点", passed: view.world.playerLocationId !== firstDestination && view.world.regions.length > before.regions.length });
        checks.push({ name: "旧地区从当前位置上下文卸载", passed: !view.nextContext.activeRegionIds.includes(firstDestination) });
      } else {
        checks.push({ name: "返回复用原地点", passed: view.world.playerLocationId === firstDestination && view.world.regions.filter(r => r.name === firstRegionName).length === 1 });
        checks.push({ name: "返回仍保留改变", passed: JSON.stringify(view.world.regions.find(r => r.id === firstDestination)?.state).includes("归途记号-青禾") });
      }
      const status = run.status !== "completed" ? "ERROR" : checks.every(c => c.passed) ? "PASS" : "FAIL";
      failed ||= status !== "PASS";
      results.push({ step: index + 1, status, checks, error: run.error });
      writeFileSync(join(directory, `step-${index + 1}.json`), JSON.stringify({ action, run, world: view.world, nextContext: view.nextContext, checks }, null, 2), "utf8");
      console.log(`${status}，${run.durationMs}ms，${run.usage?.totalTokens ?? "unknown"} tokens`);
      if (run.status !== "completed") break;
    }
  } finally { process.removeListener("SIGINT", onInterrupt); }
  const saved = service.exportSave();
  const usage = saved.runs.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);
  const summary = { mode, status: failed ? "FAIL" : "PASS", model: service.getView().config.model, results, requests: saved.runs.reduce((n, r) => n + r.modelRequests, 0), knownTokens: usage, semanticReview: "not-automated", note: mode === "scripted" ? "机制验证，不证明真实模型行为" : "真实模型五步探索；开放叙述合理性仍需阅读样本与用户试玩" };
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ status: summary.status, report: directory, requests: summary.requests, knownTokens: usage }));
  if (failed) process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
