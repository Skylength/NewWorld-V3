import { prepareSummary, parseSummary, summarySignature } from "../memory/summaries.js";
import { applyPortrayals } from "../npc/portrayal.js";
import { applyCommitmentChanges, commitmentEvidence } from "../npc/commitments.js";
import { deliverDirectorSignals } from "../director/protocol.js";
import { applyIdentityChanges, bindCreatedCharacters } from "../npc/identity.js";
import { applyProfileChanges } from "../npc/profile.js";
import { randomUUID } from "node:crypto";
import { createPiModel, type ModelConfig } from "../agent/model.js";
import type { PiModelRuntime } from "../agent/runtime.js";
import { createInitialWorld, applyWorldTurn, parseWorldTurnDraft } from "./state.js";
import { buildExplorationContext } from "./context.js";
import { runWorldModel } from "./model.js";
import { buildNarrationContext } from "./narration.js";
import { ExplorationStore } from "./store.js";
import type { ExplorationContext, ExplorationIntent, ExplorationModelCall, ExplorationRun, ExplorationSave, ExplorationView } from "./types.js";
import { defaultCapabilities } from "../npc/capabilities.js";
import { advanceNpcs, recoverNpcs } from "../npc/runtime.js";
import { actor, emit, learnContacts, materialize, notify, playerNpcView, promote, speak, state as npcState, trackCharacter, witnesses } from "../npc/state.js";
import { integer, parseSeed, text as npcText } from "../npc/validation.js";
import type { NpcRun } from "../npc/types.js";

export class ExplorationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

function commandFingerprint(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(commandFingerprint).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + commandFingerprint(item)).join(",") + "}";
  return JSON.stringify(value);
}

