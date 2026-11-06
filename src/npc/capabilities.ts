import { randomUUID } from "node:crypto";
import type { ExplorationWorld } from "../exploration/types.js";
import type { ActionStep, Npc } from "./types.js";
import { actor, emit, learnContacts, location, state, witnesses } from "./state.js";
import { fields, identifier, integer, text } from "./validation.js";

export interface CapabilityContext { world: ExplorationWorld; npc: Npc }
/** Internal extensions execute in a cloned world; persistence remains the host's responsibility. */
export interface NpcCapability {
  id: string;
  version: number;
  description: string;
  validate(args: Record<string, unknown>): void;
  duration(context: CapabilityContext, args: Record<string, unknown>): number;
  execute(context: CapabilityContext, args: Record<string, unknown>): void;
}
export class CapabilityRegistry {
  private readonly entries = new Map<string, NpcCapability>();
  register(capability: NpcCapability): this {
    if (this.entries.has(capability.id)) throw new Error("能力重复注册");
    this.entries.set(capability.id, capability); return this;
  }
  get(step: ActionStep): NpcCapability {
    const entry = this.entries.get(step.capability);
    if (!entry || entry.version !== step.version) throw new Error("能力不存在或版本不兼容：" + step.capability);
    entry.validate(step.args); return entry;
  }
  describe() { return [...this.entries.values()].map(({ id, version, description }) => ({ id, version, description })); }
}

export function defaultCapabilities(): CapabilityRegistry {
  return new CapabilityRegistry()
    .register({
      id: "move", version: 1,
      description: '前往自己已知的地点。args={"destinationId":"地点ID"}；首版固定需10分钟，期间保持出发地，完成时抵达。',
      validate(args) { identifier(fields(args, ["destinationId"]).destinationId); },
      duration({ npc, world }, args) {
        if (!npc.knownLocations.includes(String(args.destinationId)) || !world.regions.some(r => r.id === args.destinationId)) throw new Error("目的地尚未知晓或不存在");
        if (npc.locationId === args.destinationId) return 0;
        return 10;
      },
      execute({ world, npc }, args) {
        const previous = npc.locationId;
        emit(world, npc.id, "action", `${npc.name}离开了此地。`, witnesses(world, previous));
        npc.locationId = String(args.destinationId);
        learnContacts(world, npc);
        emit(world, npc.id, "action", `${npc.name}抵达${world.regions.find(r => r.id === npc.locationId)!.name}。`, witnesses(world, npc.locationId));
      },
    })
    .register({
      id: "work", version: 1,
      description: '在当前地点做不改变他人或资源的个人活动（整理、练习、休息）。args={"activity":"活动内容","minutes":30}，1–1440分钟。完成仅记录活动，不凭空生成物品、技能或治愈。',
      validate(args) { const a = fields(args, ["activity", "minutes"]); text(a.activity, 300); integer(a.minutes, 1, 1440); },
      duration(_ctx, args) { return Number(args.minutes); },
      execute({ world, npc }, args) { emit(world, npc.id, "action", `${npc.name}完成个人活动：${args.activity}`, witnesses(world, npc.locationId)); },
    })
    .register({
      id: "send", version: 1,
      description: '发送消息。args={"targetId":"收件人ID","channel":"letter或telepathy","text":"消息"}。信件寄往已知地址，30分钟后目标仍在该地址才送达，否则退信；传音仅同地可达、立即送达。',
      validate(args) { const a = fields(args, ["targetId", "channel", "text"]); identifier(a.targetId); text(a.text, 1800); if (a.channel !== "letter" && a.channel !== "telepathy") throw new Error("未知通信渠道"); },
      duration({ world, npc }, args) {
        if (args.targetId === npc.id || !npc.contacts.some(c => c.id === args.targetId)) throw new Error("收件人未知或是自己");
        if (args.channel === "telepathy" && location(world, String(args.targetId)) !== npc.locationId) throw new Error("传音超出范围");
        return 0;
      },
      execute({ world, npc }, args) {
        const address = args.channel === "telepathy" ? npc.locationId : npc.contacts.find(c => c.id === args.targetId)!.address;
        state(world).letters.push({ id: randomUUID(), fromId: npc.id, toId: String(args.targetId), text: String(args.text), channel: args.channel as "letter" | "telepathy", address, sentAt: world.timeMinutes, dueAt: world.timeMinutes + (args.channel === "letter" ? 30 : 0), status: "in_transit" });
        emit(world, npc.id, "action", `已发出${args.channel === "letter" ? "信件" : "传音"}，等待送达。`, [npc.id]);
      },
    })
    .register({
      id: "give", version: 1,
      description: '交付自己实际持有的物品。args={"targetId":"目标ID","itemId":"物品ID","quantity":1}。目标需在场，扣除自身数量并增加目标持有量；不代表对方同意交易。',
      validate(args) { const a = fields(args, ["targetId", "itemId", "quantity"]); identifier(a.targetId); identifier(a.itemId); integer(a.quantity, 1, 1000); },
      duration({ world, npc }, args) {
        if (args.targetId === npc.id || location(world, String(args.targetId)) !== npc.locationId) throw new Error("交付目标不在场");
        if ((npc.inventory[String(args.itemId)] ?? 0) < Number(args.quantity)) throw new Error("实际持有数量不足");
        return 0;
      },
      execute({ world, npc }, args) {
        const id = String(args.itemId), quantity = Number(args.quantity);
        npc.inventory[id] = (npc.inventory[id] ?? 0) - quantity;
        const inventory = args.targetId === "player" ? state(world).playerInventory : actor(world, String(args.targetId)).inventory;
        inventory[id] = (inventory[id] ?? 0) + quantity;
        emit(world, npc.id, "action", `${npc.name}向${args.targetId}交付${quantity}份${id}。`, witnesses(world, npc.locationId));
      },
    });
}
