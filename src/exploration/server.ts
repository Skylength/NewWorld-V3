import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ExplorationError, ExplorationService } from "./service.js";
import { serveExplorationAsset } from "./assets.js";

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new ExplorationError("请求必须是 JSON", 415);
  request.setEncoding("utf8");
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 16_384) throw new ExplorationError("请求过大", 413);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ExplorationError("JSON 格式错误"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExplorationError("请求内容无效");
  return parsed as Record<string, unknown>;
}

export function createExplorationServer(service: ExplorationService) {
  return createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new ExplorationError("仅允许本机访问", 403);
      const origin = request.headers.origin;
      if (origin && origin !== "http://" + host) throw new ExplorationError("不允许跨站请求", 403);
      const url = new URL(request.url ?? "/", "http://" + host);
      if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, service.getView());
      if (request.method === "GET" && url.pathname === "/api/npcs") return json(response, 200, service.getNpcView());
      if (request.method === "GET" && url.pathname === "/api/saves") return json(response, 200, { saves: service.listSaves() });
      if (request.method === "GET" && url.pathname === "/api/export") {
        response.setHeader("Content-Disposition", 'attachment; filename="newworld-exploration.json"');
        return json(response, 200, service.exportSave());
      }
      if (request.method === "POST") {
        const payload = await body(request);
        if (url.pathname === "/api/npcs") {
          try { return json(response, 202, { runId: service.startNpcOperation(payload) }); }
          catch (error) { if (error instanceof ExplorationError) throw error; throw new ExplorationError(error instanceof Error ? error.message : "人物操作无效"); }
        }
        if (url.pathname === "/api/turn") {
          if (typeof payload.action !== "string") throw new ExplorationError("缺少行动文本");
          if (payload.mode !== undefined && payload.mode !== "interact" && payload.mode !== "explore") throw new ExplorationError("无效的行动模式");
          return json(response, 202, { runId: service.startTurn(payload.action, payload.mode ?? "interact") });
        }
        if (url.pathname === "/api/travel") {
          if (typeof payload.destinationId !== "string" || typeof payload.worldId !== "string" || typeof payload.baseRevision !== "number" || !Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0) throw new ExplorationError("地图迁移需要有效的地点、世界与版本");
          return json(response, 202, { runId: service.startTravel(payload.destinationId, payload.worldId, payload.baseRevision) });
        }
        if (url.pathname === "/api/cancel") return json(response, 200, { cancelled: service.cancel() });
        if (url.pathname === "/api/new") { service.newWorld(); return json(response, 200, service.getView()); }
        if (url.pathname === "/api/load") {
          if (typeof payload.worldId !== "string") throw new ExplorationError("缺少存档 ID");
          service.loadWorld(payload.worldId); return json(response, 200, service.getView());
        }
      }
      if (request.method === "GET" && await serveExplorationAsset(url.pathname, response)) return;
      json(response, 404, { error: "找不到该入口" });
    })().catch((error: unknown) => {
      json(response, error instanceof ExplorationError ? error.statusCode : 500, {
        error: error instanceof ExplorationError ? error.message : "本地服务无法完成请求，请检查服务日志与存档。",
      });
    });
  });
}
