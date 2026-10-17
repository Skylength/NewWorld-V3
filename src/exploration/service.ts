import { randomUUID } from "node:crypto";
import { createPiModel, type ModelConfig } from "../agent/model.js";
import type { PiModelRuntime } from "../agent/runtime.js";
import { createInitialWorld, applyWorldTurn, parseWorldTurnDraft } from "./state.js";
import { buildExplorationContext } from "./context.js";
import { runWorldModel } from "./model.js";
import { buildNarrationContext } from "./narration.js";
import { ExplorationStore } from "./store.js";
import type { ExplorationContext, ExplorationModelCall, ExplorationRun, ExplorationSave, ExplorationView } from "./types.js";

export class ExplorationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
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

export class ExplorationService {
  private readonly store: ExplorationStore;
  private save: ExplorationSave;
  private active: { runId: string; controller: AbortController; promise: Promise<void> } | null = null;
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
    if (this.active) throw new ExplorationError("当前回合尚未结束，请等待或先取消。", 409);
  }
  getView(): ExplorationView {
    return structuredClone({
      ...this.save,
      activeRunId: this.active?.runId ?? null,
      nextContext: buildExplorationContext(this.save.world, ""),
      config: {
        configured: this.configured(),
        ...this.modelNames(),
        mode: this.options.modelRuntime || this.options.textModelRuntime ? "scripted" : "live",
        timeoutMs: this.timeoutMs,
        maxOutputTokens: this.maxOutputTokens,
        structureMaxOutputTokens: this.maxOutputTokens,
        textMaxOutputTokens: 2048,
        maxModelRequests: 2,
      },
    });
  }
  exportSave(): ExplorationSave { return structuredClone(this.save); }
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
  startTurn(action: string): string {
    this.idle();
    action = action.trim();
    if (!action || action.length > 2000) throw new ExplorationError("请输入 1–2000 字的行动。");
    if (!this.configured()) throw new ExplorationError("请在 .env 中配置 LLM_API_KEY；文本默认 sol、结构默认 luna，然后重启服务。", 503);
    const context = buildExplorationContext(this.save.world, action);
    const run: ExplorationRun = {
      id: randomUUID(), worldId: this.save.world.id, action, baseRevision: this.save.world.revision,
      status: "running", phase: "准备上下文", stage: "context", model: this.modelNames().model, calls: [],
      startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      modelRequests: 0, context, rawResponse: "", draft: null, changes: [], usage: null, error: null,
    };
    const previous = this.save;
    const next: ExplorationSave = { world: previous.world, runs: [...previous.runs.slice(-49), run] };
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
        run.modelRequests = run.calls!.reduce((sum, c) => sum + c.modelRequests, 0);
        run.usage = run.calls!.every(c => c.usage !== null)
          ? run.calls!.reduce((sum, c) => ({ input: sum.input + c.usage!.input, output: sum.output + c.usage!.output, totalTokens: sum.totalTokens + c.usage!.totalTokens }), { input: 0, output: 0, totalTokens: 0 }) : null;
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
      const draft = parseWorldTurnDraft(run.rawResponse);
      run.draft = draft;
      if (this.save.world.id !== run.worldId || this.save.world.revision !== run.baseRevision) throw new Error("世界状态已变化，本轮结果未提交。");
      const metadata = { id: run.id, action: run.action, createdAt: new Date().toISOString() };
      const result = applyWorldTurn(this.save.world, draft, metadata);
      // Leave room for a subsequent action. Never commit a successful turn that strands the save over the input limit.
      if (buildExplorationContext(result.world, "").characters > 20_000) {
        throw new Error("本轮新增内容会使下一轮必要上下文过大，因此未提交。当前世界仍可继续；请换一个地点或缩小这次探索范围。本版尚未加入长期档案摘要。");
      }
      const textRuntime = this.options.textModelRuntime ?? createPiModel(this.options.textModel!);
      const narration = await perform("text", buildNarrationContext(result.world, run.action, draft), textRuntime);
      if (controller.signal.aborted) throw new Error("运行已取消");
      if (performance.now() - started >= this.timeoutMs) throw new Error("整轮运行已超过时间预算，未提交世界变化。");
      if (!narration.trim() || narration.length > 6000) throw new Error("文本阶段没有返回长度有效的正文，未提交世界变化。");
      if (/^\s*(\{|\[|```)/.test(narration)) throw new Error("文本阶段返回了结构或代码而非游戏正文，未提交世界变化。");
      run.stage = "commit"; run.phase = "保存正文与世界变化";
      const finalResult = applyWorldTurn(this.save.world, { ...draft, narration }, metadata);
      if (buildExplorationContext(finalResult.world, "").characters > 20_000) throw new Error("最终文本会使下一轮必要上下文过大，本轮未提交。");
      const completed: ExplorationRun = {
        ...run, status: "completed", stage: "done", phase: "已保存", changes: finalResult.changes,
        finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      };
      const next: ExplorationSave = { world: finalResult.world, runs: this.save.runs.map(r => r.id === run.id ? completed : r) };
      // Synchronous replace is the commit boundary: cancellation cannot interleave between disk and memory.
      this.store.save(next);
      this.save = next;
    } catch (error) {
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
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort(new Error("用户取消"));
    return true;
  }
  async waitForIdle(): Promise<void> { await this.active?.promise; }
}
