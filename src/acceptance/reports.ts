import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SuiteSummary, TrialReport } from "./runner.js";

function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

export async function createReportDirectory(root = "reports/acceptance"): Promise<string> {
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "_" + randomUUID().slice(0, 8);
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function writeTrialReport(directory: string, report: TrialReport, secrets: readonly string[] = []): Promise<void> {
  const destination = join(directory, report.scenarioId, "trial-" + report.trial);
  await mkdir(destination, { recursive: true });
  const write = (name: string, text: string) => writeFile(join(destination, name), redact(text, secrets), "utf8");
  await write("trial.json", JSON.stringify(report, null, 2));
  await write("trace.ndjson", report.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  if (report.judgePacket) await write("judge_packet.json", JSON.stringify(report.judgePacket, null, 2));
  if (report.rawJudgeResponse !== undefined) await write("judge_response.txt", report.rawJudgeResponse);
  const lines = [
    "# " + report.scenarioId + " / trial " + report.trial,
    "",
    "状态：" + report.status + "；模式：" + report.mode + "；覆盖范围：" + report.coverage,
    "",
    "角色结果：" + report.result.status,
    "",
    report.result.status === "completed" ? report.result.reply : report.result.message,
    "",
    "## 硬性检查",
    "",
    ...report.codeChecks.map((check) => "- " + check.status + " " + check.id + "：" + check.reason),
    "",
    "## 语义检查",
    "",
    report.judgeStatus === "scored" ? "裁判已评分。" : "裁判状态：" + report.judgeStatus + "（scripted 模式或硬性检查失败时不评分）",
    "",
    ...report.semanticChecks.map((check) => "- " + check.status + " " + check.id + "：" + check.reason + "；证据：" + check.evidenceRefs.join(", ")),
    ...(report.error ? ["", "## 执行错误", "", report.error.stage + "：" + report.error.message] : []),
    "",
    "详情见同目录 trial.json 与 trace.ndjson。scripted PASS 只证明程序机制，不证明真实角色表现。",
  ];
  await write("report.md", lines.join("\n") + "\n");
}

export async function writeSuiteSummary(
  directory: string,
  summary: SuiteSummary,
  revision: string | null,
  secrets: readonly string[] = [],
): Promise<void> {
  await writeFile(join(directory, "summary.json"), redact(JSON.stringify({ ...summary, revision }, null, 2), secrets), "utf8");
  const lines = [
    "# NPC 自动验收",
    "",
    "模式：" + summary.mode + "；覆盖范围：" + summary.coverage,
    "",
    "Actor：" + summary.models.actor + "；Judge：" + (summary.models.judge ?? "未调用"),
    "",
    "PASS " + summary.totals.passed + " / FAIL " + summary.totals.failed + " / ERROR " + summary.totals.errors,
    "",
    "| 场景 | 通过／全部运行 | 失败 | 执行错误 |",
    "| --- | --- | --- | --- |",
    ...summary.scenarios.map((scenario) => "| " + scenario.id + " | " + scenario.passed + "/" + scenario.trials + " | " + scenario.failed + " | " + scenario.errors + " |"),
    "",
    "保留每次运行，没有挑选成功样本。少量试验的通过率是观察值，不是稳定性保证。",
  ];
  await writeFile(join(directory, "summary.md"), redact(lines.join("\n") + "\n", secrets), "utf8");
}
