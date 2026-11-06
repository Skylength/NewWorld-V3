import { createServer, type ServerResponse } from "node:http";
import { serveExplorationAsset } from "./assets.js";

function error(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: message }));
}

/** Separate UI development from a running world process. No model or save is duplicated. */
export function createConsoleServer(apiUrl: string) {
  const upstream = new URL(apiUrl);
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("工作台 API 必须指向本机 HTTP 服务根地址");
  }
  const reads = new Set(["/api/state", "/api/saves", "/api/export", "/api/npcs"]);
  const writes = new Set(["/api/turn", "/api/travel", "/api/cancel", "/api/new", "/api/load", "/api/npcs"]);
  return createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) || (request.headers.origin && request.headers.origin !== "http://" + host)) {
        error(response, 403, "仅允许本机同源访问"); return;
      }
      const url = new URL(request.url ?? "/", "http://" + host);
      if (request.method === "GET" && await serveExplorationAsset(url.pathname, response)) return;
      if (!(request.method === "GET" && reads.has(url.pathname)) && !(request.method === "POST" && writes.has(url.pathname))) {
        error(response, 404, "找不到该入口"); return;
      }
      if (upstream.host === host) { error(response, 502, "工作台不能将自身作为世界服务"); return; }
      let body = "";
      if (request.method === "POST") {
        if (!request.headers["content-type"]?.startsWith("application/json")) { error(response, 415, "请求必须是 JSON"); return; }
        request.setEncoding("utf8");
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 16_384) { error(response, 413, "请求过大"); return; }
        }
      }
      const result = await fetch(new URL(url.pathname + url.search, upstream), {
        method: request.method, headers: { "Content-Type": "application/json", Origin: upstream.origin },
        ...(request.method === "POST" ? { body } : {}), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (url.pathname === "/api/export") headers["Content-Disposition"] = 'attachment; filename="newworld-exploration.json"';
      const responseBody = await result.text();
      response.writeHead(result.status, headers);response.end(responseBody);
    })().catch(() => error(response, 502, "暂时无法连接世界服务。恢复连接后请核对运行与存档状态；工作台不会自动重发行动。"));
  });
}
