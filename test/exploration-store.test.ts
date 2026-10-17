import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replaceSnapshot } from "../src/exploration/store.js";

test("snapshot replacement retries a transient EPERM while preserving the old file until atomic replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-store-transient-"));
  try {
    const destination = join(directory, "world.json");
    const source = join(directory, "world.json.tmp");
    const before = JSON.stringify({ revision: 1, details: ["原世界必须完整保留", "尚未发生新的行动"] });
    const after = JSON.stringify({ revision: 2, details: ["新状态已提交"] });
    writeFileSync(destination, before, "utf8");
    writeFileSync(source, after, "utf8");
    let attempts = 0;
    replaceSnapshot(source, destination, (from, to) => {
      attempts++;
      assert.equal(from, source);
      assert.equal(to, destination);
      assert.equal(readFileSync(destination, "utf8"), before, "failed replacement must not remove or truncate the old snapshot");
      assert.equal(readFileSync(source, "utf8"), after);
      if (attempts === 1) throw Object.assign(new Error("temporary Windows file lock"), { code: "EPERM" });
      renameSync(from, to);
    });
    assert.equal(attempts, 2);
    assert.equal(readFileSync(destination, "utf8"), after);
    assert.equal(existsSync(source), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent EPERM stops after four attempts and leaves the old snapshot unmodified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newworld-exploration-store-persistent-"));
  try {
    const destination = join(directory, "world.json");
    const source = join(directory, "world.json.tmp");
    const before = JSON.stringify({ revision: 7, details: ["完整旧存档", "不能删除后再写入"], history: [1, 2, 3] });
    const after = JSON.stringify({ revision: 8, details: ["尚未提交的新存档"] });
    writeFileSync(destination, before, "utf8");
    writeFileSync(source, after, "utf8");
    const locked = Object.assign(new Error("persistent Windows file lock"), { code: "EPERM" });
    let attempts = 0;
    assert.throws(() => replaceSnapshot(source, destination, () => {
      attempts++;
      assert.equal(readFileSync(destination, "utf8"), before);
      assert.equal(readFileSync(source, "utf8"), after);
      throw locked;
    }), error => error === locked);
    assert.equal(attempts, 4);
    assert.equal(readFileSync(destination, "utf8"), before);
    assert.equal(readFileSync(source, "utf8"), after);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
