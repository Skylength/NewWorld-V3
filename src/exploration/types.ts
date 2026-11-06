export interface Region {
  id: string;
  name: string;
  parentId: string | null;
  summary: string;
  details: string[];
  state: Record<string, string>;
  opportunities: string[];
  createdTurn: number;
  updatedTurn: number;
  revision: number;
}

export interface RegionCreate {
  id: string;
  name: string;
  parentId: string | null;
  summary: string;
  details: string[];
  state: Record<string, string>;
  opportunities: string[];
}

export interface RegionEnrichment {
  id: string;
  addDetails: string[];
  stateChanges: Record<string, string | null>;
  addOpportunities: string[];
  reason: string;
}

export interface WorldTurnDraft {
  narration: string;
  elapsedMinutes: number;
  destinationId: string;
  createRegions: RegionCreate[];
  enrichRegions: RegionEnrichment[];
  events: string[];
}

/** The host chooses the operation; model output cannot grant itself movement permission. */
export type ExplorationIntent =
  | { kind: "interact" }
  | { kind: "explore" }
  | { kind: "travel"; destinationId: string };

export interface WorldChange {
  kind: "created" | "enriched" | "state" | "moved";
  regionId: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface ExplorationTurn {
  id: string;
  number: number;
  action: string;
  narration: string;
  fromId: string;
  toId: string;
  elapsedMinutes: number;
  events: string[];
  changes: WorldChange[];
  createdAt: string;
}

export interface ExplorationWorld {
  schemaVersion: 1;
  id: string;
  title: string;
  core: string;
  revision: number;
  timeMinutes: number;
  playerLocationId: string;
  regions: Region[];
  turns: ExplorationTurn[];
}

export interface ContextModule {
  id: string;
  kind: "world" | "location" | "related" | "history" | "registry";
  title: string;
  reason: string;
  text: string;
}

export interface ExplorationContext {
  systemPrompt: string;
  userPrompt: string;
  modules: ContextModule[];
  activeRegionIds: string[];
  characters: number;
}

export interface ExplorationRun {
  id: string;
  worldId: string;
  action: string;
  baseRevision: number;
  intent?: ExplorationIntent;
  sourceRegionId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  modelRequests: number;
  context: ExplorationContext;
  rawResponse: string;
  draft: WorldTurnDraft | null;
  changes: WorldChange[];
  usage: { input: number; output: number; totalTokens: number } | null;
  error: string | null;
  calls?: ExplorationModelCall[];
  stage?: "context" | "structure" | "validation" | "text" | "commit" | "done";
  failureStage?: "context" | "structure" | "validation" | "text" | "commit";
}

export interface ExplorationModelCall {
  role: "structure" | "text";
  model: string;
  status: "running" | "completed" | "failed" | "cancelled";
  context: ExplorationContext;
  rawResponse: string;
  modelRequests: number;
  usage: ExplorationRun["usage"];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface ExplorationSave {
  world: ExplorationWorld;
  runs: ExplorationRun[];
}

export interface ExplorationView extends ExplorationSave {
  activeRunId: string | null;
  nextContext: ExplorationContext;
  config: {
    configured: boolean; model: string; mode: "live" | "scripted"; timeoutMs: number; maxOutputTokens: number;
    structureModel: string; textModel: string; maxModelRequests: number;
    structureMaxOutputTokens: number; textMaxOutputTokens: number;
  };
}
