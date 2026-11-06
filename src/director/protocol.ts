import type { ExplorationWorld } from "../exploration/types.js";
import { fields, identifier, list, text } from "../npc/validation.js";
import { actor, emit, notify, speak, witnesses } from "../npc/state.js";

export interface DirectorInteraction {
  targetId: string;
  /** An exact excerpt, so the host never invents player dialogue. */
  sourceText: string;
}
export interface DirectorObservation {
  locationId: string;
  text: string;
}
export interface DirectorSignals {
  interactions: DirectorInteraction[];
  observations: DirectorObservation[];
}

export function parseDirectorSignals(value: unknown): DirectorSignals {
  if (value === undefined) return { interactions: [], observations: [] };
  const data = fields(value, ["interactions", "observations"]);
  return {
    interactions: list(data.interactions, 4, value => {
      const d = fields(value, ["targetId", "sourceText"]);
      return { targetId: identifier(d.targetId), sourceText: text(d.sourceText, 1800) };
    }),
    observations: list(data.observations, 8, value => {
      const d = fields(value, ["locationId", "text"]);
      return { locationId: identifier(d.locationId), text: text(d.text, 600) };
    }),
  };
}

/** Call only on a candidate snapshot. Recipients are determined by the host. */
export function deliverDirectorSignals(world: ExplorationWorld, signals: DirectorSignals, action: string): void {
  const targets = new Set<string>();
  for (const interaction of signals.interactions) {
    if (!action.includes(interaction.sourceText)) throw new Error("Director 交谈必须引用玩家原输入，不能新增台词");
    const npc = actor(world, interaction.targetId);
    if (npc.locationId !== world.playerLocationId) throw new Error("Director 不能向不在场人物投递当面交谈");
    if (targets.has(npc.id)) throw new Error("同轮不能重复向同一人物投递交谈");
    targets.add(npc.id);
    speak(world, "player", npc.id, interaction.sourceText);
  }
  for (const observation of signals.observations) {
    // The initial Director is scoped to the player's scene, not an omniscient offscreen broadcaster.
    if (observation.locationId !== world.playerLocationId) throw new Error("Director 观察必须属于本轮玩家所在场景");
    const recipients = witnesses(world, observation.locationId).filter(id => id !== "player");
    emit(world, "world", "observation", observation.text, recipients);
    for (const id of recipients) notify(world, id, "观察到场景变化：" + observation.text);
  }
}

export const directorInstructions = `
【Director 与独立 NPC 协作】你是世界创作 Director Agent。输出 director 字段：
{"interactions":[{"targetId":"在场人物ID","sourceText":"玩家原输入中表示向该人物说话或询问的连续原文"}],"observations":[{"locationId":"本轮最终地点ID","text":"当地实际可见或可听见的事件"}]}。
没有交谈或观察时使用空数组。interactions最多4项、每个人一次，sourceText必须逐字引用输入，最多1800字符，不补造玩家台词。当前在场人物的交谈先于本轮休息、旅行等时间推进投递；抵达后才见到的人在抵达时投递。若玩家明确要等待之后再谈，停在需要新选择的时点，不提前投递。询问人物的转述式输入也可原样交给人物理解；玩家未说出口的心理、假设、界外反馈不得投递。
玩家与mode=agent人物交谈时必须通过interactions交给其独立Agent，不要求玩家切换面板。你不能替该人物回答、承诺、拒绝或执行行动。narration只给环境与玩家已授权行动，不预写独立人物的反应。
observations最多8项，每项600字符，仅描述最终地点当时可感知的公开事件，宿主决定哪些人物实际在场并形成记忆。不要复制整轮叙述、秘密、私人目标、异地活动或猜测。没有新变化不强制制造观察或冲突。普通人物的实际公开对白与交往可记在观察中，清楚保留是谁说了什么，陈述不等于事实。
有具体身份、后续交往价值的人必须通过createNpcs实体化；玩家明确创建人物时保留其给出的姓名、背景与目标，缺失细节合理补全。不能因创建人物而自动启用Agent。
`;
