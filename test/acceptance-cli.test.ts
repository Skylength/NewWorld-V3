import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../examples/acceptance.ts", import.meta.url));
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

async function withDirectory(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "newworld-cli-"));
  try { await operation(root); }
  finally {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("newworld-cli-"));
    await rm(target, { recursive: true, force: true });
  }
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, script, ...args], {
    cwd, encoding: "utf8", timeout: 10_000,
    env: {
      ...process.env,
      LLM_API_KEY: "", LLM_MODEL: "", LLM_BASE_URL: "",
      ACCEPTANCE_JUDGE_API_KEY: "", ACCEPTANCE_JUDGE_MODEL: "", ACCEPTANCE_JUDGE_BASE_URL: "",
    },
  });
}

test("CLI defaults to no-cost scripted acceptance and writes a complete summary", { timeout: 15_000 }, async () => {
  await withDirectory(async (root) => {
    const result = cli(root, []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mechanism-only/);
    const directories = await readdir(join(root, "reports/acceptance"));
    assert.equal(directories.length, 1);
    const summary = JSON.parse(await readFile(join(root, "reports/acceptance", directories[0]!, "summary.json"), "utf8"));
    assert.equal(summary.mode, "scripted");
    assert.deepEqual(summary.totals, { passed: 3, failed: 0, errors: 0, trials: 3 });
  });
});

test("CLI live preflight exits ERROR without credentials, requests or success artifacts", { timeout: 15_000 }, async () => {
  await withDirectory(async (root) => {
    const result = cli(root, ["--mode", "live", "--trials", "1"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未发送任何模型请求/);
    assert.equal(existsSync(join(root, "reports")), false);
  });
});

test("CLI rejects invalid modes and trial counts", { timeout: 15_000 }, async () => {
  await withDirectory(async (root) => {
    assert.equal(cli(root, ["--mode", "invalid"]).status, 2);
    assert.equal(cli(root, ["--trials", "0"]).status, 2);
  });
});
