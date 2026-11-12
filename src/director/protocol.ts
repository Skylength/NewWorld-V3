import type { ExplorationWorld } from "../exploration/types.js";
import { fields, identifier, list, text } from "../npc/validation.js";
import { actor, emit, notify, speak, witnesses } from "../npc/state.js";

export interface DirectorInteraction {
  phase?: "start" | "arrival";
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
  speeches?: { speakerId: string; targetId: string; text: string; phase?: "start" | "arrival" }[];
}

export function parseDirectorSignals(value: unknown): DirectorSignals {
  if (value === undefined) return { interactions: [], observations: [] };
  const raw = fieldsWithOptionalSpeeches(value);
  const data = fields(raw.base, ["interactions", "observations"]);
  return {
    speeches: raw.speeches === undefined ? [] : list(raw.speeches, 8, value => {
      const { phase, base } = phaseFields(value);
      const d = fields(base, ["speakerId", "targetId", "text"]);
      return { speakerId: identifier(d.speakerId), targetId: identifier(d.targetId), text: text(d.text, 1800), ...(phase ? { phase } : {}) };
    }),
    interactions: list(data.interactions, 4, value => {
      const { phase, base } = phaseFields(value);
      const d = fields(base, ["targetId", "sourceText"]);
      return { targetId: identifier(d.targetId), sourceText: text(d.sourceText, 1800), ...(phase ? { phase } : {}) };
    }),
    observations: list(data.observations, 8, value => {
      const d = fields(value, ["locationId", "text"]);
      return { locationId: identifier(d.locationId), text: text(d.text, 600) };
    }),
  };
}

function phaseFields(value: unknown): { base: unknown; phase: "start" | "arrival" | undefined } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("场景信号必须是对象");
  const { phase, ...base } = value as Record<string, unknown>;
  if (phase !== undefined && phase !== "start" && phase !== "arrival") throw new Error("交谈阶段无效");
  return { base, phase };
}

function fieldsWithOptionalSpeeches(value: unknown): { base: unknown; speeches: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Director 信号必须为对象");
  const { speeches, ...base } = value as Record<string, unknown>;
  return { base, speeches };
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
  for (const speech of signals.speeches ?? []) {
    const npc = actor(world, speech.speakerId);
    if (npc.mode !== "background" || npc.locationId !== world.playerLocationId) throw new Error("Director 只能提交当前场景普通人物的对白");
    speak(world, npc.id, speech.targetId, speech.text);
  }
}

export const directorInstructions = `
普通人物mode=background的当前问答由你负责表现，tracked仅表示玩家关注，不代表已启用独立决策。玩家直接问普通人物时，应给出符合处境的回答、拒绝或有依据的沉默反应；不能因等待并不存在的独立决策而把回合停在“问题已经问出，人物尚未回应”。独立人物mode=agent仍交给其本人决策。
玩家向普通人物实际说出的本轮交谈也必须写入interactions，不能只在narration转述而遗漏发言经历；普通人物回应另外写入speeches。对象尚不明确时先澄清，不擅自选一个targetId；创作备注、假设和未说出口的心理不得作为发言投递。
interactions.sourceText不是整段action的复制：输入明确用引号标出台词时，只逐字截取引号内部真正说出口的内容，不包含“我转向某人说”、引号外括号中的创作备注或解释。例如输入“我对她说：‘你好。’（她性情谨慎，这是设定）”，sourceText只能是“你好。”。没有显式台词的转述式询问才引用询问部分，同样排除创作指令；括号若在实际台词内则按原话保留，不按括号统一删文本。
interactions仅是同地当面交谈，不是远程喊话渠道。先核对目标locationId与本阶段玩家实际地点；向异地熟人喊名字、说“你怎么来了”不证明对方已到场，也不能直接投递。可以记录玩家在当前地点喊话且未获回应，但不能声称异地人物听见、移动或回复；需要通信时沿已有通信能力，不凭声音传播跨地点。
输出结构约束：speeches只能位于director对象内，即director.speeches；顶层不能出现speeches、interactions或observations。profileChanges、identityChanges、portrayalChanges、commitments才是顶层可选数组。
【普通人物对白】director额外支持speeches数组，每项为{"speakerId":"普通人物ID","targetId":"player或同地人物ID","text":"实际对白"}，最多8条。text只放实际说出口的台词，不包含“她说”“笑了笑”等动作描写或外层引号。普通人物的实际发言必须在这里保存，不只写在narration或observations里；没有发言用空数组。禁止代写mode=agent人物发言。按已提供共同经历延续交往，不把人物是否受关注当作关系重置。interactions和speeches可带phase=start或arrival；当前场景立即交谈用start，等待/抵达后的交谈用arrival。省略时按当前是否在场决定。不能提前编造独立人物尚未发生的回应。
【Director 与独立 NPC 协作】你是世界创作 Director Agent。输出 director 字段：
{"interactions":[{"targetId":"在场人物ID","sourceText":"玩家原输入中表示向该人物说话或询问的连续原文"}],"observations":[{"locationId":"本轮最终地点ID","text":"当地实际可见或可听见的事件"}],"speeches":[{"speakerId":"普通人物ID","targetId":"player","text":"实际对白"}]}。
没有交谈或观察时使用空数组。interactions最多4项、每个人一次，sourceText必须逐字引用输入，最多1800字符，不补造玩家台词。当前在场人物的交谈先于本轮休息、旅行等时间推进投递；抵达后才见到的人在抵达时投递。若玩家明确要等待之后再谈，停在需要新选择的时点，不提前投递。询问人物的转述式输入也可原样交给人物理解；玩家未说出口的心理、假设、界外反馈不得投递。
玩家与mode=agent人物交谈时必须通过interactions交给其独立Agent，不要求玩家切换面板。你不能替该人物回答、承诺、拒绝或执行行动。narration只给环境与玩家已授权行动，不预写独立人物的反应。
observations最多8项，每项600字符，仅描述最终地点当时可感知的公开事件，宿主决定哪些人物实际在场并形成记忆。不要复制整轮叙述、秘密、私人目标、异地活动或猜测。没有新变化不强制制造观察或冲突。普通人物对白统一通过speeches保存，不在observations重复；observations只记录其他可感知变化，陈述不等于事实。
createNpcs可带appearance=start或arrival：当前立即出现用start，推进后才出现用arrival；省略时当前地点的人在start创建，其他地点在arrival创建。有具体身份、后续交往价值的人必须通过createNpcs实体化；玩家明确创建人物时保留其给出的姓名、背景与目标，缺失细节合理补全。不能因创建人物而自动启用Agent。
`;
