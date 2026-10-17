import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createScriptedRuntime, reply } from "../src/acceptance/scripted-model.js";
import { createConsoleServer } from "../src/exploration/console-server.js";
import { createExplorationServer } from "../src/exploration/server.js";
import { ExplorationService } from "../src/exploration/service.js";
import type { ExplorationView, WorldTurnDraft } from "../src/exploration/types.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
async function proxy(t: TestContext, upstream: string): Promise<string> {
  const server = createConsoleServer(upstream);
  const base = await listen(server);
  t.after(() => close(server));
  return base;
}
const post = (base: string, path: string, payload: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload),
});

test("console and original API share the same world; a submitted turn reaches the existing model loop exactly once", { timeout: 8000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "newworld-console-proxy-"));
  const update: WorldTurnDraft = {
    narration: "山门石碑背面留下一个圆圈。", elapsedMinutes: 1, destinationId: "gate", createRegions: [],
    enrichRegions: [{ id: "gate", addDetails: [], stateChanges: { 标记: "圆圈" }, addOpportunities: [], reason: "玩家留下记号" }], events: ["留下记号"],
  };
  const structure = createScriptedRuntime([() => reply(JSON.stringify(update))]);
  const narration = createScriptedRuntime([() => reply("你在山门石碑背面留下了一个圆圈。")]);
  const service = new ExplorationService({ directory, modelRuntime: structure.runtime, textModelRuntime: narration.runtime });
  const upstream = createExplorationServer(service);
  const requests: string[] = [];
  upstream.on("request", req => { requests.push(`${req.method} ${req.url}`); });
  const source = await listen(upstream);
  const server = createConsoleServer(source);
  const base = await listen(server);
  t.after(async () => {
    service.cancel();
    await service.waitForIdle();
    await close(server);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  const original = await (await fetch(source + "/api/state")).json() as ExplorationView;
  const proxied = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.deepEqual(proxied, original);
  const response = await post(base, "/api/turn", { action: "在山门石碑背面留下圆圈" }, { Origin: base });
  assert.equal(response.status, 202);
  const { runId } = await response.json() as { runId: string };
  await service.waitForIdle();
  const after = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.equal(after.world.id, original.world.id);
  assert.equal(after.world.revision, original.world.revision + 1);
  assert.equal(after.world.regions.find(region => region.id === "gate")?.state["标记"], "圆圈");
  assert.equal(after.runs[0]?.id, runId);
  assert.deepEqual(after, await (await fetch(source + "/api/state")).json());
  assert.equal(requests.filter(value => value === "POST /api/turn").length, 1);
  assert.equal(structure.requests.length, 1);
  assert.equal(narration.requests.length, 1);
  const exported = await fetch(base + "/api/export");
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
  assert.deepEqual(await exported.json(), service.exportSave());
  assert.deepEqual(await (await fetch(base + "/api/saves")).json(), { saves: service.listSaves() });
});

test("console serves its own browser ES module with MIME, no-store, and a restrictive CSP without contacting the world", async t => {
  let requests = 0;
  const upstream = createServer((_req, response) => { requests++; response.end("{}"); });
  const source = await listen(upstream);
  t.after(() => close(upstream));
  const base = await proxy(t, source);
  for (const [path, mime] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/debug-data.js", "text/javascript"], ["/style.css", "text/css"]] as const) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith(mime));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const body = await response.text();
    assert.ok(body.length > 0);
    if (path === "/debug-data.js") assert.match(body, /export function deriveStages/);
    if (path === "/") assert.match(body, /type="module"/);
  }
  assert.equal(requests, 0, "UI assets must come from this process, not the older world server");
});

