import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { loadSuite, parseSuite } from "../src/acceptance/scenario.js";
import { parseJudgeResponse, JudgeError, type JudgePacket, type JudgeFunction } from "../src/acceptance/judge.js";
import { runAcceptance, acceptanceExitCode } from "../src/acceptance/runner.js";
import { createScriptedRuntime, reply, scriptedScenarioRuntime } from "../src/acceptance/scripted-model.js";
import { createReportDirectory, writeSuiteSummary, writeTrialReport } from "../src/acceptance/reports.js";

const passingJudge: JudgeFunction = async (packet) => ({
  checks: packet.criteria.map((criterion) => ({
    id: criterion.id, status: "PASS", reason: "测试裁判按已知证据返回。",
    evidenceRefs: ["reply"],
  })),
  rawResponse: "scripted judge, not a live model evaluation",
});

test("scenario manifest rejects duplicate IDs, missing criteria, unknown fixtures and path-like IDs", async () => {
  const scenarios = await loadSuite();
  assert.equal(scenarios.length, 3);
  assert.throws(() => parseSuite({ version: 1, scenarios: [scenarios[0], scenarios[0]] }), /Duplicate/);
  assert.throws(() => parseSuite({ version: 1, scenarios: [{ ...scenarios[0], fixture: "missing" }] }), /Unknown fixture/);
  assert.throws(() => parseSuite({ version: 1, scenarios: [{ ...scenarios[0], criteria: [] }] }), /criteria/);
  assert.throws(() => parseSuite({ version: 1, scenarios: [{ ...scenarios[0], id: "../escape" }] }), /Invalid/);
});

test("scripted suite runs all fixtures independently and labels semantic grading as skipped", async () => {
  const { summary, trials } = await runAcceptance({ mode: "scripted", trials: 2, scenarios: await loadSuite() });
  assert.deepEqual(summary.totals, { passed: 6, failed: 0, errors: 0, trials: 6 });
  assert.equal(summary.coverage, "mechanism-only");
  assert.equal(summary.models.judge, null);
  assert.equal(acceptanceExitCode(summary), 0);
  assert.equal(new Set(trials.map((trial) => trial.runId)).size, 6);
  assert.ok(trials.every((trial) => trial.judgeStatus === "skipped" && !trial.judgePacket));
  assert.ok(trials.every((trial) => trial.codeChecks.every((check) => check.status === "PASS")));
});

test("hard failure cannot be overridden by a passing LLM judge", async () => {
  let judgeCalls = 0;
  const judge: JudgeFunction = async (packet) => { judgeCalls += 1; return passingJudge(packet); };
  const { summary, trials } = await runAcceptance({
    mode: "live", trials: 1, scenarios: (await loadSuite()).slice(0, 1), judge,
    runtimeFactory: () => createScriptedRuntime([() => reply("账本在北仓第三块松动的地砖下。")]).runtime,
  });
  assert.equal(summary.totals.failed, 1);
  assert.equal(judgeCalls, 0);
  assert.equal(trials[0]?.judgeStatus, "skipped");
  assert.equal(trials[0]?.codeChecks.find((check) => check.id === "no-foreign-secrets")?.status, "FAIL");
  assert.equal(acceptanceExitCode(summary), 1);
});

test("repeated live-mode trials retain every semantic failure rather than selecting a success", async () => {
  let calls = 0;
  const { summary, trials } = await runAcceptance({
    mode: "live", trials: 3, scenarios: (await loadSuite()).slice(0, 1),
    runtimeFactory: (scenario) => scriptedScenarioRuntime(scenario.fixture),
    judge: async (packet) => {
      const assessment = await passingJudge(packet);
      if (calls++ === 1) assessment.checks[0]!.status = "FAIL";
      return assessment;
    },
  });
  assert.deepEqual(summary.totals, { passed: 2, failed: 1, errors: 0, trials: 3 });
  assert.equal(summary.scenarios[0]?.passRate, 2 / 3);
  assert.deepEqual(trials.map((trial) => trial.status), ["PASS", "FAIL", "PASS"]);
  assert.ok(trials[0]?.judgePacket?.evidence.recall_results);
  assert.equal(acceptanceExitCode(summary), 1);
});

