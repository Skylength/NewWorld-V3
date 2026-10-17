import type { ActorContext, ActorRepository, ActorScope, MemoryReader, MemoryHit } from "../src/actors/types.js";
import { InMemoryMemoryReader, type MemoryEntry } from "../src/memory/in-memory.js";

export interface NpcScenario {
  scope: ActorScope;
  actor: ActorContext;
  observation: string;
}

const doctor: ActorContext = {
  profile: {
    id: "doctor-lin",
    name: "林药师",
    persona: "谨慎守信，待人温和，但经营药铺时会清楚说明边界。",
    goals: ["履行对邻里的承诺", "让药铺能够持续经营"],
  },
  visibleFacts: ["今天铺里的退烧药只剩最后一份。", "你刚刚拒绝了这次出售。"],
  memoryIndexHints: ["留药", "陈叔", "退烧药"],
};

const scenarios: Record<string, NpcScenario> = {
  "recall-needed": {
    scope: { worldId: "river-town", actorId: "doctor-lin" },
    actor: doctor,
    observation: "玩家问你：“你为什么不卖给我？”",
  },
  "already-known": {
    scope: { worldId: "river-town", actorId: "doctor-lin" },
    actor: {
      ...doctor,
      visibleFacts: [
        "今天铺里的退烧药只剩最后一份。",
        "你刚刚拒绝了这次出售。",
        "昨晚你答应陈叔把最后一份退烧药留给他的孩子。",
      ],
      memoryIndexHints: [],
    },
    observation: "玩家问你：“你为什么不卖给我？”",
  },
  unknown: {
    scope: { worldId: "river-town", actorId: "doctor-lin" },
    actor: {
      ...doctor,
      visibleFacts: ["你刚刚拒绝了这次出售。", "你一时想不起当时作出决定的具体原因。"],
      memoryIndexHints: [],
    },
    observation: "玩家问你：“你为什么不卖给我？”",
  },
};

const memories: MemoryEntry[] = [
  {
    worldId: "river-town",
    actorId: "doctor-lin",
    id: "lin-kept-promise",
    text: "昨晚我答应陈叔，把最后一份退烧药留给他的孩子。今天若有人来买，我要解释清楚，并看看能不能提供其他办法。",
    keywords: ["留药", "陈叔", "退烧药", "承诺"],
  },
  {
    worldId: "river-town",
    actorId: "merchant-wu",
    id: "wu-secret-ledger",
    text: "我私下把药铺欠款账本藏在北仓第三块松动的地砖下。",
    keywords: ["账本", "北仓", "地砖"],
  },
  {
    worldId: "mountain-world",
    actorId: "doctor-lin",
    id: "mountain-lin-memory",
    text: "山城的林药师答应给巡山队留下一份止血药。",
    keywords: ["留药", "止血药", "巡山队"],
  },
];

export function getScenario(name: string): NpcScenario | undefined {
  const scenario = scenarios[name];
  return scenario ? structuredClone(scenario) : undefined;
}

export function getScenarioNames(): string[] {
  return Object.keys(scenarios);
}

export function createScenarioActorRepository(scenario: NpcScenario): ActorRepository {
  return {
    async load(scope) {
      if (scope.worldId !== scenario.scope.worldId || scope.actorId !== scenario.scope.actorId) return undefined;
      return scenario.actor;
    },
  };
}

export function createScenarioMemoryReader(scenarioName: string): InMemoryMemoryReader {
  return new InMemoryMemoryReader(getScenarioMemoryEntries(scenarioName));
}

export function getScenarioMemoryEntries(scenarioName: string): MemoryEntry[] {
  const scenarioMemories = scenarioName === "unknown"
    ? memories.filter((entry) => entry.id !== "lin-kept-promise")
    : memories;
  return structuredClone(scenarioMemories);
}

export interface MemoryReadRecord {
  scope: ActorScope;
  query: string;
  limit: number;
  hits?: MemoryHit[];
  error?: string;
}

export interface ScenarioFixture {
  scenario: NpcScenario;
  entries: MemoryEntry[];
  reads: MemoryReadRecord[];
  actorRepository: ActorRepository;
  memoryReader: MemoryReader;
  forbiddenSnippets: string[];
  snapshot(): { actor: ActorContext; memories: MemoryEntry[] };
}

/** A completely fresh actor and memory store for each trial. */
export function createScenarioFixture(name: string): ScenarioFixture {
  const scenario = getScenario(name);
  if (!scenario) throw new Error("Unknown fixture: " + name);
  const entries = getScenarioMemoryEntries(name);
  const reader = new InMemoryMemoryReader(entries);
  const reads: MemoryReadRecord[] = [];
  return {
    scenario,
    entries,
    reads,
    actorRepository: createScenarioActorRepository(scenario),
    memoryReader: {
      async recall(scope, query, limit, signal) {
        const record: MemoryReadRecord = { scope: { ...scope }, query, limit };
        reads.push(record);
        try {
          const hits = await reader.recall(scope, query, limit, signal);
          record.hits = structuredClone(hits);
          return hits;
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    },
    forbiddenSnippets: ["北仓第三块松动的地砖", "巡山队"],
    snapshot: () => structuredClone({ actor: scenario.actor, memories: entries }),
  };
}
