import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import process from "node:process";
import { resolveModelRoutes } from "../src/agent/routing.js";
import { runActorReply } from "../src/actors/run-reply.js";
import type { ActorObservation } from "../src/actors/types.js";
import type { ActorRunEvent } from "../src/actors/run-reply.js";
import {
  createScenarioActorRepository,
  createScenarioMemoryReader,
  getScenario,
  getScenarioNames,
} from "../fixtures/npc-scenarios.js";

interface Arguments {
  scenario: string;
  observation?: string;
  trace: boolean;
  help: boolean;
}

function parseArguments(args: string[]): Arguments {
  const parsed: Arguments = { scenario: "recall-needed", trace: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scenario") parsed.scenario = args[++index] ?? "";
    else if (argument === "--observation") parsed.observation = args[++index] ?? "";
    else if (argument === "--trace") parsed.trace = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else throw new Error("未知参数：" + argument);
  }
  return parsed;
}

function printHelp(): void {
  console.log([
    "NPC 单次回应演示",
    "",
    "用法：npm run demo -- --scenario <名称> [--observation <文本>] [--trace]",
    "场景：" + getScenarioNames().join(", "),
    "环境变量：LLM_API_KEY；LLM_TEXT_MODEL 可选（默认 gpt-6.1-sol），LLM_BASE_URL 可选（默认 OpenAI /v1 地址）",
    "--trace 输出送模上下文、工具参数和工具回执；不会输出 API key 或模型思维过程。",
  ].join("\n"));
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const args = parseArguments(process.argv.slice(2));
  if (args.help) return printHelp();

  const scenario = getScenario(args.scenario);
  if (!scenario) throw new Error("找不到场景“" + args.scenario + "”。可选：" + getScenarioNames().join(", "));

  const model = resolveModelRoutes().text;
  if (!model) {
    throw new Error("请先配置 LLM_API_KEY（可复制 .env.example 为 .env）；未发送模型请求。");
  }

  const observation: ActorObservation = {
    source: "player",
    text: args.observation?.trim() || scenario.observation,
  };
  const result = await runActorReply({
    runId: randomUUID(),
    scope: scenario.scope,
    observation,
  }, {
    actorRepository: createScenarioActorRepository(scenario),
    memoryReader: createScenarioMemoryReader(args.scenario),
    model,
    ...(args.trace ? { onEvent: (event: ActorRunEvent) => console.log(JSON.stringify(event)) } : {}),
  });

  if (result.status === "completed") {
    console.log("\n" + scenario.actor.profile.name + "：" + result.reply);
    return;
  }

  console.error("\n本次运行" + result.status + "（" + result.code + "）：" + result.message);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
