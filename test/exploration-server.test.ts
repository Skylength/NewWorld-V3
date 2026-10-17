import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createScriptedRuntime, reply, type ScriptedResponse, type ScriptedTurn } from "../src/acceptance/scripted-model.js";
import { createExplorationServer } from "../src/exploration/server.js";
import { ExplorationService } from "../src/exploration/service.js";
import type { ExplorationView, WorldTurnDraft } from "../src/exploration/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const draft: WorldTurnDraft = {
  narration: "你在山门旁的石碑发现一行旧题字。", elapsedMinutes: 2, destinationId: "gate",
  createRegions: [], enrichRegions: [{ id: "gate", addDetails: ["石碑题字是守心二字。"], stateChanges: {}, addOpportunities: [], reason: "玩家查看石碑" }],
  events: ["查看山门石碑"],
};
async function fixture(t: TestContext, turns: ScriptedTurn[] | null = []) {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-http-"));
  const scripted = turns === null ? null : createScriptedRuntime(turns);
  const textScripted = turns === null ? null : createScriptedRuntime(turns.map(() => () => reply(draft.narration)));
  const service = new ExplorationService({ directory, ...(scripted && textScripted ? { modelRuntime: scripted.runtime, textModelRuntime: textScripted.runtime } : {}) });
  const server = createExplorationServer(service);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    service.cancel();
    await service.waitForIdle();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { service, base, post, scripted, textScripted };
}

test("local API accepts an asynchronous turn and exposes running and committed debug state", { timeout: 5_000 }, async t => {
  const entered = deferred<void>();
  const result = deferred<ScriptedResponse>();
  const { service, base, post, scripted } = await fixture(t, [async () => { entered.resolve(); return result.promise; }]);
  const initialResponse = await fetch(base + "/api/state");
  assert.equal(initialResponse.status, 200);
  assert.match(initialResponse.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  const initial = await initialResponse.json() as ExplorationView;
  assert.equal(initial.world.playerLocationId, "gate");
  const response = await post("/api/turn", { action: "查看石碑" });
  assert.equal(response.status, 202);
  const { runId } = await response.json() as { runId: string };
  assert.ok(runId);
  await entered.promise;
  const running = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.equal(running.activeRunId, runId);
  assert.equal(running.runs[0]?.status, "running");
  assert.equal(running.runs[0]?.modelRequests, 1);
  assert.ok(running.runs[0]?.context.systemPrompt);
  assert.deepEqual(running.world, initial.world);
  assert.equal((await post("/api/turn", { action: "重复提交" })).status, 409);
  result.resolve(reply(JSON.stringify(draft)));
  await service.waitForIdle();
  const completed = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.equal(completed.activeRunId, null);
  assert.equal(completed.runs[0]?.status, "completed");
  assert.equal(completed.runs[0]?.rawResponse, JSON.stringify(draft));
  assert.equal(completed.runs[0]?.modelRequests, 2);
  assert.deepEqual(completed.runs[0]?.calls?.map(call => call.role), ["structure", "text"]);
  assert.equal(completed.world.turns[0]?.narration, draft.narration);
  assert.equal(completed.world.revision, initial.world.revision + 1);
  assert.equal(scripted?.requests.length, 1);
  const exported = await fetch(base + "/api/export");
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
  assert.deepEqual(await exported.json(), service.exportSave());
  const created = await post("/api/new", {});
  assert.equal(created.status, 200);
  const next = await created.json() as ExplorationView;
  assert.notEqual(next.world.id, initial.world.id);
  const saves = await (await fetch(base + "/api/saves")).json() as { saves: { id: string }[] };
  assert.equal(saves.saves.length, 2);
  const loaded = await post("/api/load", { worldId: initial.world.id });
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json() as ExplorationView).world, completed.world);
});

test("local API cancellation returns to idle without committing the pending world turn", { timeout: 5_000 }, async t => {
  const entered = deferred<void>();
  const { service, base, post } = await fixture(t, [async () => { entered.resolve(); return new Promise(() => {}); }]);
  const before = service.getView().world;
  assert.equal((await post("/api/turn", { action: "查看石碑" })).status, 202);
  await entered.promise;
  const response = await post("/api/cancel", {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cancelled: true });
  await service.waitForIdle();
  const state = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.equal(state.runs[0]?.status, "cancelled");
  assert.equal(state.activeRunId, null);
  assert.deepEqual(state.world, before);
});

test("local API validates actions, JSON payloads, media types and size before model execution", async t => {
  const { base, post, scripted, service } = await fixture(t);
  const before = service.exportSave();
  for (const body of [{}, { action: 7 }, { action: "" }, { action: "字".repeat(2001) }, []]) {
    assert.equal((await post("/api/turn", body)).status, 400);
  }
  const malformed = await fetch(base + "/api/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  const plain = await fetch(base + "/api/turn", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
  assert.equal((await post("/api/turn", { action: "字".repeat(6000) })).status, 413);
  assert.equal(scripted?.requests.length, 0);
  assert.deepEqual(service.exportSave(), before);
});

test("local API rejects invalid save IDs and unknown routes without exposing filesystem contents", async t => {
  const { service, base, post, scripted } = await fixture(t);
  const before = service.exportSave();
  for (const worldId of ["../current", "..\\current", "C:\\Windows\\win.ini", "", "a".repeat(81)]) {
    const response = await post("/api/load", { worldId });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /ID|存档|无效/);
  }
  assert.equal((await post("/api/load", {})).status, 400);
  for (const route of ["/api/unknown", "/package.json", "/%2e%2e%2fpackage.json", "/src/exploration/service.ts"]) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.deepEqual(service.exportSave(), before);
  assert.equal(scripted?.requests.length, 0);
});

test("local API rejects untrusted origins and hosts while allowing its own origin", async t => {
  const { base, post, service, scripted } = await fixture(t);
  const before = service.exportSave();
  for (const origin of ["https://example.invalid", "http://localhost:1", "null"]) {
    assert.equal((await post("/api/new", {}, { Origin: origin })).status, 403);
    assert.equal((await fetch(base + "/api/state", { headers: { Origin: origin } })).status, 403);
  }
  // Fetch normalizes Host, so use a native local request to exercise the server's host guard.
  const untrustedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base + "/api/state", { headers: { Host: "untrusted.invalid" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(untrustedHostStatus, 403);
  assert.equal((await fetch(base + "/api/state", { headers: { Origin: base } })).status, 200);
  assert.deepEqual(service.exportSave(), before);
  assert.equal(scripted?.requests.length, 0);
});

test("local API reports absent live configuration without manufacturing a generated turn", async t => {
  const { service, post, base } = await fixture(t, null);
  const before = service.exportSave();
  const state = await (await fetch(base + "/api/state")).json() as ExplorationView;
  assert.equal(state.config.configured, false);
  const response = await post("/api/turn", { action: "前往南疆" });
  assert.equal(response.status, 503);
  assert.match(JSON.stringify(await response.json()), /LLM_MODEL|配置/);
  assert.deepEqual(service.exportSave(), before);
});

test("local browser assets are served with matching types and restrictive content policy", async t => {
  const assets = [
    ["/", "index.html", "text/html"], ["/index.html", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
  ] as const;
  if (assets.some(([, file]) => !existsSync(new URL(`../web/exploration/${file}`, import.meta.url)))) {
    t.skip("浏览器资源尚未交付；资源到位后此检查会自动执行。");
    return;
  }
  const { base } = await fixture(t);
  for (const [route, , type] of assets) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith(type));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 0);
  }
});
