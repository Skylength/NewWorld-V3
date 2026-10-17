import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExplorationSave } from "./types.js";

/** Windows readers can briefly deny replacement; retry only the same atomic filesystem operation. */
export function replaceSnapshot(source: string, destination: string, replace = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try { replace(source, destination); return; }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (attempt >= 3 || !["EPERM", "EBUSY", "EACCES"].includes(String(code))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt);
    }
  }
}

/** Local single-process store: replace one complete snapshot, never partial world patches. */
export class ExplorationStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
  }
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("无效存档 ID");
    return join(this.directory, id + ".json");
  }
  private atomicWrite(file: string, value: unknown): void {
    const temporary = file + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      replaceSnapshot(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original write error; an occupied temp file can be cleaned later. */ }
    }
  }
  save(save: ExplorationSave): void { this.atomicWrite(this.file(save.world.id), save); }
  select(id: string): void { this.file(id); this.atomicWrite(join(this.directory, "current.json"), { id }); }
  currentId(): string | null {
    const file = join(this.directory, "current.json");
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") throw new Error("当前存档索引损坏，原文件已保留。");
    this.file(parsed.id);
    return parsed.id;
  }
  load(id: string): ExplorationSave {
    const raw: unknown = JSON.parse(readFileSync(this.file(id), "utf8"));
    if (!raw || typeof raw !== "object" || !("world" in raw) || !("runs" in raw)) throw new Error("存档格式无效");
    const save = raw as ExplorationSave;
    if (save.world?.schemaVersion !== 1 || save.world.id !== id || !Array.isArray(save.world.regions) || !Array.isArray(save.world.turns) || !Array.isArray(save.runs)) throw new Error("存档版本或身份不匹配");
    if (!save.world.regions.some(r => r.id === save.world.playerLocationId)) throw new Error("存档当前位置不存在");
    return save;
  }
  list(): { id: string; title: string; revision: number; updatedAt: string }[] {
    return readdirSync(this.directory).filter(name => name.endsWith(".json") && name !== "current.json").flatMap(name => {
      const id = name.slice(0, -5);
      try {
        const save = this.load(id);
        return [{ id, title: save.world.title, revision: save.world.revision, updatedAt: statSync(this.file(id)).mtime.toISOString() }];
      } catch { return []; } // Corrupt saves are left untouched; they do not hide healthy saves.
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
