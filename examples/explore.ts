import process from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ExplorationService } from "../src/exploration/service.js";
import { createExplorationServer } from "../src/exploration/server.js";
import { resolveModelRoutes } from "../src/agent/routing.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
let port = 4318;
let directory = "data/exploration";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--data") directory = args[++i] ?? "";
  else throw new Error("未知参数：" + args[i]);
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || !directory) throw new Error("端口或存档路径无效");
const routes = resolveModelRoutes();
const service = new ExplorationService({
  directory: resolve(directory),
  ...(routes.structure && routes.text ? { model: routes.structure, textModel: routes.text } : {}),
});
const server = createExplorationServer(service);
server.on("error", error => { console.error("探索服务启动失败：" + error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`NewWorld 动态区域探索：http://127.0.0.1:${port}`);
  console.log(routes.structure && routes.text ? `结构：${routes.structure.modelId}；文本/NPC：${routes.text.modelId}。区域生成最多两次请求；独立NPC按需决策，每次最多两次，整段推进最多六次激活。` : "模型未配置：请设置 .env 的 LLM_API_KEY 后重启。");
});
const stop = () => { service.cancel(); server.close(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
