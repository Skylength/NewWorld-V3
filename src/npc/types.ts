export interface NpcSeed {
  id: string;
  name: string;
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

export interface NpcEvent {
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
  speech: { targetId: string; text: string } | null;
  beliefs: Belief[];
  relations: Relation[];
  goals: string[] | null;
  plan: { purpose: string; steps: ActionStep[]; interruptOnMessage: boolean } | null;
  planDisposition: "keep" | "replace" | "cancel";
  wakeAfterMinutes: number | null;
}

export interface NpcRun {
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
  version: 1;
  actors: Npc[];
  events: NpcEvent[];
  letters: Letter[];
  playerInventory: Record<string, number>;
  runs: NpcRun[];
  advance: { target: number; status: "running" | "paused"; reason: string | null } | null;
  receipts: { id: string; fingerprint: string }[];
}
