export interface NpcSeed {
  appearance?: "start" | "arrival";
  id: string;
  name: string;
  /** name remains the display label when the actual name has not been established. */
  nameKnown?: boolean;
  description: string;
  persona: string;
  goals: string[];
  locationId: string;
}

export interface Experience {
  id: string;
  time: number;
  kind: "observation" | "message" | "action";
  text: string;
  sourceId: string;
}

export interface Belief {
  text: string;
  evidenceIds: string[];
}

export interface Relation extends Belief {
  targetId: string;
  affinity: number;
  trust: number;
  respect: number;
  fear: number;
  ties: string[];
}

export interface ActionStep {
  capability: string;
  version: number;
  args: Record<string, unknown>;
}

export interface Plan {
  id: string;
  purpose: string;
  steps: ActionStep[];
  index: number;
  status: "running" | "interrupted" | "completed" | "cancelled";
  startedAt: number;
  dueAt: number | null;
  interruptOnMessage: boolean;
  error: string | null;
}

export interface Npc extends NpcSeed {
  memorySummary?: import("../memory/summaries.js").MemorySummary;
  summaryAttempt?: { signature: string; experienceCount: number; requests: number; error: string | null };
  identityRevision?: number;
  identityHistory?: { turnId: string; previousName: string; name: string; previousDescription?: string; description?: string; sourceKind: "player_setting" | "speech"; reference: string }[];
  aliases?: { text: string; scopeId: string }[];
  profile?: CharacterProfile;
  mode: "background" | "agent";
  condition: string;
  inventory: Record<string, number>;
  experiences: Experience[];
  beliefs: Belief[];
  relations: Relation[];
  knownLocations: string[];
  contacts: { id: string; address: string }[];
  plan: Plan | null;
  wakeAt: number | null;
  pending: string[];
}

export interface ProfileFact {
  id: string;
  topic: string;
  text: string;
  source: { kind: "player_setting" | "world_creation" | "executed_event"; turnId: string; reference: string };
  supersedesId: string | null;
  status: "active" | "superseded";
}

export interface CharacterProfile {
  revision: number;
  facts: ProfileFact[];
}

export interface ProfileChange {
  npcId: string;
  expectedRevision: number;
  topic: string;
  text: string;
  sourceKind: ProfileFact["source"]["kind"];
  reference: string;
  supersedesId: string | null;
}

export interface NpcEvent {
  completedAction?: boolean;
  speech?: { targetId: string; text: string };
  id: string;
  time: number;
  kind: Experience["kind"];
  actorId: string;
  text: string;
  witnesses: string[];
}

export interface Letter {
  id: string;
  fromId: string;
  toId: string;
  text: string;
  channel: "letter" | "telepathy";
  address: string;
  sentAt: number;
  dueAt: number;
  status: "in_transit" | "delivered" | "failed";
}

export interface NpcDecision {
  commitments?: import("./commitments.js").CommitmentChange[];
  speech: { targetId: string; text: string } | null;
  beliefs: Belief[];
  relations: Relation[];
  goals: string[] | null;
  plan: { purpose: string; steps: ActionStep[]; interruptOnMessage: boolean } | null;
  planDisposition: "keep" | "replace" | "cancel";
  wakeAfterMinutes: number | null;
}

export interface NpcRun {
  kind?: "summary";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  id: string;
  npcId: string;
  time: number;
  status: "running" | "completed" | "failed" | "cancelled";
  requests: number;
  tools: number;
  inputTokens: number | null;
  outputTokens: number | null;
  context: string;
  raw: string;
  error: string | null;
}

export interface NpcState {
  commitments?: import("./commitments.js").Commitment[];
  version: 1;
  /** Player attention is independent of whether a character runs autonomously. */
  playerAttention?: { trackedCharacterIds: string[] };
  actors: Npc[];
  events: NpcEvent[];
  letters: Letter[];
  playerInventory: Record<string, number>;
  runs: NpcRun[];
  advance: { target: number; status: "running" | "paused"; reason: string | null } | null;
  receipts: { id: string; fingerprint: string }[];
}