export interface ExplorationServiceOptions {
  directory: string;
  model?: ModelConfig;
  modelRuntime?: PiModelRuntime;
  textModel?: ModelConfig;
  textModelRuntime?: PiModelRuntime;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface WorldCommand { commandId: string; worldId: string; baseRevision: number }

export class ExplorationService {
  private readonly capabilities = defaultCapabilities();
  private readonly store: ExplorationStore;
  private save: ExplorationSave;
  private active: { runId: string; controller: AbortController; promise: Promise<void>; maintenance?: boolean } | null = null;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  constructor(private readonly options: ExplorationServiceOptions) {
    this.store = new ExplorationStore(options.directory);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    const current = this.store.currentId();
    this.save = current ? this.recover(this.store.load(current)) : { world: createInitialWorld(), runs: [] };
    this.store.save(this.save);
    this.store.select(this.save.world.id);
  }
  private recover(save: ExplorationSave): ExplorationSave {
    recoverNpcs(save.world);
    for (const run of save.runs) if (run.status === "running") {
      run.status = "failed";
      run.failureStage = run.stage && run.stage !== "done" ? run.stage : "structure";
      run.phase = "运行已中断";
      run.error = "上次进程在回合完成前退出；本轮未提交，也未自动重新请求模型。中断时的调用用量可能不完整。";
      run.finishedAt = new Date().toISOString();
      for (const call of run.calls ?? []) if (call.status === "running") {
        call.status = "failed";
        call.error = run.error;
        call.finishedAt = run.finishedAt;
      }
    }
    return save;
  }
  private redact(value: string): string {
    for (const secret of [this.options.model?.apiKey, this.options.textModel?.apiKey]) {
      if (secret) value = value.split(secret).join("[REDACTED]");
    }
    return value;
  }
  private configured(): boolean {
    return Boolean((this.options.modelRuntime || (this.options.model?.apiKey && this.options.model.modelId))
      && (this.options.textModelRuntime || (this.options.textModel?.apiKey && this.options.textModel.modelId)));
  }
  private modelNames() {
    const structureModel = this.options.modelRuntime?.model.id ?? this.options.model?.modelId ?? "未配置";
    const textModel = this.options.textModelRuntime?.model.id ?? this.options.textModel?.modelId ?? "未配置";
    return { structureModel, textModel, model: structureModel + " → " + textModel };
  }
  private idle(): void {
    if (this.active?.maintenance) { this.active.controller.abort(); this.active = null; }
    if (this.active) throw new ExplorationError("当前回合尚未结束，请等待或先取消。", 409);
  }
  getView(): ExplorationView {
    return structuredClone({
      ...this.save,
      npcView: playerNpcView(this.save.world),
      activeRunId: this.active?.maintenance ? null : this.active?.runId ?? null,
      nextContext: buildExplorationContext(this.save.world, ""),
      config: {
        configured: this.configured(),
        ...this.modelNames(),
        mode: this.options.modelRuntime || this.options.textModelRuntime ? "scripted" : "live",
        timeoutMs: this.timeoutMs,
        maxOutputTokens: this.maxOutputTokens,
        structureMaxOutputTokens: this.maxOutputTokens,
        textMaxOutputTokens: 2048,
        maxModelRequests: npcState(this.save.world).actors.some(n => n.mode === "agent") ? 14 : 2,
      },
    });
  }
  exportSave(): ExplorationSave { return structuredClone(this.save); }
  getNpcView() { return structuredClone({ worldId: this.save.world.id, revision: this.save.world.revision, time: this.save.world.timeMinutes, active: Boolean(this.active), ...playerNpcView(this.save.world) }); }
  private npcRuntime(): PiModelRuntime {
    if (this.options.textModelRuntime) return this.options.textModelRuntime;
    if (!this.options.textModel?.apiKey) throw new ExplorationError("请先配置角色模型", 503);
    return createPiModel(this.options.textModel);
  }
  startNpcOperation(payload: Record<string, unknown>): string {
    this.idle();
    const commandId = npcText(payload.commandId, 80);
    const fingerprint = commandFingerprint(payload);
    const receipt = npcState(this.save.world).receipts.find(r => r.id === commandId);
    if (receipt) {
      if (commandFingerprint(JSON.parse(receipt.fingerprint)) !== fingerprint) throw new ExplorationError("命令ID已用于不同参数", 409);
      return commandId;
    }
    if (payload.worldId !== this.save.world.id || payload.baseRevision !== this.save.world.revision) throw new ExplorationError("世界已变化，请刷新重试", 409);
    const world = structuredClone(this.save.world);
    const s = npcState(world);
    let target = world.timeMinutes;
    let run = false;
    if (s.advance && payload.kind !== "continue" && payload.kind !== "stop") throw new ExplorationError("请先继续或停止未完成的时间推进", 409);
    switch (payload.kind) {
      case "track": {
        if (typeof payload.tracked !== "boolean") throw new ExplorationError("tracked 必须为布尔值");
        trackCharacter(world, npcText(payload.npcId, 80), payload.tracked); break;
      }
      case "create": {
        const seed = parseSeed(payload.seed);
        if (seed.locationId !== world.playerLocationId) throw new ExplorationError("只能在当前场景创建人物");
        materialize(world, seed); break;
      }
      case "promote": promote(world, npcText(payload.npcId, 80)); run = true; break;
      case "talk": speak(world, "player", npcText(payload.npcId, 80), npcText(payload.text, 1800)); run = true; break;
      case "advance": target += integer(payload.minutes, 1, 525600); run = true; break;
      case "continue": if (!s.advance) throw new ExplorationError("没有待继续的推进"); target = s.advance.target; run = true; break;
      case "stop": s.advance = null; break;
      default: throw new ExplorationError("未知人物操作");
    }
    // Fail before accepting a command when inference is required but not configured.
    if (run && s.actors.some(n => n.mode === "agent")) this.npcRuntime();
    s.receipts.push({ id: commandId, fingerprint });
    if (run) s.advance = { target, status: "running", reason: null };
    world.revision++;
    const next = { ...this.save, world }; this.store.save(next); this.save = next;
    if (!run) return commandId;
    const controller = new AbortController();
    const active = { runId: commandId, controller, promise: Promise.resolve() };
    this.active = active;
    const started = performance.now();
    const priorRuns = new Set(npcState(world).runs.map(r => r.id));
    active.promise = advanceNpcs(world, target, {
      registry: this.capabilities, runtime: () => this.npcRuntime(), signal: controller.signal, redact: value => this.redact(value),
      persist: updated => { const nextSave = { ...this.save, world: structuredClone(updated) }; this.store.save(nextSave); this.save = nextSave; },
    }).then(async result => {
      if (!result.done) return;
      const modelRequests = npcState(this.save.world).runs.filter(r => !priorRuns.has(r.id)).reduce((sum, r) => sum + r.requests, 0);
      await this.maintainSummary({ modelRequests, usage: null }, controller, started, 180000, 12).catch(() => {});
    }).catch(error => {
      const failed = structuredClone(this.save);
      npcState(failed.world).advance = { target, status: "paused", reason: this.redact(error instanceof Error ? error.message : String(error)) };
      this.store.save(failed); this.save = failed;
    }).finally(() => { if (this.active === active) this.active = null; });
    return commandId;
  }
  listSaves(): ReturnType<ExplorationStore["list"]> { return this.store.list(); }
  newWorld(): void {
    this.idle();
    const next = { world: createInitialWorld(), runs: [] };
    this.store.save(next); this.store.select(next.world.id); this.save = next;
  }
  loadWorld(id: string): void {
    this.idle();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new ExplorationError("无效存档 ID");
    let loaded: ExplorationSave;
    try { loaded = this.store.load(id); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new ExplorationError("找不到该存档", 404);
      throw error;
    }
    const next = this.recover(loaded);
    this.store.save(next); this.store.select(id); this.save = next;
  }
  private replayCommand(command: WorldCommand | undefined, action: string, intent: ExplorationIntent): string | undefined {
    if (!command) return undefined;
    npcText(command.commandId, 80);
    if (!Number.isSafeInteger(command.baseRevision) || command.baseRevision < 0 || command.worldId !== this.save.world.id) throw new ExplorationError("命令世界或版本无效", 409);
    const receipt = this.save.world.commandReceipts?.find(r => r.commandId === command.commandId);
    if (receipt) {
      if (receipt.fingerprint !== commandFingerprint({ command, action, intent })) throw new ExplorationError("命令ID已用于不同参数", 409);
      return receipt.runId;
    }
    if (command.baseRevision !== this.save.world.revision) throw new ExplorationError("世界已变化，请刷新重试", 409);
    return undefined;
  }
  startTurn(action: string, mode: "interact" | "explore" = "interact", command?: WorldCommand): string {
    if (mode !== "interact" && mode !== "explore") throw new ExplorationError("无效的行动模式");
    return this.startOperation(action, { kind: mode }, command);
  }
  startTravel(destinationId: string, worldId: string, baseRevision: number, commandId?: string): string {
    const world = this.save.world;
    const destination = world.regions.find(region => region.id === destinationId);
    if (!destination) throw new ExplorationError("该地图地点不存在，请刷新地图。", 404);
    const action = `通过地图前往${destination.name}，抵达后观察当地。`;
    const intent: ExplorationIntent = { kind: "travel", destinationId };
    const command = commandId === undefined ? undefined : { commandId, worldId, baseRevision };
    const previous = this.replayCommand(command, action, intent);
    if (previous) return previous;
    this.idle();
    if (world.id !== worldId || world.revision !== baseRevision) throw new ExplorationError("地图已变化，请刷新后重新选择地点。", 409);
    if (destination.id === world.playerLocationId) throw new ExplorationError("你已经在这个地点。");
    return this.startOperation(action, intent, command);
  }
  private startOperation(action: string, intent: ExplorationIntent, command?: WorldCommand): string {
    action = action.trim();
    const replay = this.replayCommand(command, action, intent);
    if (replay) return replay;
    this.idle();
    if (npcState(this.save.world).advance) throw new ExplorationError("NPC 时间推进未完成，请先在人物面板继续", 409);
    action = action.trim();
    if (!action || action.length > 2000) throw new ExplorationError("请输入 1–2000 字的行动。");
    if (!this.configured()) throw new ExplorationError("请在 .env 中配置 LLM_API_KEY；文本默认 sol、结构默认 luna，然后重启服务。", 503);
    const context = buildExplorationContext(this.save.world, action, intent);
    const run: ExplorationRun = {
      id: randomUUID(), worldId: this.save.world.id, action, baseRevision: this.save.world.revision, intent, sourceRegionId: this.save.world.playerLocationId,
      status: "running", phase: "准备上下文", stage: "context", model: this.modelNames().model, calls: [],
      startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      modelRequests: 0, context, rawResponse: "", draft: null, changes: [], usage: null, error: null,
    };
    const previous = this.save;
    const acceptedWorld = structuredClone(previous.world);
    if (command) (acceptedWorld.commandReceipts ??= []).push({ commandId: command.commandId,
      fingerprint: commandFingerprint({ command, action, intent }), runId: run.id });
    const next: ExplorationSave = { world: acceptedWorld, runs: [...previous.runs.slice(-49), run] };
    this.store.save(next);
    this.save = next;
    const controller = new AbortController();
    const active = { runId: run.id, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.execute(run, controller).finally(() => { if (this.active === active) this.active = null; });
    return run.id;
  }
  private async execute(run: ExplorationRun, controller: AbortController): Promise<void> {
    const started = performance.now();
    const priorNpcRunIds = new Set(npcState(this.save.world).runs.map(r => r.id));
    const perform = async (role: "structure" | "text", context: ExplorationContext, runtime: PiModelRuntime): Promise<string> => {
      if (controller.signal.aborted) throw new Error("运行已取消");
      const remaining = this.timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new Error("整轮运行已超过时间预算，未提交世界变化。");
      run.stage = role;
      const call: ExplorationModelCall = {
        role, model: runtime.model.id, status: "running", context, rawResponse: "", modelRequests: 0,
        usage: null, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, error: null,
      };
      run.calls!.push(call);
      run.phase = role === "structure" ? "luna 正在判断与生成结构" : "sol 正在生成叙述";
      this.store.save(this.save);
      const stageStarted = performance.now();
      const summarizeUsage = () => {
        const attempts = npcState(this.save.world).runs.filter(r => run.npcRunIds?.includes(r.id));
        run.modelRequests = run.calls!.reduce((sum, c) => sum + c.modelRequests, 0) + attempts.reduce((sum, r) => sum + r.requests, 0);
        run.usage = run.calls!.every(c => c.usage !== null) && attempts.every(r => r.inputTokens !== null && r.outputTokens !== null)
          ? { input: run.calls!.reduce((n,c) => n+c.usage!.input,0) + attempts.reduce((n,r) => n+r.inputTokens!,0), output: run.calls!.reduce((n,c) => n+c.usage!.output,0) + attempts.reduce((n,r) => n+r.outputTokens!,0), totalTokens: run.calls!.reduce((n,c) => n+c.usage!.totalTokens,0) + attempts.reduce((n,r) => n+r.inputTokens!+r.outputTokens!,0) } : null;
      };
      try {
        const raw = await runWorldModel(context, {
          runtime, signal: controller.signal, timeoutMs: remaining, maxOutputTokens: role === "structure" ? this.maxOutputTokens : 2048,
          onProgress: update => {
            if (controller.signal.aborted || run.status !== "running") return;
            if (update.rawResponse !== undefined) call.rawResponse = this.redact(update.rawResponse);
            if (update.modelRequests !== undefined) call.modelRequests = update.modelRequests;
            if (update.usage !== undefined) call.usage = update.usage;
            if (role === "structure") run.rawResponse = call.rawResponse;
            summarizeUsage();
            // Persist the request reservation before the model boundary can send it.
            if (update.modelRequests !== undefined) this.store.save(this.save);
          },
        });
        call.rawResponse = this.redact(raw);
        call.status = "completed";
        return call.rawResponse;
      } catch (error) {
        call.status = controller.signal.aborted ? "cancelled" : "failed";
        call.error = this.redact(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        call.finishedAt = new Date().toISOString();
        call.durationMs = Math.round(performance.now() - stageStarted);
        summarizeUsage();
      }
    };
    try {
      const runtime = this.options.modelRuntime ?? createPiModel(this.options.model!);
      const raw = await perform("structure", run.context, runtime);
      if (controller.signal.aborted) throw new Error("运行已取消");
      run.rawResponse = this.redact(raw);
      run.stage = "validation"; run.phase = "检查结构与世界变化";
      const draft = bindCreatedCharacters(this.save.world, parseWorldTurnDraft(run.rawResponse));
      run.draft = draft;
      if (this.save.world.id !== run.worldId || this.save.world.revision !== run.baseRevision) throw new Error("世界状态已变化，本轮结果未提交。");
      if (run.intent?.kind === "travel") {
        if (draft.destinationId !== run.intent.destinationId) throw new Error("模型改变了地图指定的目的地，本轮未提交。");
        if (draft.createRegions.length || draft.enrichRegions.length) throw new Error("地图转场不能重建或修改已有地点档案，本轮未提交。");
      }
      const metadata = { id: run.id, action: run.action, createdAt: new Date().toISOString() };
      const result = applyWorldTurn(this.save.world, draft, metadata);
      // Leave room for a subsequent action. Never commit a successful turn that strands the save over the input limit.
      if (buildExplorationContext(result.world, "").characters > 20_000) {
        throw new Error("本轮新增内容会使下一轮必要上下文过大，因此未提交。当前世界仍可继续；请换一个地点或缩小这次探索范围。本版尚未加入长期档案摘要。");
      }
      const budget = { decisions: 0, perActor: new Map<string, number>() };
      let baseWorld = structuredClone(this.save.world);
      const startSeeds = (draft.createNpcs ?? []).filter(seed => seed.appearance === "start" || (seed.appearance === undefined && seed.locationId === baseWorld.playerLocationId));
      for (const seed of startSeeds) {
        if (seed.locationId !== baseWorld.playerLocationId) throw new Error("开始阶段人物必须出现在当前场景");
        materialize(baseWorld, seed);
      }
      const startProfiles = (draft.profileChanges ?? []).filter(c => npcState(baseWorld).actors.some(n => n.id === c.npcId));
      applyProfileChanges(baseWorld, startProfiles, run.id, run.action);
      const advanceCandidate = async (candidate: typeof baseWorld, target: number) => {
        const advance = await advanceNpcs(candidate, target, {
          budget, registry: this.capabilities, runtime: () => this.npcRuntime(), signal: controller.signal, redact: value => this.redact(value),
          timeoutMs: this.timeoutMs - (performance.now() - started),
          persist: updated => {
            const attempts = npcState(updated).runs.filter(r => !priorNpcRunIds.has(r.id));
            run.npcRunIds = attempts.map(r => r.id);
            run.modelRequests = (run.calls ?? []).reduce((n,c) => n+c.modelRequests,0) + attempts.reduce((n,r) => n+r.requests,0);
            run.usage = null;
            npcState(this.save.world).runs = structuredClone(npcState(updated).runs);
            this.store.save(this.save);
          },
        });
        if (!advance.done) throw new Error("区域回合未提交：" + npcState(advance.world).advance?.reason);
        return advance.world;
      };
      const beforeInteractions = (draft.director?.interactions ?? []).filter(interaction =>
        interaction.phase === "start" || (interaction.phase !== "arrival" && npcState(baseWorld).actors.some(n => n.id === interaction.targetId && n.locationId === baseWorld.playerLocationId)));
      const beforeSpeeches = (draft.director?.speeches ?? []).filter(speech => speech.phase === "start" || (speech.phase !== "arrival" && npcState(baseWorld).actors.some(n => n.id === speech.speakerId && n.locationId === baseWorld.playerLocationId)));
      const startEventCount = npcState(baseWorld).events.length;
      deliverDirectorSignals(baseWorld, { interactions: beforeInteractions, observations: [], speeches: beforeSpeeches }, run.action);
      const startPortrayals = (draft.portrayalChanges ?? []).filter(c => npcState(baseWorld).actors.some(n => n.id === c.npcId && n.locationId === baseWorld.playerLocationId)
        && [...c.beliefs, ...c.relations].every(entry => entry.evidenceIds.every(id =>
          id === "current_interaction" ? beforeInteractions.some(i => i.targetId === c.npcId)
            : id === "current_reply" ? beforeSpeeches.some(s => s.speakerId === c.npcId) : true)));
      applyPortrayals(baseWorld, startPortrayals, npcState(baseWorld).events.slice(startEventCount).map(e => e.id));
      // Register promises when their supporting speech exists, before advancing the clock.
      const startCommitments = (draft.commitments ?? []).filter(c => {
        const evidence = commitmentEvidence(baseWorld, c);
        return evidence && (c.status === "fulfilled" || !npcState(this.save.world).events.some(e => e.id === evidence.id));
      });
      applyCommitmentChanges(baseWorld, startCommitments);
      if (npcState(baseWorld).actors.some(n => n.mode === "agent") || npcState(baseWorld).letters.some(l => l.status === "in_transit") || (npcState(baseWorld).commitments ?? []).some(c => c.status === "open")) {
        run.phase = "推进同一时段的 NPC 活动";
        baseWorld = await advanceCandidate(baseWorld, baseWorld.timeMinutes + draft.elapsedMinutes);
      } else baseWorld.timeMinutes += draft.elapsedMinutes;
      if (controller.signal.aborted || performance.now() - started >= this.timeoutMs) throw new Error("运行取消或超过整轮时间预算，未提交");
      const finalResult = applyWorldTurn(baseWorld, { ...draft, elapsedMinutes: 0,
        createNpcs: (draft.createNpcs ?? []).filter(seed => !startSeeds.includes(seed)),
        profileChanges: (draft.profileChanges ?? []).filter(c => !startProfiles.includes(c)),
      }, metadata);
      finalResult.world.turns.at(-1)!.elapsedMinutes = draft.elapsedMinutes;
      finalResult.world.turns.at(-1)!.worldTime = finalResult.world.timeMinutes;
      for (const npc of npcState(finalResult.world).actors) {
        learnContacts(finalResult.world, npc);
      }
      // Only people actually present at the player's final location receive the visible scene result.
      if (baseWorld.playerLocationId !== finalResult.world.playerLocationId) {
        const present = witnesses(finalResult.world, finalResult.world.playerLocationId);
        emit(finalResult.world, "player", "observation", "玩家抵达此地。", present);
        for (const id of present) notify(finalResult.world, id, "玩家抵达此地，可以自行决定是否接触");
      }
      const arrivalEventCount = npcState(finalResult.world).events.length;
      deliverDirectorSignals(finalResult.world, { interactions: (draft.director?.interactions ?? []).filter(i => !beforeInteractions.includes(i)), observations: draft.director?.observations ?? [], speeches: (draft.director?.speeches ?? []).filter(s => !beforeSpeeches.includes(s)) }, run.action);
      const arrivalEventIds = npcState(finalResult.world).events.slice(arrivalEventCount).map(e => e.id);
      applyCommitmentChanges(finalResult.world, (draft.commitments ?? []).filter(c => !startCommitments.includes(c)));
      if (npcState(finalResult.world).actors.some(n => n.mode === "agent" && n.pending.length) || (npcState(finalResult.world).commitments ?? []).some(c => c.status === "open" && c.dueAt !== null && c.dueAt <= finalResult.world.timeMinutes)) {
        run.phase = "人物正在回应场景";
        finalResult.world = await advanceCandidate(finalResult.world, finalResult.world.timeMinutes);
      }
      applyPortrayals(finalResult.world, (draft.portrayalChanges ?? []).filter(c => !startPortrayals.includes(c)), arrivalEventIds);
      applyIdentityChanges(finalResult.world, draft.identityChanges ?? [], run.id, run.action);
      const visible = npcState(finalResult.world).events.filter(e => e.witnesses.includes("player") && !npcState(this.save.world).events.some(old => old.id === e.id));
      const textRuntime = this.options.textModelRuntime ?? createPiModel(this.options.textModel!);
      const narration = await perform("text", buildNarrationContext(finalResult.world, run.action, draft, visible), textRuntime);
      if (controller.signal.aborted || performance.now() - started >= this.timeoutMs) throw new Error("运行取消或超过整轮时间预算，未提交");
      if (!narration.trim() || narration.length > 6000 || /^\s*(\{|\[|```)/.test(narration)) throw new Error("文本阶段没有返回有效正文，本轮未提交");
      finalResult.world.turns.at(-1)!.narration = narration;
      finalResult.world.turns.at(-1)!.npcEventIds = visible.map(e => e.id);
      run.stage = "commit"; run.phase = "保存世界与人物结果";
      if (buildExplorationContext(finalResult.world, "").characters > 20_000) throw new Error("最终文本会使下一轮必要上下文过大，本轮未提交。");
      const completed: ExplorationRun = {
        ...run, status: "completed", stage: "done", phase: "已保存", changes: finalResult.changes,
        finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      };
      const next: ExplorationSave = { world: finalResult.world, runs: this.save.runs.map(r => r.id === run.id ? completed : r) };
      // Synchronous replace is the commit boundary: cancellation cannot interleave between disk and memory.
      this.store.save(next);
      this.save = next;
      await this.maintainSummary(completed, controller, started).catch(error => {
        completed.error = "可选摘要维护失败：" + this.redact(error instanceof Error ? error.message : String(error));
      });
    } catch (error) {
      for (const attempt of npcState(this.save.world).runs) if (!priorNpcRunIds.has(attempt.id)) {
        attempt.status = controller.signal.aborted ? "cancelled" : "failed";
        attempt.error = "所属区域回合未提交；保留实际请求记录，不保留推演后果。";
      }
      run.failureStage = run.stage === "done" ? "commit" : (run.stage ?? "context");
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.phase = controller.signal.aborted ? "已取消，未提交" : "失败，未提交";
      run.error = this.redact(error instanceof Error ? error.message : String(error));
      run.finishedAt = new Date().toISOString();
      run.durationMs = Math.round(performance.now() - started);
      try { this.store.save(this.save); }
      catch { run.error += "；失败记录无法写入磁盘，请保留当前页面并检查存档目录。"; }
    }
  }
  private async maintainSummary(run: Pick<ExplorationRun, "modelRequests" | "usage">, controller: AbortController, started: number, timeoutMs = this.timeoutMs, maxRequests = 14): Promise<void> {
    // Optional cache maintenance must never turn a committed game action into a failure.
    const remaining = timeoutMs - (performance.now() - started);
    if (!this.options.modelRuntime && !this.options.model) return;
    if (remaining <= 0 || run.modelRequests >= maxRequests || controller.signal.aborted) return;
    const input = prepareSummary(this.save.world);
    if (!input) return;
    const worldId = this.save.world.id, revision = this.save.world.revision;
    const npc = actor(this.save.world, input.npcId);
    const runtime = this.options.modelRuntime ?? createPiModel(this.options.model!);
    const callStarted = performance.now();
    const attempt: NpcRun = {
      kind: "summary", id: randomUUID(), npcId: npc.id, time: this.save.world.timeMinutes,
      startedAt: new Date().toISOString(), status: "running", requests: 0, tools: 0,
      inputTokens: null, outputTokens: null, context: JSON.stringify({ model: runtime.model.id, ...input.context }), raw: "", error: null,
    };
    npcState(this.save.world).runs.push(attempt);
    npcState(this.save.world).runs = npcState(this.save.world).runs.slice(-100);
    npc.summaryAttempt = { signature: input.signature, experienceCount: input.experienceCount, requests: 0, error: null };
    if (this.active) this.active.maintenance = true;
    try {
      this.store.save(this.save);
      const raw = await runWorldModel(input.context, { runtime,
        signal: controller.signal, timeoutMs: Math.min(20000, remaining), maxOutputTokens: 1200,
        onProgress: update => {
          if (update.rawResponse !== undefined) attempt.raw = this.redact(update.rawResponse);
          if (update.usage) { attempt.inputTokens = update.usage.input; attempt.outputTokens = update.usage.output; }
          if (update.modelRequests && npc.summaryAttempt!.requests === 0) {
            attempt.requests = update.modelRequests;
            npc.summaryAttempt!.requests = update.modelRequests; run.modelRequests += update.modelRequests; run.usage = null;
            this.store.save(this.save);
          }
        } });
      attempt.raw = this.redact(raw);
      if (controller.signal.aborted || this.save.world.id !== worldId || this.save.world.revision !== revision || summarySignature(actor(this.save.world, input.npcId)) !== input.signature) {
        attempt.status = "cancelled"; attempt.error = "维护已被新操作或资料变化取代，结果未写入。"; return;
      }
      npc.memorySummary = parseSummary(raw, input);
      attempt.status = "completed";
      this.store.save(this.save);
    } catch (error) {
      attempt.status = controller.signal.aborted ? "cancelled" : "failed";
      attempt.error = this.redact(error instanceof Error ? error.message : String(error));
      if (this.save.world.id !== worldId || this.save.world.revision !== revision) return;
      npc.summaryAttempt!.error = attempt.error;
      try { this.store.save(this.save); } catch { /* The committed world remains intact. */ }
    } finally {
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Math.round(performance.now() - callStarted);
      // A new operation may have cloned the world; update only this audit record, never its character cache.
      if (this.save.world.id === worldId) {
        const current = npcState(this.save.world).runs.find(r => r.id === attempt.id);
        if (current) {
          Object.assign(current, attempt);
          try { this.store.save(this.save); } catch { /* A cache audit failure cannot undo gameplay. */ }
        }
      }
    }
  }
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort(new Error("用户取消"));
    return true;
  }
  async waitForIdle(): Promise<void> { await this.active?.promise; }
}
