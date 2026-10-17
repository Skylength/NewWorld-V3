import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../src/exploration/types.js";

/** Only the starting surroundings exist; later destinations are model generated. */
export function createInitialWorld(id: string = randomUUID()): ExplorationWorld {
  return {
    schemaVersion: 1,
    id,
    title: "青云初行",
    core: "这是一个宗门林立的修行世界。世界允许未知探索，人物和环境遵循已确认的事实与行动后果。玩家是一名刚加入青云宗的弟子，人物身份不随离开宗门而消失。尚未展开的地点可以按探索需要生成，已经存在的地点与变化必须延续。",
    revision: 0,
    timeMinutes: 0,
    playerLocationId: "gate",
    regions: [
      {
        id: "qingyun", name: "青云宗", parentId: null,
        summary: "坐落在群山之间的修行宗门。玩家刚加入这里，宗门内部尚待探索。",
        details: ["青云宗通过山门与外界往来。"], state: {},
        opportunities: ["可以了解宗门生活，也可以决定前往外界。"],
        createdTurn: 0, updatedTurn: 0, revision: 1,
      },
      {
        id: "gate", name: "山门", parentId: "qingyun",
        summary: "青云宗的山门，石阶通向宗门内部，山路向山下延伸。",
        details: ["山门旁有一块刻着青云宗三个字的石碑。"], state: {},
        opportunities: ["观察山门附近的环境。", "进入宗门，或沿山路离开。"],
        createdTurn: 0, updatedTurn: 0, revision: 1,
      },
    ],
    turns: [],
  };
}
