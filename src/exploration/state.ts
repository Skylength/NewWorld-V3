import type { ExplorationWorld, Region, RegionCreate, RegionEnrichment, WorldChange, WorldTurnDraft } from "./types.js";
import { parseSeed } from "../npc/validation.js";
import { materialize } from "../npc/state.js";

export { createInitialWorld } from "../../fixtures/exploration.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(path: string, message: string): never {
  throw new Error(`世界更新无效：${path} ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "必须是普通对象");
  return value as Record<string, unknown>;
}

function fields(value: unknown, path: string, allowed: string[]): Record<string, unknown> {
  const result = object(value, path);
  for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(`${path}.${key}`, "是未知字段");
  for (const key of allowed) if (!Object.hasOwn(result, key)) fail(`${path}.${key}`, "为必填字段");
  return result;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") fail(path, "必须是字符串");
  if (!value.trim() || value.length > max) fail(path, `必须非空且不超过 ${max} 字符`);
  if (value.includes("\u0000")) fail(path, "不能包含空字符");
  return value.trim();
}

function id(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!ID_PATTERN.test(result) || RESERVED_KEYS.has(result)) fail(path, "必须以小写字母开头，仅含小写字母、数字、下划线或短横线");
  return result;
}

function list<T>(value: unknown, path: string, max: number, parse: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `必须是最多 ${max} 项的数组`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function stringList(value: unknown, path: string, maxItems: number, maxChars: number): string[] {
  return list(value, path, maxItems, (entry, entryPath) => string(entry, entryPath, maxChars));
}

function stateRecord(value: unknown, path: string, nullable: false): Record<string, string>;
function stateRecord(value: unknown, path: string, nullable: true): Record<string, string | null>;
function stateRecord(value: unknown, path: string, nullable: boolean): Record<string, string | null> {
  const record = object(value, path);
  if (Object.keys(record).length > 20) fail(path, "最多包含 20 个状态字段");
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.trim() || key !== key.trim() || key.length > 60 || RESERVED_KEYS.has(key) || key.includes("\u0000")) {
      fail(`${path}.${key}`, "状态名无效（1–60 字符且不含保留名称）");
    }
    result[key] = nullable && value === null ? null : string(value, `${path}.${key}`, 600);
  }
  return result;
}

function parseCreate(value: unknown, path: string): RegionCreate {
  const data = fields(value, path, ["id", "name", "parentId", "summary", "details", "state", "opportunities"]);
  return {
    id: id(data.id, `${path}.id`),
    name: string(data.name, `${path}.name`, 80),
    parentId: data.parentId === null ? null : id(data.parentId, `${path}.parentId`),
    summary: string(data.summary, `${path}.summary`, 1200),
    details: stringList(data.details, `${path}.details`, 12, 600),
    state: stateRecord(data.state, `${path}.state`, false),
    opportunities: stringList(data.opportunities, `${path}.opportunities`, 8, 400),
  };
}

function parseEnrichment(value: unknown, path: string): RegionEnrichment {
  const data = fields(value, path, ["id", "addDetails", "stateChanges", "addOpportunities", "reason"]);
  return {
    id: id(data.id, `${path}.id`),
    addDetails: stringList(data.addDetails, `${path}.addDetails`, 12, 600),
    stateChanges: stateRecord(data.stateChanges, `${path}.stateChanges`, true),
    addOpportunities: stringList(data.addOpportunities, `${path}.addOpportunities`, 8, 400),
    reason: string(data.reason, `${path}.reason`, 600),
  };
}

function validateDraft(value: unknown): WorldTurnDraft {
  const incoming = object(value, "draft");
  const { createNpcs, ...base } = incoming;
  const data = fields(base, "draft", ["narration", "elapsedMinutes", "destinationId", "createRegions", "enrichRegions", "events"]);
  if (typeof data.elapsedMinutes !== "number" || !Number.isInteger(data.elapsedMinutes) || data.elapsedMinutes < 0 || data.elapsedMinutes > 525600) {
    fail("draft.elapsedMinutes", "必须是 0–525600 之间的整数");
  }
  return {
    createNpcs: createNpcs === undefined ? [] : list(createNpcs, "draft.createNpcs", 4, v => parseSeed(v)),
    narration: string(data.narration, "draft.narration", 6000),
    elapsedMinutes: data.elapsedMinutes,
    destinationId: id(data.destinationId, "draft.destinationId"),
    createRegions: list(data.createRegions, "draft.createRegions", 5, parseCreate),
    enrichRegions: list(data.enrichRegions, "draft.enrichRegions", 8, parseEnrichment),
    events: stringList(data.events, "draft.events", 12, 600),
  };
}

/** Deliberately no code-fence stripping or repair: the recorded response is the protocol. */
export function parseWorldTurnDraft(raw: string): WorldTurnDraft {
  if (typeof raw !== "string" || raw.length > 100000) fail("response", "必须是最多 100000 字符的 JSON 文本");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("response", "不是合法 JSON；请检查原始模型输出"); }
  return validateDraft(value);
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkRegionGraph(regions: Region[]): Map<string, Region> {
  const byId = new Map<string, Region>();
  const byName = new Set<string>();
  for (const region of regions) {
    id(region.id, `region[${region.id}].id`);
    if (byId.has(region.id)) fail(region.id, "地点 ID 已存在，请复用并补充原地点");
    byId.set(region.id, region);
    const nameKey = JSON.stringify([region.parentId, normalized(region.name).toLocaleLowerCase("en-US")]);
    if (byName.has(nameKey)) fail(region.name, "同一上级地点下已有同名地点，请复用原地点");
    byName.add(nameKey);
  }
  for (const region of regions) {
    const visited = new Set<string>();
    let current: Region | undefined = region;
    while (current) {
      if (visited.has(current.id)) fail(region.id, "地点层级不能形成环路");
      visited.add(current.id);
      if (current.parentId === null) break;
      const parent = byId.get(current.parentId);
      if (!parent) fail(current.id, `上级地点 ${current.parentId} 不存在`);
      current = parent;
    }
  }
  return byId;
}

export function applyWorldTurn(
  world: ExplorationWorld,
  suppliedDraft: WorldTurnDraft,
  metadata: { id: string; action: string; createdAt: string },
): { world: ExplorationWorld; changes: WorldChange[] } {
  // Validation and every mutation happen before returning a new snapshot.
  const draft = validateDraft(suppliedDraft);
  string(metadata.id, "turn.id", 128);
  string(metadata.action, "turn.action", 2000);
  if (typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt))) fail("turn.createdAt", "必须是有效日期");
  if (world.turns.some((turn) => turn.id === metadata.id)) fail("turn.id", "回合 ID 已存在");
  const originalRegions = checkRegionGraph(world.regions);
  if (!originalRegions.has(world.playerLocationId)) fail("world.playerLocationId", "当前位置不存在");
  const result = structuredClone(world);
  const turnNumber = world.turns.length + 1;
  const changes: WorldChange[] = [];
  const createdIds = new Set<string>();
  for (const create of draft.createRegions) {
    if (originalRegions.has(create.id) || createdIds.has(create.id)) fail(create.id, "地点 ID 已存在，请复用并补充原地点");
    createdIds.add(create.id);
    const region: Region = {
      ...create, details: unique(create.details), opportunities: unique(create.opportunities),
      createdTurn: turnNumber, updatedTurn: turnNumber, revision: 1,
    };
    result.regions.push(region);
    changes.push({ kind: "created", regionId: region.id, label: `创建地点：${region.name}`, before: null, after: JSON.stringify(region, null, 2) });
  }
  // References may point to another creation later in the same turn.
  const byId = checkRegionGraph(result.regions);
  if (!byId.has(draft.destinationId)) fail("destinationId", `目的地 ${draft.destinationId} 不存在`);
  const updatedIds = new Set<string>();
  for (const enrichment of draft.enrichRegions) {
    const region = byId.get(enrichment.id);
    if (!region) fail(enrichment.id, "待补充的地点不存在");
    const beforeCount = changes.length;
    for (const [key, incoming, label] of [
      ["details", enrichment.addDetails, "补充细节"],
      ["opportunities", enrichment.addOpportunities, "补充互动线索"],
    ] as const) {
      const previous = region[key];
      const combined = unique([...previous, ...incoming]);
      if (combined.length !== previous.length) {
        changes.push({ kind: "enriched", regionId: region.id, label: `${label}：${enrichment.reason}`, before: previous.join("\n") || null, after: combined.join("\n") });
        region[key] = combined;
      }
    }
    for (const [key, value] of Object.entries(enrichment.stateChanges)) {
      const previous = Object.hasOwn(region.state, key) ? region.state[key]! : null;
      if (previous === value) continue;
      if (value === null) delete region.state[key];
      else region.state[key] = value;
      changes.push({ kind: "state", regionId: region.id, label: `${key}：${enrichment.reason}`, before: previous, after: value });
    }
    if (changes.length > beforeCount) updatedIds.add(region.id);
  }
  for (const regionId of updatedIds) {
    const region = byId.get(regionId)!;
    region.updatedTurn = turnNumber;
    if (!createdIds.has(regionId)) region.revision += 1;
  }
  if (draft.destinationId !== world.playerLocationId) {
    changes.push({ kind: "moved", regionId: draft.destinationId, label: `抵达：${byId.get(draft.destinationId)!.name}`, before: world.playerLocationId, after: draft.destinationId });
  }
  result.playerLocationId = draft.destinationId;
  result.timeMinutes += draft.elapsedMinutes;
  if (!Number.isSafeInteger(result.timeMinutes) || result.timeMinutes < 0) fail("world.timeMinutes", "累计时间超出有效范围");
  result.revision += 1;
  for (const seed of draft.createNpcs ?? []) materialize(result, seed);
  result.turns.push({
    id: metadata.id, number: turnNumber, action: metadata.action.trim(), narration: draft.narration,
    fromId: world.playerLocationId, toId: draft.destinationId, elapsedMinutes: draft.elapsedMinutes,
    events: draft.events, changes: structuredClone(changes), createdAt: metadata.createdAt,
  });
  return { world: result, changes };
}
