import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadSuite } from "../src/acceptance/scenario.js";
import { runAcceptance, acceptanceExitCode, type AcceptanceMode } from "../src/acceptance/runner.js";
import { createReportDirectory, writeSuiteSummary, writeTrialReport } from "../src/acceptance/reports.js";
import type { ModelConfig } from "../src/agent/model.js";
import { resolveModelRoutes } from "../src/agent/routing.js";

function argumentsFrom(args: string[]) {
  const parsed = { mode: "scripted" as AcceptanceMode, trials: undefined as number | undefined,
    scenario: undefined as string | undefined, tag: undefined as string | undefined,
    suite: undefined as string | undefined, output: "reports/acceptance", list: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mode") {
      const mode = args[++index];
      if (mode !== "scripted" && mode !== "live") throw new Error("--mode 必须是 scripted 或 live");
      parsed.mode = mode;
    } else if (argument === "--trials") parsed.trials = Number(args[++index]);
    else if (argument === "--scenario") parsed.scenario = args[++index] ?? "";
    else if (argument === "--tag") parsed.tag = args[++index] ?? "";
    else if (argument === "--suite") parsed.suite = args[++index] ?? "";
    else if (argument === "--output") parsed.output = args[++index] ?? "";
    else if (argument === "--list") parsed.list = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else throw new Error("未知参数：" + argument);
  }
  return parsed;
}

function liveConfiguration(): { actor: ModelConfig; judge: ModelConfig } {
  const routes = resolveModelRoutes();
  if (!routes.text || !routes.judge) {
    throw new Error("live 需要 LLM_API_KEY；未发送任何模型请求。");
  }
  return { actor: routes.text, judge: routes.judge };
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) {
    console.log("用法：npm run acceptance -- --mode scripted|live [--trials 3] [--scenario id] [--tag memory] [--list]");
    console.log("scripted 不调用 API，仅验收机制；live 调用角色与裁判模型，每场景默认 3 次。退出码：0 全通过、1 功能失败、2 执行错误。");
    return;
  }
  let scenarios = await loadSuite(args.suite);
  if (args.scenario !== undefined) scenarios = scenarios.filter((scenario) => scenario.id === args.scenario);
  if (args.tag !== undefined) scenarios = scenarios.filter((scenario) => scenario.tags.includes(args.tag!));
  if (!scenarios.length) throw new Error("没有匹配的验收场景");
  if (args.list) {
    console.log(scenarios.map((scenario) => scenario.id + " [" + scenario.tags.join(", ") + "]").join("\n"));
    return;
  }
  const trials = args.trials ?? (args.mode === "live" ? 3 : 1);
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("--trials 必须是 1 到 20 的整数");
  const config = args.mode === "live" ? liveConfiguration() : undefined;
  const secrets = config ? [config.actor.apiKey, config.judge.apiKey] : [];
  const directory = await createReportDirectory(args.output);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("CLI interrupted"));
  process.once("SIGINT", cancel);
  try {
    const { summary } = await runAcceptance({
      mode: args.mode, trials, scenarios, signal: controller.signal,
      ...(config ? { model: config.actor, judgeModel: config.judge } : {}),
      onTrial: async (report) => {
        await writeTrialReport(directory, report, secrets);
        console.log(report.status + " " + report.scenarioId + " #" + report.trial + " [" + report.coverage + "]");
      },
    });
    let revision: string | null = process.env.GITHUB_SHA ?? null;
    if (!revision) {
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { revision = null; }
    }
    await writeSuiteSummary(directory, summary, revision, secrets);
    console.log("报告：" + directory);
    console.log("PASS " + summary.totals.passed + " / FAIL " + summary.totals.failed + " / ERROR " + summary.totals.errors);
    process.exitCode = acceptanceExitCode(summary);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  const safe = [process.env.LLM_API_KEY, process.env.ACCEPTANCE_JUDGE_API_KEY]
    .filter((secret): secret is string => Boolean(secret))
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
  console.error("ERROR：" + safe);
  process.exitCode = 2;
});
