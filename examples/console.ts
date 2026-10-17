import { createConsoleServer } from "../src/exploration/console-server.js";
const args = process.argv.slice(2);
let port = 4320;
let api = "http://127.0.0.1:4319";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--api") api = args[++i] ?? "";
  else throw new Error("未知参数：" + args[i]);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("工作台端口无效");
const server = createConsoleServer(api);
server.on("error", error => { console.error(error.message);process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`NewWorld 工作台：http://127.0.0.1:${port}/#debug\n连接世界服务：${api}（共用存档与模型运行）`));
process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
