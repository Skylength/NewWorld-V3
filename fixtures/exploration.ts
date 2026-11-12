import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../src/exploration/types.js";
import { materialize, promote } from "../src/npc/state.js";

/** Playable starting preset, shared by first launch and new journeys. */
export function createInitialWorld(id: string = randomUUID()): ExplorationWorld {
  const world: ExplorationWorld = {
    schemaVersion: 1, id, title: "青云宗",
    opening: "清晨，你沿石阶来到青云宗，想拜入门下。前庭清静，掌门沈清和身着素青长衣，立在廊下。见你走近，她转过身来，等你说明来意。",
    core: "这是一个可以自由探索的修行世界。青云宗坐落于山中，掌门为女性沈清和。玩家此行前来拜师，尚未被收入门下；具体来历与师徒关系由实际交谈和双方决定。已确认的人物、地点与行动后果持续保留，未知区域随探索展开。",
    revision: 0, timeMinutes: 0, playerLocationId: "courtyard",
    regions: [
      { id: "qingyun", name: "青云宗", parentId: null, summary: "山中的修行宗门。", details: [], state: {}, opportunities: [], createdTurn: 0, updatedTurn: 0, revision: 1 },
      { id: "gate", name: "山门", parentId: "qingyun", summary: "石阶连接宗门与山下。", details: [], state: {}, opportunities: [], createdTurn: 0, updatedTurn: 0, revision: 1 },
      { id: "courtyard", name: "前庭", parentId: "qingyun", summary: "山门内的开阔庭院。", details: [], state: {}, opportunities: [], createdTurn: 0, updatedTurn: 0, revision: 1 },
    ],
    turns: [],
  };
  materialize(world, {
    id: "shen-qinghe", name: "沈清和", locationId: "courtyard",
    description: "青云宗掌门，成年女性，着素青长衣。",
    persona: "沉静坦率，有自己的判断，愿意听取来意；对玩家的态度随实际相处形成。",
    goals: ["照料宗门事务"],
  });
  promote(world, "shen-qinghe");
  world.openingEventIds = world.npc!.events.map(event => event.id);
  return world;
}
