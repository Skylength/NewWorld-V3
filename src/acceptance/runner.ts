import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createScenarioFixture } from "../../fixtures/npc-scenarios.js";
import type { ScenarioFixture } from "../../fixtures/npc-scenarios.js";
import { runActorReply, type ActorRunEvent, type ActorRunLimits } from "../actors/run-reply.js";
import type { ActorRunResult } from "../actors/types.js";
import type { PiModelRuntime } from "../agent/runtime.js";
import type { ModelConfig } from "../agent/model.js";
import { gradeHardChecks, type CheckResult } from "./checks.js";
import { createModelJudge, parseJudgeResponse, JudgeError, type JudgeFunction, type JudgePacket } from "./judge.js";
import { digest, type AcceptanceScenario } from "./scenario.js";
import { scriptedScenarioRuntime } from "./scripted-model.js";

const packageVersion = (name: string) => (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.resolve(name)), "utf8"),
) as { version: string }).version;
const piAgentVersion = packageVersion("@earendil-works/pi-agent-core");
const piAiVersion = packageVersion("@earendil-works/pi-ai");

export type AcceptanceMode = "scripted" | "live";
export type TrialStatus = "PASS" | "FAIL" | "ERROR";
export interface TrialReport {
  runId: string;
  scenarioId: string;
  trial: number;
  mode: AcceptanceMode;
  coverage: "mechanism-only" | "model-behavior";
  status: TrialStatus;
  result: ActorRunResult;
  codeChecks: CheckResult[];
  semanticChecks: CheckResult[];
  judgeStatus: "scored" | "skipped" | "error";
  judgePacket?: JudgePacket;
  rawJudgeResponse?: string;
  error?: { stage: "actor" | "judge"; message: string };
  durationMs: number;
  scenarioHash: string;
  promptHash: string;
  events: ActorRunEvent[];
  reads: ScenarioFixture["reads"];
  before: ReturnType<ScenarioFixture["snapshot"]>;
  after: ReturnType<ScenarioFixture["snapshot"]>;
}

export interface SuiteSummary {
  version: 1;
  mode: AcceptanceMode;
  coverage: TrialReport["coverage"];
  createdAt: string;
  manifestHash: string;
  models: { actor: string; judge: string | null };
  versions: { node: string; piAgentCore: string; piAi: string };
  limits: ActorRunLimits;
  trialsPerScenario: number;
  totals: { passed: number; failed: number; errors: number; trials: number };
  scenarios: Array<{ id: string; passed: number; failed: number; errors: number; trials: number; passRate: number }>;
}

export interface AcceptanceOptions {
  mode: AcceptanceMode;
  trials: number;
  scenarios: AcceptanceScenario[];
  model?: ModelConfig;
  judgeModel?: ModelConfig;
  limits?: Partial<ActorRunLimits>;
  signal?: AbortSignal;
  onTrial?: (report: TrialReport) => void | Promise<void>;
  /** Injection hooks for testing the evaluator, not exposed by the CLI. */
  runtimeFactory?: (scenario: AcceptanceScenario) => PiModelRuntime;
  judge?: JudgeFunction;
}

function buildPacket(scenario: AcceptanceScenario, fixture: ScenarioFixture, result: ActorRunResult): JudgePacket {
  return {
    scenarioId: scenario.id,
    criteria: scenario.criteria,
    evidence: {
      actor_profile: fixture.scenario.actor.profile,
      visible_facts: fixture.scenario.actor.visibleFacts,
      observation: fixture.scenario.observation,
      recall_results: fixture.reads.map((read) => ({
        query: read.query, hits: read.hits ?? [], ...(read.error ? { error: read.error } : {}),
      })),
      reply: result.status === "completed" ? result.reply : null,
    },
  };
}

