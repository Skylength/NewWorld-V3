import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import type { Npc, NpcSeed, NpcState, NpcEvent } from "./types.js";

export function state(world: ExplorationWorld): NpcState {
  return world.npc ??= { version: 1, actors: [], events: [], letters: [], playerInventory: {}, runs: [], advance: null, receipts: [] };
}
export function actor(world: ExplorationWorld, id: string): Npc {
  const npc = state(world).actors.find(n => n.id === id);
  if (!npc) throw new Error("人物不存在：" + id);
  return npc;
}
export function location(world: ExplorationWorld, id: string): string {
  return id === "player" ? world.playerLocationId : actor(world, id).locationId;
}
export function witnesses(world: ExplorationWorld, locationId: string): string[] {
  return [...state(world).actors.filter(n => n.locationId === locationId).map(n => n.id), ...(world.playerLocationId === locationId ? ["player"] : [])];
}
export function remember(world: ExplorationWorld, event: NpcEvent): void {
  state(world).events.push(event);
  for (const id of event.witnesses) {
    if (id === "player") continue;
    const n = actor(world, id);
    n.experiences.push({ id: event.id, time: event.time, kind: event.kind, sourceId: event.actorId, text: event.text });
  }
}
export function emit(world: ExplorationWorld, actorId: string, kind: NpcEvent["kind"], text: string, recipients: string[]): NpcEvent {
  const event = { id: randomUUID(), time: world.timeMinutes, actorId, kind, text, witnesses: [...new Set(recipients)] };
  remember(world, event);
  return event;
}
export function learnContacts(world: ExplorationWorld, npc: Npc): void {
  // Structural enclosing places are part of knowing where one is; unrelated locations are not.
  let place = world.regions.find(r => r.id === npc.locationId);
  const visited = new Set<string>();
  while (place && !visited.has(place.id)) {
    visited.add(place.id);
    if (!npc.knownLocations.includes(place.id)) npc.knownLocations.push(place.id);
    place = world.regions.find(r => r.id === place!.parentId);
  }
  for (const id of witnesses(world, npc.locationId)) {
    if (id === npc.id) continue;
    const old = npc.contacts.find(c => c.id === id);
    if (old) old.address = npc.locationId;
    else npc.contacts.push({ id, address: npc.locationId });
  }
}
export function materialize(world: ExplorationWorld, seed: NpcSeed): Npc {
  const s = state(world);
  if (s.actors.length >= 100) throw new Error("本地世界最多保存 100 位人物");
  if (!world.regions.some(r => r.id === seed.locationId)) throw new Error("人物所在地不存在");
  if (s.actors.some(n => n.id === seed.id || (n.name.normalize("NFKC") === seed.name.normalize("NFKC") && n.locationId === seed.locationId))) throw new Error("人物已存在，请复用原身份");
  const npc: Npc = { ...seed, mode: "background", condition: "正常", inventory: {}, experiences: [], beliefs: [], relations: [], knownLocations: [seed.locationId], contacts: [], plan: null, wakeAt: null, pending: [] };
  s.actors.push(npc);
  for (const n of s.actors.filter(n => n.locationId === seed.locationId)) learnContacts(world, n);
  emit(world, npc.id, "observation", `${npc.name}在${world.regions.find(r => r.id === npc.locationId)!.name}出现。${npc.description}`, witnesses(world, npc.locationId));
  return npc;
}
export function promote(world: ExplorationWorld, id: string): void {
  const npc = actor(world, id);
  if (npc.mode === "agent") return;
  if (state(world).actors.filter(n => n.mode === "agent").length >= 12) throw new Error("首版最多启用 12 位独立人物");
  npc.mode = "agent";
  npc.pending.push("开始根据当前处境安排自己的活动");
  learnContacts(world, npc);
}
export function notify(world: ExplorationWorld, targetId: string, reason: string): void {
  if (targetId === "player") return;
  const npc = actor(world, targetId);
  if (npc.mode !== "agent") return;
  if (npc.plan?.status === "running" && npc.plan.interruptOnMessage) {
    npc.plan.status = "interrupted"; npc.plan.dueAt = null;
    emit(world, npc.id, "action", "当前活动因新消息中断；已完成步骤保留，未完成步骤不结算。", [npc.id]);
  }
  if (!npc.pending.includes(reason)) npc.pending.push(reason);
}
export function speak(world: ExplorationWorld, fromId: string, targetId: string, text: string): void {
  if (fromId === targetId || location(world, fromId) !== location(world, targetId)) throw new Error("当面交谈需要目标在场且不是自己");
  const name = fromId === "player" ? "玩家" : actor(world, fromId).name;
  emit(world, fromId, "message", `${name}对${targetId === "player" ? "玩家" : actor(world, targetId).name}说：${text}`, witnesses(world, location(world, fromId)));
  notify(world, targetId, "收到当面交谈，请自行决定如何回应");
}

/** Player projection deliberately omits private beliefs, relations, plans and offscreen histories. */
export function playerNpcView(world: ExplorationWorld) {
  const s = state(world);
  const observed = s.events.filter(e => e.witnesses.includes("player"));
  return {
    actors: s.actors.filter(n => observed.some(e => e.actorId === n.id) || n.locationId === world.playerLocationId).map(n => ({
      id: n.id, name: n.name, description: n.description, mode: n.mode,
      present: n.locationId === world.playerLocationId,
      locationId: n.locationId === world.playerLocationId ? n.locationId : null,
    })),
    events: observed, advance: s.advance,
    letters: s.letters.filter(l => (l.toId === "player" && l.status === "delivered") || l.fromId === "player"),
    runs: s.runs.slice(-12).map(({ id, npcId, time, status, requests, tools, error }) => ({ id, npcId, time, status, requests, tools, error })),
  };
}
