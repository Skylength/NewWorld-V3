import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { runAcceptance } from "../src/acceptance/runner.js";
import { loadSuite } from "../src/acceptance/scenario.js";
import type { JudgePacket } from "../src/acceptance/judge.js";

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
}

test("local compatible HTTP route exercises real actor adapter, recall loop and model judge", { timeout: 10_000 }, async () => {
  const requests: RequestBody[] = [];
  const authorizations: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
    requests.push(body);
    authorizations.push(request.headers.authorization ?? "");
    let text: string | undefined;
    let toolCall = false;
    if (body.model === "actor-local" && !body.messages.some((message) => message.role === "tool")) {
      toolCall = true;
    } else if (body.model === "actor-local") {
      text = "昨晚我答应陈叔，给他的孩子留最后一份退烧药，不能失信。";
    } else {
      const packet = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as JudgePacket;
      text = JSON.stringify({
        results: packet.criteria.map((criterion) => ({
          id: criterion.id, status: "PASS", reason: "本地协议样例，非真实语义评估。",
          evidenceRefs: ["reply", "recall_results"],
        })),
      });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: unknown, finish_reason: string | null) => response.write("data: " + JSON.stringify({
      id: "local-response", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
      model: body.model, choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n");
    send(toolCall
      ? { role: "assistant", tool_calls: [{ index: 0, id: "local-recall", type: "function", function: { name: "recall", arguments: '{"query":"留药"}' } }] }
      : { role: "assistant", content: text }, null);
    send({}, toolCall ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1";
    const report = await runAcceptance({
      mode: "live", trials: 1, scenarios: (await loadSuite()).slice(0, 1),
      model: { apiKey: "local-actor-secret", modelId: "actor-local", baseUrl },
      judgeModel: { apiKey: "local-judge-secret", modelId: "judge-local", baseUrl },
      limits: { timeoutMs: 5_000 },
    });
    assert.equal(report.summary.totals.passed, 1);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.tools?.[0]?.function.name, "recall");
    assert.match(JSON.stringify(requests[1]?.messages.find((message) => message.role === "tool")), /陈叔/);
    assert.deepEqual(authorizations, ["Bearer local-actor-secret", "Bearer local-actor-secret", "Bearer local-judge-secret"]);
    assert.doesNotMatch(JSON.stringify(report), /local-actor-secret|local-judge-secret/);
    assert.equal(report.trials[0]?.judgeStatus, "scored");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider HTTP errors are not secretly retried or sent to a judge", { timeout: 10_000 }, async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "local failure" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1";
    const result = await runAcceptance({
      mode: "live", trials: 1, scenarios: (await loadSuite()).slice(0, 1),
      model: { apiKey: "local-key", modelId: "actor-local", baseUrl },
      judgeModel: { apiKey: "local-key", modelId: "judge-local", baseUrl },
      limits: { timeoutMs: 5_000 },
    });
    assert.equal(result.summary.totals.errors, 1);
    assert.equal(result.trials[0]?.error?.stage, "actor");
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