export async function runAcceptance(options: AcceptanceOptions): Promise<{ summary: SuiteSummary; trials: TrialReport[] }> {
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 20) throw new Error("trials 必须是 1 到 20 的整数");
  if (!options.scenarios.length) throw new Error("没有选中的验收场景");
  if (options.mode === "live" && !options.runtimeFactory && (!options.model?.apiKey.trim() || !options.model.modelId.trim())) {
    throw new Error("live 验收需要 LLM_API_KEY 和 LLM_MODEL；未发送任何请求");
  }
  if (options.mode === "live" && !options.judge && (!options.judgeModel?.apiKey.trim() || !options.judgeModel.modelId.trim())) {
    throw new Error("live 验收需要配置裁判模型与凭据；未发送任何请求");
  }
  const limits = { maxModelRequests: 4, maxToolCalls: 3, timeoutMs: 120_000, ...options.limits };
  const judge = options.mode === "live"
    ? options.judge ?? createModelJudge(options.judgeModel!)
    : undefined;
  const trials: TrialReport[] = [];
  for (const scenario of options.scenarios) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      options.signal?.throwIfAborted();
      const fixture = createScenarioFixture(scenario.fixture);
      const before = fixture.snapshot();
      const events: ActorRunEvent[] = [];
      const runId = randomUUID();
      const startedAt = performance.now();
      const runtime = options.runtimeFactory?.(scenario) ??
        (options.mode === "scripted" ? scriptedScenarioRuntime(scenario.fixture) : undefined);
      const result = await runActorReply({
        runId, scope: fixture.scenario.scope,
        observation: { source: "player", text: fixture.scenario.observation },
      }, {
        actorRepository: fixture.actorRepository,
        memoryReader: fixture.memoryReader,
        ...(runtime ? { modelRuntime: runtime } : { model: options.model! }),
        limits,
        ...(options.signal ? { signal: options.signal } : {}),
        onEvent: (event) => events.push(JSON.parse(JSON.stringify(event)) as ActorRunEvent),
      });
      const codeChecks = gradeHardChecks(fixture, before, result, events, limits);
      const report: TrialReport = {
        runId, scenarioId: scenario.id, trial, mode: options.mode,
        coverage: options.mode === "scripted" ? "mechanism-only" : "model-behavior",
        status: codeChecks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
        result, codeChecks, semanticChecks: [], judgeStatus: "skipped",
        durationMs: 0,
        scenarioHash: digest({ scenario, before }),
        promptHash: digest(events.find((event) => event.type === "model_request_started")?.systemPrompt ?? ""),
        events, reads: fixture.reads, before, after: fixture.snapshot(),
      };
      if ((result.status === "failed" && ["model_error", "run_failed", "missing_model_config"].includes(result.code)) || result.status === "aborted") {
        report.status = "ERROR";
        report.error = { stage: "actor", message: result.message };
      } else if (judge && report.status === "PASS") {
        const packet = buildPacket(scenario, fixture, result);
        report.judgePacket = packet;
        try {
          const assessment = await judge(packet, options.signal);
          report.rawJudgeResponse = assessment.rawResponse;
          report.semanticChecks = parseJudgeResponse(packet, JSON.stringify({ results: assessment.checks }));
          report.judgeStatus = "scored";
          report.status = report.semanticChecks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
        } catch (error) {
          report.status = "ERROR";
          report.judgeStatus = "error";
          report.error = { stage: "judge", message: error instanceof Error ? error.message : String(error) };
          if (error instanceof JudgeError && report.rawJudgeResponse === undefined) report.rawJudgeResponse = error.rawResponse;
        }
      }
      report.durationMs = Math.round(performance.now() - startedAt);
      trials.push(report);
      await options.onTrial?.(report);
    }
  }
  const count = (items: TrialReport[]) => ({
    passed: items.filter((item) => item.status === "PASS").length,
    failed: items.filter((item) => item.status === "FAIL").length,
    errors: items.filter((item) => item.status === "ERROR").length,
    trials: items.length,
  });
  return {
    trials,
    summary: {
      version: 1, mode: options.mode,
      coverage: options.mode === "scripted" ? "mechanism-only" : "model-behavior",
      createdAt: new Date().toISOString(),
      manifestHash: digest(options.scenarios),
      models: {
        actor: options.mode === "scripted" ? "scripted-npc" : options.model?.modelId ?? "injected-test-runtime",
        judge: options.mode === "scripted" ? null : options.judgeModel?.modelId ?? "injected-test-judge",
      },
      versions: { node: process.version, piAgentCore: piAgentVersion, piAi: piAiVersion },
      limits, trialsPerScenario: options.trials,
      totals: count(trials),
      scenarios: options.scenarios.map((scenario) => {
        const tally = count(trials.filter((trial) => trial.scenarioId === scenario.id));
        return { id: scenario.id, ...tally, passRate: tally.passed / tally.trials };
      }),
    },
  };
}

export function acceptanceExitCode(summary: SuiteSummary): number {
  return summary.totals.errors > 0 ? 2 : summary.totals.failed > 0 ? 1 : 0;
}
