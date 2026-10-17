export interface ActorScope {
  worldId: string;
  actorId: string;
}

export interface ActorProfile {
  id: string;
  name: string;
  persona: string;
  goals: string[];
}

export interface ActorContext {
  profile: ActorProfile;
  visibleFacts: string[];
  memoryIndexHints: string[];
}

export interface ActorObservation {
  source: "player" | "world";
  text: string;
}

export interface ActorRunRequest {
  runId: string;
  scope: ActorScope;
  observation: ActorObservation;
}

export interface MemoryHit {
  id: string;
  text: string;
}

export interface MemoryReader {
  recall(
    scope: ActorScope,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MemoryHit[]>;
}

export type ActorRunResult =
  | { status: "completed"; runId: string; reply: string }
  | {
      status: "aborted" | "budget_exceeded" | "failed";
      runId: string;
      code: string;
      message: string;
    };

export interface ActorRepository {
  load(scope: ActorScope, signal?: AbortSignal): Promise<ActorContext | undefined>;
}