test("untrusted Host and Origin are rejected before either reads or writes reach upstream", async t => {
  let requests = 0;
  const upstream = createServer((_req, response) => { requests++; response.end("{}"); });
  const source = await listen(upstream);
  t.after(() => close(upstream));
  const base = await proxy(t, source);
  for (const origin of ["https://example.invalid", "http://localhost:1", "null"]) {
    assert.equal((await fetch(base + "/api/state", { headers: { Origin: origin } })).status, 403);
    assert.equal((await post(base, "/api/new", {}, { Origin: origin })).status, 403);
  }
  for (const host of ["example.invalid", "127.0.0.1.example.invalid", "localhost@evil.invalid"]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + "/api/state", { headers: { Host: host } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
  }
  assert.equal(requests, 0);
  assert.equal((await fetch(base + "/api/state", { headers: { Origin: base } })).status, 200);
  assert.equal(requests, 1);
});

test("only a loopback HTTP root may be selected as the upstream", () => {
  for (const url of [
    "https://127.0.0.1:4319/", "http://example.invalid/", "http://127.0.0.1.example.invalid/", "file:///tmp/state",
    "http://127.0.0.1:4319/api/state", "http://127.0.0.1:4319/?query=1", "http://127.0.0.1:4319/#fragment",
    "http://user:password@127.0.0.1:4319/",
  ]) assert.throws(() => createConsoleServer(url), /本机 HTTP 服务根地址/);
  assert.throws(() => createConsoleServer("not a URL"));
  for (const url of ["http://127.0.0.1:4319", "http://localhost:4319/", "http://[::1]:4319/"]) {
    const server = createConsoleServer(url);
    assert.equal(server.listening, false);
  }
});

test("unknown routes, unsupported methods, and non-JSON or oversized posts are stopped locally", async t => {
  let requests = 0;
  const upstream = createServer((_req, response) => { requests++; response.end("{}"); });
  const source = await listen(upstream);
  t.after(() => close(upstream));
  const base = await proxy(t, source);
  for (const path of ["/api/unknown", "/src/exploration/service.ts", "/package.json", "/%2e%2e%2fpackage.json", "/api/turn"]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await post(base, "/api/state", {})).status, 404);
  assert.equal((await fetch(base + "/api/state", { method: "DELETE" })).status, 404);
  assert.equal((await post(base, "/api/new", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(base + "/api/new", { method: "POST" })).status, 415);
  assert.equal((await post(base, "/api/turn", { action: "字".repeat(6000) })).status, 413);
  assert.equal(requests, 0);
});

test("upstream business errors preserve their status and content, query and body, and are not retried", async t => {
  const seen: { method: string | undefined; url: string | undefined; origin: string | undefined; body: string }[] = [];
  const upstream = createServer((req, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, body });
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "已有正在执行的回合" }));
    })();
  });
  const source = await listen(upstream);
  t.after(() => close(upstream));
  const base = await proxy(t, source);
  const payload = { action: "查看石碑" };
  const response = await post(base, "/api/turn?trace=visible", payload);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "已有正在执行的回合" });
  assert.deepEqual(seen, [{ method: "POST", url: "/api/turn?trace=visible", origin: source, body: JSON.stringify(payload) }]);
});

test("an unavailable upstream produces a useful 502 and no substitute world", async t => {
  const stopped = createServer();
  const source = await listen(stopped);
  await close(stopped);
  const base = await proxy(t, source);
  const response = await fetch(base + "/api/state");
  assert.equal(response.status, 502);
  const result = await response.json() as { error: string; world?: unknown };
  assert.match(result.error, /无法连接世界服务/);
  assert.equal(result.world, undefined);
});

test("upstream redirects are not followed or retried", async t => {
  let requests = 0;
  const upstream = createServer((_req, response) => {
    requests++; response.writeHead(302, { Location: "http://example.invalid/" }); response.end();
  });
  const source = await listen(upstream);
  t.after(() => close(upstream));
  const base = await proxy(t, source);
  const response = await fetch(base + "/api/state");
  assert.equal(response.status, 502);
  assert.match(JSON.stringify(await response.json()), /无法连接世界服务/);
  assert.equal(requests, 1);
});