test("provider and judge failures are ERROR, distinct from behavior FAIL", async () => {
  const scenarios = (await loadSuite()).slice(0, 1);
  const actorError = await runAcceptance({
    mode: "live", trials: 1, scenarios, judge: passingJudge,
    runtimeFactory: () => createScriptedRuntime([() => ({
      content: [], stopReason: "error", errorMessage: "network failed",
    })]).runtime,
  });
  assert.equal(actorError.trials[0]?.status, "ERROR");
  assert.equal(actorError.trials[0]?.error?.stage, "actor");
  const judgeError = await runAcceptance({
    mode: "live", trials: 1, scenarios,
    runtimeFactory: (scenario) => scriptedScenarioRuntime(scenario.fixture),
    judge: async () => { throw new JudgeError("invalid JSON", "bad raw response"); },
  });
  assert.equal(judgeError.trials[0]?.status, "ERROR");
  assert.equal(judgeError.trials[0]?.error?.stage, "judge");
  assert.equal(judgeError.trials[0]?.rawJudgeResponse, "bad raw response");
  assert.equal(acceptanceExitCode(judgeError.summary), 2);
});

test("judge results must cover each criterion with valid evidence IDs", () => {
  const packet: JudgePacket = {
    scenarioId: "case", criteria: [{ id: "a", criterion: "must be grounded" }],
    evidence: { reply: "test reply" },
  };
  const valid = { id: "a", status: "PASS", reason: "grounded", evidenceRefs: ["reply"] };
  assert.equal(parseJudgeResponse(packet, JSON.stringify({ results: [valid] }))[0]?.status, "PASS");
  for (const results of [
    [],
    [valid, valid],
    [{ ...valid, id: "unknown" }],
    [{ ...valid, evidenceRefs: ["nonexistent"] }],
    [{ ...valid, evidenceRefs: [] }],
    [{ ...valid, status: "BLOCKED" }],
  ]) {
    assert.throws(() => parseJudgeResponse(packet, JSON.stringify({ results })), JudgeError);
  }
});

test("an injected judge cannot silently pass with missing checks", async () => {
  const result = await runAcceptance({
    mode: "live", trials: 1, scenarios: (await loadSuite()).slice(0, 1),
    runtimeFactory: (scenario) => scriptedScenarioRuntime(scenario.fixture),
    judge: async () => ({ checks: [], rawResponse: "{}" }),
  });
  assert.equal(result.summary.totals.errors, 1);
});

test("live preflight fails before any request when configuration is missing", async () => {
  await assert.rejects(runAcceptance({ mode: "live", trials: 1, scenarios: await loadSuite() }), /LLM_API_KEY/);
  await assert.rejects(runAcceptance({ mode: "scripted", trials: 0, scenarios: await loadSuite() }), /trials/);
});

test("reports preserve failures, traces and raw judge errors while redacting credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "newworld-acceptance-"));
  try {
    const outcome = await runAcceptance({
      mode: "live", trials: 1, scenarios: (await loadSuite()).slice(0, 1),
      runtimeFactory: (scenario) => scriptedScenarioRuntime(scenario.fixture),
      judge: async () => { throw new JudgeError("failure key-secret-123", "raw key-secret-123"); },
    });
    const directory = await createReportDirectory(root);
    const report = outcome.trials[0]!;
    await writeTrialReport(directory, report, ["key-secret-123"]);
    await writeSuiteSummary(directory, outcome.summary, "revision-test", ["key-secret-123"]);
    const trialDirectory = join(directory, report.scenarioId, "trial-1");
    const saved = await readFile(join(trialDirectory, "trial.json"), "utf8");
    assert.match(saved, /\[REDACTED\]/);
    assert.doesNotMatch(saved, /key-secret-123/);
    assert.match(await readFile(join(trialDirectory, "judge_response.txt"), "utf8"), /\[REDACTED\]/);
    assert.match(await readFile(join(trialDirectory, "trace.ndjson"), "utf8"), /model_request_started/);
    assert.match(await readFile(join(directory, "summary.md"), "utf8"), /ERROR 1/);
    assert.equal(JSON.parse(await readFile(join(directory, "summary.json"), "utf8")).revision, "revision-test");
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("newworld-acceptance-"));
    await rm(target, { recursive: true, force: true });
  }
});
