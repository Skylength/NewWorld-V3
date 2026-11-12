import type { ExplorationWorld } from "../exploration/types.js";
import type { Belief, Relation } from "./types.js";
import { belief, relation, fields, identifier, list } from "./validation.js";
import { commitCognition } from "./engine.js";

export interface PortrayalChange { npcId: string; beliefs: Belief[]; relations: Relation[] }
export function parsePortrayals(value: unknown): PortrayalChange[] {
  return value === undefined ? [] : list(value, 4, item => {
    const d = fields(item, ["npcId", "beliefs", "relations"]);
    return { npcId: identifier(d.npcId), beliefs: list(d.beliefs, 4, belief), relations: list(d.relations, 4, relation) };
  });
}
export function applyPortrayals(world: ExplorationWorld, changes: PortrayalChange[], currentEventIds: string[] = []): void {
  const staged = structuredClone(world);
  const seen = new Set<string>();
  for (const change of changes) {
    const npc = staged.npc?.actors.find(n => n.id === change.npcId);
    if (!npc || npc.mode !== "background" || npc.locationId !== staged.playerLocationId || seen.has(npc.id)) throw new Error("只能修订本轮在场普通人物的自有认知，每人一次");
    seen.add(npc.id);
    const resolve = (entry: Belief) => ({ ...entry, evidenceIds: entry.evidenceIds.flatMap(id => {
      if (id !== "current_interaction" && id !== "current_reply") return [id];
      const events = staged.npc!.events.filter(e => currentEventIds.includes(e.id) && e.witnesses.includes(npc.id)
        && (id === "current_interaction" ? e.actorId === "player" && e.speech?.targetId === npc.id : e.actorId === npc.id && e.speech));
      if (!events.length) throw new Error("本阶段没有可引用的实际交谈事件");
      return events.map(e => e.id);
    }) });
    commitCognition(staged, npc.id, { beliefs: change.beliefs.map(resolve), relations: change.relations.map(r => ({ ...r, ...resolve(r) })) });
  }
  for (const id of seen) {
    const source = staged.npc!.actors.find(n => n.id === id)!;
    const target = world.npc!.actors.find(n => n.id === id)!;
    target.beliefs = source.beliefs; target.relations = source.relations;
  }
}
export const portrayalInstructions = `
普通人物上下文中的selfNotes仅供扮演该人物时保持自身设定；不代表玩家或其他人物知道，不能自动转为公开观察、旁白或他人的台词。创作资料来源不作为人物听到的对白。
可额外输出portrayalChanges数组，每项{npcId,beliefs,relations}，只针对本轮在场普通人物；mode=agent的人物不能由你改认知。
如果人物已经基于提供的共同经历形成对玩家的明确看法，或本轮表现明确延续/改变信任、戒备、亲近，应把当前关系理解及支持它的已有经历写回relations，而不只在对白中表现后又丢失。延续原有态度，没有依据时不强行增加好感；关系理解描述当前相处，不把一次情绪写成人物永久性格。
beliefs项为{text,evidenceIds}；relations项为{targetId,text,evidenceIds,affinity,trust,respect,fear,ties}。亲近/信任/敬重为-100到100，畏惧0到100，ties为字符串数组。这些是人物自己的理解，不代表玩家情感，不写入公开旁白。
旧经历必须引用实际提供且内容直接支持该理解的经历ID，不能用任意合法ID代替依据。本轮交谈可在evidenceIds使用current_interaction（本阶段实际投递给本人的玩家发言）或current_reply（本阶段本人实际发言），宿主在事件生成后绑定真实ID；没有对应发言就不能使用。不猜测新ID，不把本轮刚发生的事归到上轮无关经历。关系只写对对象的看法，不把话题复述当关系；一次情绪不固化人格，没有依据就留空。
关注状态通过玩家界面操作维护，不从自然语言推断，不输出attentionChanges。
`;
