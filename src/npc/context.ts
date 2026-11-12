import { usableSummary } from "../memory/summaries.js";
import type { ExplorationWorld } from "../exploration/types.js";
import type { Npc } from "./types.js";
import { relevantMemories } from "../memory/relevance.js";

/** Shared selection for self recall and audience-filtered scene portrayal. */
export function characterMemories(npc: Npc, query: string, allowedEventIds?: ReadonlySet<string>) {
  const available = allowedEventIds ? npc.experiences.filter(e => allowedEventIds.has(e.id)) : npc.experiences;
  const recent = available.slice(-12);
  const recentIds = new Set(recent.map(e => e.id));
  const related = relevantMemories(available.filter(e => !recentIds.has(e.id)), query, 5);
  return [...related, ...recent];
}

/** Only shared observations enter the shared Director request, never private letters. */
export function backgroundCharacterContexts(world: ExplorationWorld, locationId: string, action: string) {
  const events = world.npc?.events ?? [];
  const publicEvents = new Set(events.filter(e => e.witnesses.includes("player")).map(e => e.id));
  const tracked = new Set(world.npc?.playerAttention?.trackedCharacterIds ?? []);
  return (world.npc?.actors ?? [])
    .filter(n => n.mode === "background" && n.locationId === locationId)
    .map(n => ({ id: n.id, name: n.name, description: n.description, tracked: tracked.has(n.id),
      selfNotes: { persona: n.persona, facts: n.profile?.facts.filter(f => f.status === "active").map(f => ({ topic: f.topic, text: f.text })) ?? [] },
      summary: usableSummary(n, "shared"),
      beliefs: n.beliefs.filter(b => b.evidenceIds.every(id => publicEvents.has(id))).slice(-12),
      relations: n.relations.filter(r => r.targetId === "player" && r.evidenceIds.every(id => publicEvents.has(id))),
      experiences: characterMemories(n, action, publicEvents) }));
}
