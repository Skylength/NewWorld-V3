let projections;
try { const modules = await Promise.all([import('./debug-data.js'), import('./prompt-diff.js')]); projections = Object.assign({}, ...modules); }
catch {
  const fallback = document.createElement('main'); fallback.className = 'startup-fallback';
  const title = document.createElement('h1'); title.textContent = '工作台资源未能加载';
  const copy = document.createElement('p'); copy.textContent = '如果正在访问旧服务，可打开新版入口继续使用同一世界；也可刷新重试。';
  const link = document.createElement('a'); link.href = 'http://127.0.0.1:4320/#debug'; link.className = 'button primary'; link.textContent = '打开新版工作台 ↗';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button secondary'; retry.textContent = '刷新重试'; retry.addEventListener('click', () => location.reload()); fallback.append(title, copy, link, retry); document.body.replaceChildren(fallback);
}
if (projections) initialize(projections);
function initialize({ deriveStages, buildTimeline, contextBreakdown, compareContexts, runOutcome, filterRuns, runMetrics, actualRequest, promptBaseline, promptDiff, unifiedPromptDiff }) {
  const $ = selector => document.querySelector(selector);
  const statuses = { running: '运行中', completed: '已提交', failed: '失败', cancelled: '已取消', pending: '未执行', unknown: '未记录' };
  const stageStatuses = { ...statuses, completed: '已完成' };
  const roles = { structure: '结构判断', text: '文本叙述' };
  const kinds = { system: '系统指令', world: '世界核心', location: '位置背景', related: '相关资料', history: '近期经历', registry: '地点目录', framing: '消息结构' };
  const changeNames = { created: '新增区域', enriched: '补充细节', state: '状态变化', moved: '位置迁移' };
  const state = { view: null, saves: [], runId: null, follow: true, tab: 'overview', stage: null, contextMode: 'structure', segment: null, changeRegion: null, regionId: null, mapRegionId: null, diffRole: 'structure', diffBaseline: 'previous', busy: false, cancelBusy: false, connected: false, refreshPromise: null, timer: null, toastTimer: null, evidence: '', panel: null, mode: location.hash === '#debug' ? 'debug' : 'play' };
  const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text != null) item.textContent = String(text); return item; };
  const btn = (text, cls, handler) => { const item = el('button', cls, text); item.type = 'button'; if (text) item.dataset.focusKey = text; item.addEventListener('click', handler); return item; };
  const num = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未报告';
  const duration = value => typeof value === 'number' ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s` : '未记录';
  const shortId = value => String(value || '').slice(-8);
  const dateTime = (value, full = false) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
  const worldTime = minutes => `第 ${Math.floor(minutes / 1440) + 1} 天 · ${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const run = () => state.view?.runs.find(item => item.id === state.runId) || null;
  const busy = () => state.busy || Boolean(state.view?.activeRunId);
  const region = id => state.view?.world.regions.find(item => item.id === id);
  const regionName = id => region(id)?.name || id || '未记录';
  const pill = (text, variant = '') => el('span', `pill ${variant}`, text);
  function regionPath(id) { const path = [], seen = new Set(); let item = region(id); while (item && !seen.has(item.id)) { seen.add(item.id); path.unshift(item.name); item = region(item.parentId); } return path; }
  function row(parent, name, value, mono = false) { const item = el('div', 'property-row'); item.append(el('span', 'property-label', name), el('span', mono ? 'mono property-value' : 'property-value', value)); parent.append(item); }
  function section(title, caption) { const item = el('section', 'surface-section'); const heading = el('div', 'section-heading'); heading.append(el('h3', '', title)); item.append(heading); if (caption) item.append(el('p', 'section-caption', caption)); return item; }
  function paragraphs(parent, text) { String(text || '').split(/\n\s*\n/).filter(Boolean).forEach(value => parent.append(el('p', '', value))); }
  function raw(title, value, key) { const item = el('details', 'raw-block'); item.dataset.detailKey = key || title; const heading = el('summary', '', title); heading.dataset.focusKey = 'raw-' + (key || title); item.append(heading, el('pre', '', value || '尚无记录')); return item; }
  function empty(title, description, action = false) { const item = el('div', 'empty-state'); item.append(el('div', 'empty-symbol', '◇'), el('h3', '', title), el('p', '', description)); if (action) { const link = el('a', 'button primary', '开始一次探索 ↗'); link.href = '#play'; item.append(link); } return item; }
  function paint(target, key, build) {
    const parent = $(target); if (parent.dataset.renderKey === key) return;
    const opened = new Set([...parent.querySelectorAll('details[open]')].map(item => item.dataset.detailKey));
    const focus = document.activeElement; const focusKey = parent.contains(focus) ? focus?.dataset.focusKey : null; const scroll = parent.scrollTop;
    parent.replaceChildren(); build(parent); parent.dataset.renderKey = key;
    parent.querySelectorAll('details').forEach(item => { if (opened.has(item.dataset.detailKey)) item.open = true; }); parent.scrollTop = scroll;
    if (focusKey) [...parent.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }
  function toast(message) { clearTimeout(state.toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600); }
  function actionError(message = '') { $('#action-error').textContent = message; $('#action-error').hidden = !message; if (message && state.mode !== 'play') toast(message); }
  async function copy(value) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('浏览器未允许复制，可展开原始证据手动选择。'); } }
  async function api(path, payload) { const response = await fetch(path, payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`); return data; }
  function mode() { state.mode = location.hash === '#debug' ? 'debug' : 'play'; document.body.dataset.mode = state.mode; $('#play-page').hidden = state.mode !== 'play'; $('#debug-page').hidden = state.mode !== 'debug'; ['play', 'debug'].forEach(value => { const link = $(`#mode-${value}`); if (value === state.mode) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }); document.title = `新世界 · ${state.mode === 'play' ? '游玩' : '调试工作台'}`; }
  function selectRun(id, follow = false) { if (state.tab === 'world') state.tab = 'overview'; state.runId = id; state.follow = follow; $('#follow-latest').checked = follow; state.stage = null; state.segment = null; state.changeRegion = null; state.diffBaseline = 'previous'; renderDebug(); renderRuns(); }
  function selectTab(tab) { state.tab = tab; renderDebug(); }
  function openRun(item, tab = 'overview') { selectRun(item.id); state.tab = tab; location.hash = '#debug'; renderDebug(); }
  function fillAction(item) { location.hash = '#play'; mode(); if (item.intent?.kind === 'travel') { state.mapRegionId = item.intent.destinationId; renderPlayMap(); showPanel('map'); toast('已定位原目的地，请点击地图地点重新前往。'); return; } $('#action-input').value = item.action; $('#action-mode').value = item.intent?.kind === 'explore' ? 'explore' : 'interact'; updateInput(); $('#action-input').focus(); toast('行动已填回输入框，尚未发送。'); }
  function exportRun(item) { const url = URL.createObjectURL(new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = `run-${item.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function renderRuns() {
    if (!state.view) return;
    const runs = filterRuns(state.view.runs, { status: $('#run-filter').value, query: $('#run-search').value }); $('#run-count').textContent = state.view.runs.length;
    paint('#run-list', JSON.stringify([runs.map(item => [item.id, item.status, item.phase]), state.runId, state.follow]), parent => {
      if (!runs.length) { parent.append(el('p', 'list-empty', state.view.runs.length ? '没有符合条件的运行。试试其他关键词或状态。' : '第一段运行记录将在探索后出现。')); return; }
      runs.forEach(item => {
        const button = btn('', `run-item ${item.id === state.runId ? 'selected' : ''}`, () => selectRun(item.id)); button.dataset.runId = item.id; button.dataset.focusKey = `run-${item.id}`; button.setAttribute('aria-pressed', String(item.id === state.runId));
        const top = el('span', 'run-item-top'); top.append(el('span', `status-dot ${item.status}`), el('span', 'mono run-short-id', shortId(item.id)), el('time', '', dateTime(item.startedAt)));
        const bottom = el('span', 'run-item-bottom'); bottom.append(el('span', `status-text ${item.status}`, statuses[item.status]), el('span', '', `基于 r${item.baseRevision}`));
        button.append(top, el('span', 'run-action', item.action), bottom); parent.append(button);
      });
    }); $('#debug-world-name').textContent = state.view.world.title; $('#current-version').textContent = `r${state.view.world.revision}`;
  }
  function renderSummary() {
    const item = run();
    paint('#run-summary', JSON.stringify([state.tab === 'world', item, state.follow, state.view.world.id, state.view.world.revision, state.connected]), parent => {
      if (state.tab === 'world') { const top = el('div', 'summary-topline'); top.append(el('span', 'eyebrow', 'CURRENT WORLD'), pill('当前快照', 'neutral')); parent.append(top, el('h2', '', state.view.world.title)); const meta = el('div', 'summary-meta'); meta.append(el('span', '', `${regionName(state.view.world.playerLocationId)} · ${worldTime(state.view.world.timeMinutes)}`), el('span', 'mono', `r${state.view.world.revision}`)); parent.append(meta); return; }
      const top = el('div', 'summary-topline'); top.append(el('span', 'eyebrow', 'INSPECT RUN')); if (item) top.append(pill(statuses[item.status], item.status), el('span', 'follow-caption', state.follow ? '跟随最新运行' : '已固定历史运行')); parent.append(top);
      if (!item) { parent.append(el('h2', '', '从一次行动，看见世界的变化'), el('p', 'summary-description', '在试玩中发起行动，回来查看上下文、模型调用与最终提交。')); return; }
      const title = el('h2', 'run-title', item.action); title.title = item.action; parent.append(title);
      const actions = el('div', 'summary-actions'); const id = btn(`ID ${shortId(item.id)} ⧉`, 'button quiet mono', () => copy(item.id)); id.id = 'copy-run-id'; id.title = item.id; const download = btn('导出 JSON ↗', 'button quiet', () => exportRun(item)); download.id = 'export-run'; actions.append(id, download);
      if (item.status === 'failed' || item.status === 'cancelled') { const fill = btn('填回试玩', 'button quiet', () => fillAction(item)); fill.id = 'retry-action'; actions.append(fill); }
      if (item.status === 'running') { const cancel = btn('取消运行', 'button danger-quiet', cancelTurn); cancel.disabled = state.cancelBusy || !state.connected; cancel.dataset.cancelRun = ''; actions.append(cancel); } parent.append(actions);
      const metrics = runMetrics(item); const metricsRow = el('div', 'run-metrics');
      const values = [['世界版本', item.status === 'completed' ? `r${item.baseRevision} → r${item.baseRevision + 1}` : `r${item.baseRevision} · 未提交`], ['整轮耗时', metrics.durationMs === null && item.status === 'running' ? '进行中' : duration(metrics.durationMs)], ['模型请求', `${metrics.requests} 次`], ['Token 用量', metrics.knownTokens === null ? '未报告' : `${num(metrics.knownTokens)}${metrics.usageComplete ? '' : ' · 部分'}`]];
      values.forEach(([label, value]) => { const metric = el('div', 'run-metric'); metric.append(el('span', '', label), el('strong', '', value)); metricsRow.append(metric); }); parent.append(metricsRow);
      if (item.status === 'failed' || item.status === 'cancelled') { const alert = el('div', `failure-strip ${item.status}`); alert.append(el('strong', '', item.status === 'failed' ? '这一轮未提交' : '运行已取消'), el('span', '', item.error ? item.error.slice(0, 240) + (item.error.length > 240 ? '…（完整错误见证据）' : '') : '世界状态保持不变。')); parent.append(alert); }
    });
  }
  function stageSelection(item) { const stages = deriveStages(item); return stages.find(value => value.id === state.stage) || stages.find(value => value.id === item?.failureStage) || stages.find(value => value.status === 'running') || stages.find(value => value.id === (item?.status === 'completed' && Array.isArray(item.calls) ? 'text' : 'structure')) || stages[0]; }
  function renderOverview(parent) {
    const item = run();
    if (!item) { parent.append(empty('还没有运行记录', '一次自然语言行动，会留下可追踪的背景装载、结构判断、文本生成与提交记录。', true)); renderEmptyEvidence(); return; }
    const stages = deriveStages(item), selected = stageSelection(item);
    const chainSection = section('执行链路', stages[0]?.legacy ? '历史单阶段记录：只呈现已有调用与提交证据。' : '选择一个节点，查看对应的输入、结果与错误。');
    const chain = el('div', `pipeline ${stages[0]?.legacy ? 'legacy' : ''}`); chain.setAttribute('aria-label', '回合运行链路');
    stages.forEach((stage, index) => {
      const button = btn('', `stage-node ${stage.status} ${stage.id === selected.id ? 'selected' : ''} role-${stage.id}`, () => { state.stage = stage.id; renderDebug(); }); button.dataset.stage = stage.id; button.dataset.status = stage.status; button.dataset.focusKey = `stage-${stage.id}`; button.setAttribute('aria-pressed', String(stage.id === selected.id));
      const circle = el('span', 'stage-circle', stage.status === 'completed' ? '✓' : stage.status === 'failed' ? '!' : stage.status === 'cancelled' ? '−' : String(index + 1).padStart(2, '0'));
      button.append(circle, el('strong', '', stage.label), el('span', 'stage-status', stageStatuses[stage.status]));
      if (stage.model) button.append(el('span', 'stage-model', stage.model)); else button.append(el('span', 'stage-model', stage.id === 'context' ? '上下文组装' : stage.id === 'validation' ? '程序检查' : stage.id === 'commit' ? '原子保存' : '尚无调用')); chain.append(button);
    }); chainSection.append(chain); parent.append(chainSection);
    const timing = buildTimeline(item); const timelineSection = section('模型时间轴', '条带只表示有记录的模型调用；程序各步骤未单独计时。');
    const timelineMeta = el('div', 'timeline-meta'); timelineMeta.append(el('strong', '', timing.totalMs === null ? '整轮耗时未记录' : `${duration(timing.totalMs)}${timing.live ? ' · 已经过' : ' · 整轮'}`), el('span', 'hint', 'Luna / Sol 按实际调用显示')); timelineSection.append(timelineMeta);
    if (!timing.bars.length) timelineSection.append(el('p', 'inline-empty', timing.unrecorded ? '此记录没有可定位的阶段时间，不能拆分耗时。' : '尚无可显示的模型时间记录。'));
    else {
      const chart = el('div', 'timeline-chart'); const axis = el('div', 'timeline-axis'); axis.append(el('span', '', '0 s'), el('span', '', duration(timing.totalMs))); chart.append(axis);
      timing.bars.forEach(bar => { const line = el('div', 'timeline-row'); const label = el('div', 'timeline-label'); label.append(el('span', `model-dot role-${bar.role}`), el('strong', '', roles[bar.role] || '模型调用'), el('span', '', `${duration(bar.durationMs)}${bar.live ? ' · 进行中' : ''}`)); const track = el('div', 'timeline-track'); const block = btn('', `timeline-bar role-${bar.role} ${bar.status}`, () => { state.stage = bar.role; renderDebug(); }); block.style.left = `${bar.left}%`; block.style.width = `${bar.width}%`; block.setAttribute('aria-label', `${bar.model}，${duration(bar.durationMs)}，${stageStatuses[bar.status]}`); block.title = `${bar.model} · ${duration(bar.durationMs)}`; track.append(block); line.append(label, track); chart.append(line); }); timelineSection.append(chart);
    }
    if (timing.otherMs !== null) timelineSection.append(el('p', 'timeline-note', `整轮其余耗时 ${duration(timing.otherMs)} · 未细分到程序步骤${timing.live ? '，数值仍在变化' : ''}`));
    if (timing.unrecorded) timelineSection.append(el('p', 'hint', `${timing.unrecorded} 个调用缺少可定位的时间记录。`)); parent.append(timelineSection);
    const outcome = runOutcome(item); const result = section('这一轮留下了什么');
    const destination = el('div', `journey-strip ${outcome.committed ? '' : 'candidate'}`); if (outcome.committed || item.draft) destination.append(el('span', 'journey-origin', outcome.from.name), el('span', 'journey-arrow', outcome.from.id === outcome.to.id ? '·' : '→'), el('strong', '', outcome.to.name), pill(outcome.committed ? '已提交' : '未提交', outcome.committed ? 'completed' : 'pending')); else destination.append(el('span', '', '未产生可展示的世界更新'), pill('未提交', 'pending')); result.append(destination);
    const resultText = outcome.committed ? `${outcome.changeCount} 项已提交变化${item.draft ? ` · 世界经过 ${item.draft.elapsedMinutes} 分钟` : ''}` : item.draft ? `${outcome.changeCount} 项候选变化仍未写入世界` : '尚无已解析的世界更新'; result.append(el('p', 'section-caption', resultText));
    if (outcome.groups.length) { const groups = el('div', 'outcome-links'); outcome.groups.forEach(group => groups.append(btn(`${group.name}  ${group.changes.length} 项 →`, 'outcome-link', () => { state.changeRegion = group.regionId; selectTab('changes'); }))); result.append(groups); }
    parent.append(result); renderStageEvidence(item, selected);
  }
  function evidenceHeader(parent, title, caption, status) { const header = el('div', 'inspector-heading'); if (status) header.append(pill(stageStatuses[status] || status, status)); header.append(el('h2', '', title)); if (caption) header.append(el('p', '', caption)); parent.append(header); }
  function setEvidence(value) { state.evidence = value; $('#copy-evidence').disabled = !value; }
  function renderEmptyEvidence() { paint('#evidence-content', 'empty', parent => parent.append(empty('证据会显示在这里', '选择节点、上下文片段或世界变化，检查其原始依据。'))); setEvidence(''); }
  function renderStageEvidence(item, stage) {
    const call = stage.call;
    setEvidence(JSON.stringify({ runId: item.id, stage: stage.id, status: stage.status, call, error: item.failureStage === stage.id ? item.error : null, ...(stage.id === 'validation' || stage.id === 'commit' ? { draft: item.draft, changes: item.changes } : {}) }, null, 2));
    paint('#evidence-content', JSON.stringify(['stage', item, stage.id]), parent => {
      parent.dataset.stageDetail = stage.id;
      evidenceHeader(parent, stage.label, stage.model || (stage.id === 'commit' ? '全部阶段成功后，世界与叙述一起保存。' : stage.id === 'validation' ? '检查结构、引用、层级与上下文容量。' : '本次运行的输入证据'), stage.status);
      if ((item.failureStage === stage.id || (!item.failureStage && stage.legacy)) && item.error) parent.append(el('div', 'callout error', item.error));
      if (stage.status === 'pending') parent.append(el('p', 'inline-empty', '尚未执行到这个环节。'));
      if (stage.id === 'context') {
        parent.append(el('blockquote', 'action-quote', item.action)); const context = item.calls?.find(value => value.role === 'structure')?.context || item.context;
        row(parent, '基于世界版本', `r${item.baseRevision}`); row(parent, '提示词字符', num(context.characters)); row(parent, '背景模块', context.modules.length);
        const modules = el('div', 'mini-modules'); context.modules.forEach(module => modules.append(pill(module.title, `kind-${module.kind}`))); parent.append(modules);
        parent.append(btn('检查上下文组成 →', 'button secondary full-width', () => { state.contextMode = 'structure'; selectTab('context'); }), raw('系统提示词', context.systemPrompt, 'system'), raw('完整输入', context.userPrompt, 'user'));
      } else if (stage.id === 'structure' || stage.id === 'text') {
        if (call) {
          const props = el('div', 'inspector-properties'); row(props, '实际模型', call.model, true); row(props, stage.legacy ? '历史运行状态' : '请求状态', stageStatuses[call.status]); row(props, '请求次数', call.modelRequests); row(props, '调用耗时', stage.legacy ? '未单独记录' : duration(call.durationMs)); row(props, '输入 / 输出 token', call.usage ? `${num(call.usage.input)} / ${num(call.usage.output)}` : '未报告'); parent.append(props);
          if (call.error && call.error !== item.error) parent.append(el('div', 'callout error', call.error));
          if (stage.id === 'structure' && item.draft) { const summary = section('结构结果'); summary.append(pill(item.status === 'completed' ? '已提交的依据' : '候选 · 未提交', item.status === 'completed' ? 'neutral' : 'pending')); row(summary, '新区域', item.draft.createRegions.length); row(summary, '区域补充', item.draft.enrichRegions.length); row(summary, '时间推进', `${item.draft.elapsedMinutes} 分钟`); summary.append(el('p', 'result-brief', item.draft.narration)); parent.append(summary); }
          if (stage.id === 'text' && call.rawResponse) { const text = section(item.status === 'completed' ? '玩家叙述' : '叙述候选 · 未提交'); paragraphs(text, call.rawResponse); text.classList.add('narration-preview'); parent.append(text); }
          parent.append(btn('检查本次上下文 →', 'button secondary full-width', () => { state.contextMode = stage.id; selectTab('context'); }), raw('原始模型输出', call.rawResponse, 'raw'), raw('系统提示词', call.context.systemPrompt, 'system'), raw('完整输入', call.context.userPrompt, 'user'));
        }
      } else if (stage.id === 'validation') {
        parent.append(el('div', `validation-result ${stage.status}`, stage.status === 'completed' ? '✓ 整份候选更新通过校验' : stage.status === 'failed' ? '! 候选更新未通过校验' : stage.status === 'running' ? '正在校验候选更新' : '暂无校验结果'));
        parent.append(el('p', 'hint', '没有逐项检查日志，不推测每一项是否通过。程序校验不等于开放行动的语义质量验证。')); if (stage.status === 'failed') parent.append(btn('检查结构模型输出 →', 'button secondary full-width', () => { state.stage = 'structure'; renderDebug(); })); if (item.draft) parent.append(raw('解析后的更新草稿', JSON.stringify(item.draft, null, 2), 'draft'));
      } else if (stage.id === 'commit') {
        const committed = item.status === 'completed'; parent.append(el('div', `commit-result ${committed ? 'completed' : ''}`, committed ? `r${item.baseRevision} → r${item.baseRevision + 1}` : `r${item.baseRevision} · 未提交`));
        parent.append(el('p', 'result-brief', committed ? '本次区域变化与玩家叙述已一起保存。' : '候选内容不会在提交前成为世界事实。')); row(parent, '已提交变化', item.changes.length); row(parent, '结束时间', item.finishedAt ? dateTime(item.finishedAt, true) : '尚未结束');
        parent.append(btn('查看世界变化 →', 'button secondary full-width', () => selectTab('changes')), raw('提交变化记录', JSON.stringify(item.changes, null, 2), 'changes'));
      }
      const metadata = { id: item.id, worldId: item.worldId, baseRevision: item.baseRevision, intent: item.intent, sourceRegionId: item.sourceRegionId, status: item.status, stage: item.stage, failureStage: item.failureStage, startedAt: item.startedAt, finishedAt: item.finishedAt, durationMs: item.durationMs, modelRequests: item.modelRequests, usage: item.usage }; parent.append(raw('运行元数据', JSON.stringify(metadata, null, 2), 'metadata'));
    });
  }
  function contextFor(item) { if (state.contextMode === 'preview') return state.view.nextContext; if (state.contextMode === 'text') return item?.calls?.find(value => value.role === 'text')?.context || null; return item?.calls?.find(value => value.role === 'structure')?.context || item?.context || null; }
  function renderContext(parent) {
    const item = run(); const switcher = el('div', 'view-switcher');
    [['structure', '结构请求'], ['text', '文本请求'], ['preview', '当前预览']].forEach(([value, label]) => { const button = btn(label, '', () => { state.contextMode = value; state.segment = null; renderDebug(); }); button.dataset.contextMode = value; button.dataset.focusKey = `context-${value}`; button.setAttribute('aria-pressed', String(state.contextMode === value)); switcher.append(button); }); parent.append(switcher);
    const context = contextFor(item); const note = state.contextMode === 'preview' ? `当前世界 r${state.view.world.revision} 的结构上下文预览；不是历史快照，下一次行动还会带入相关资料。` : item ? `所选运行的实际${state.contextMode === 'text' ? '文本' : '结构'}请求，基于 r${item.baseRevision}${state.contextMode === 'text' ? ' 与校验后的候选结果' : ''}。` : '发送行动后，会记录实际请求上下文。'; parent.append(el('p', 'view-note', note));
    if (!context) { parent.append(empty('这个请求尚无上下文', state.contextMode === 'text' ? '文本阶段尚未发起，或这是一条历史单阶段记录。可以查看结构请求或当前预览。' : '先发起一次探索，或切换到当前预览查看准备加载的背景。')); renderEmptyEvidence(); return; }
    const breakdown = contextBreakdown(context); const selected = breakdown.segments.find(value => value.id === state.segment) || breakdown.segments[0]; const composition = section('提示词组成', '按实际字符长度拆分；字符数不等于 token 用量。');
    const metric = el('div', 'composition-total'); metric.append(el('strong', '', num(breakdown.total)), el('span', '', '字符')); composition.append(metric);
    const bar = el('div', 'composition-bar'); bar.setAttribute('aria-label', '上下文字符组成');
    breakdown.segments.filter(segment => segment.characters > 0).forEach(segment => { const piece = btn('', `composition-segment kind-${segment.kind} ${selected?.id === segment.id ? 'selected' : ''}`, () => { state.segment = segment.id; renderDebug(); }); piece.style.width = `${segment.percent}%`; piece.dataset.moduleId = segment.id; piece.dataset.focusKey = `bar-${segment.id}`; piece.setAttribute('aria-label', `${segment.label}，${num(segment.characters)} 字符，${segment.percent.toFixed(1)}%`); piece.title = `${segment.label} · ${num(segment.characters)} 字符`; bar.append(piece); }); composition.append(bar);
    const entries = el('div', 'module-list'); breakdown.segments.forEach(segment => { const button = btn('', `module-item ${selected?.id === segment.id ? 'selected' : ''}`, () => { state.segment = segment.id; renderDebug(); }); button.dataset.moduleId = segment.id; button.dataset.focusKey = `module-${segment.id}`; button.setAttribute('aria-pressed', String(selected?.id === segment.id)); const heading = el('span', 'module-item-heading'); heading.append(el('span', `module-dot kind-${segment.kind}`), el('strong', '', segment.label), el('span', 'module-size mono', `${num(segment.characters)} · ${segment.percent.toFixed(1)}%`)); button.append(heading, el('span', 'module-reason', segment.reason)); entries.append(button); }); composition.append(entries); parent.append(composition);
    if (item && state.contextMode === 'preview') { const diff = compareContexts(item.calls?.find(value => value.role === 'structure')?.context || item.context, context); const changed = diff.filter(value => value.status !== 'unchanged'); const comparison = section('所选结构请求 → 当前预览', '跨时点比较，不能据此归因于某一轮行动。'); const diffList = el('div', 'context-diff-list'); if (!changed.length) diffList.append(el('p', 'hint', '装载模块与内容没有变化。')); changed.forEach(value => { const block = el('div', `context-diff ${value.status}`); block.append(el('span', '', value.status === 'added' ? '+' : value.status === 'removed' ? '−' : '↻'), el('strong', '', value.title), pill({ added: '新增装载', removed: '卸载', changed: '内容更新' }[value.status], value.status)); diffList.append(block); }); comparison.append(diffList); parent.append(comparison); }
    if (!selected) { renderEmptyEvidence(); return; } setEvidence(JSON.stringify({ runId: state.contextMode === 'preview' ? null : item?.id, contextMode: state.contextMode, module: selected }, null, 2));
    paint('#evidence-content', JSON.stringify(['module', state.contextMode, selected, item?.id]), inspector => { evidenceHeader(inspector, selected.label, kinds[selected.kind] || selected.kind); row(inspector, '字符数', num(selected.characters)); row(inspector, '占比', `${selected.percent.toFixed(1)}%`); const why = section('为什么加载'); why.append(el('p', 'result-brief', selected.reason)); inspector.append(why); const excerpt = section('内容速览'); excerpt.append(el('p', 'module-excerpt', selected.text.slice(0, 420) + (selected.text.length > 420 ? '…' : ''))); inspector.append(excerpt, raw('完整片段', selected.text, `module-${selected.id}`), raw('完整系统提示词', context.systemPrompt, 'system'), raw('完整用户输入', context.userPrompt, 'user')); });
  }
  function renderPromptDiff(parent) {
    const item = run();
    if (!item) { parent.append(empty('尚无请求可比较', '完成一次探索后，在这里查看实际提示词的逐行变化。')); renderEmptyEvidence(); return; }
    const switcher = el('div', 'view-switcher');
    for (const [role, label] of [['structure', '结构请求'], ['text', '文本请求']]) {
      const button = btn(label, '', () => { state.diffRole = role; state.diffBaseline = 'previous'; renderDebug(); });
      button.dataset.diffRole = role; button.setAttribute('aria-pressed', String(state.diffRole === role)); switcher.append(button);
    }
    parent.append(switcher);
    const after = actualRequest(item, state.diffRole);
    if (!after) { parent.append(empty('该阶段尚无实际请求', '请求未发送、该阶段未执行，或旧记录不包含此阶段。这里不会使用预览替代真实请求。')); renderEmptyEvidence(); return; }
    const { candidates, baseline } = promptBaseline(state.view.runs, item, state.diffRole, state.diffBaseline);
    const label = el('label', 'diff-baseline-label', '对比基线');
    const picker = el('select'); picker.id = 'diff-baseline'; picker.dataset.focusKey = 'diff-baseline';
    picker.append(new Option(candidates.length ? '上一条实际请求（同阶段）' : '无历史基线 · 首次请求', 'previous'));
    for (const candidate of [...candidates].reverse()) picker.append(new Option(`r${candidate.baseRevision} · ${shortId(candidate.id)} · ${statuses[candidate.status]} · ${candidate.action.slice(0, 35)}`, candidate.id));
    picker.value = candidates.some(candidate => candidate.id === state.diffBaseline) ? state.diffBaseline : 'previous';
    picker.disabled = !candidates.length; picker.addEventListener('change', () => { state.diffBaseline = picker.value; renderDebug(); }); label.append(picker); parent.append(label);
    const before = actualRequest(baseline, state.diffRole), files = promptDiff(before, after);
    const beforeLabel = baseline ? `r${baseline.baseRevision}-${shortId(baseline.id)}` : 'empty-first-request';
    const afterLabel = `r${item.baseRevision}-${shortId(item.id)}`;
    const patch = unifiedPromptDiff(files, beforeLabel, afterLabel);
    const header = el('div', 'prompt-diff-heading');
    header.append(el('span', 'mono', `${baseline ? beforeLabel : '首次内容（空基线）'} → ${afterLabel}`), el('span', 'diff-added-count', `+${files.reduce((n, file) => n + file.added, 0)}`), el('span', 'diff-removed-count', `−${files.reduce((n, file) => n + file.removed, 0)}`)); parent.append(header);
    parent.append(el('p', 'view-note', baseline ? '对比两次实际请求的原文。差异包含行动、历史、指令和区域变化；不等于全部由移动引起。失败请求也会如实保留。' : '这是该阶段最早的已保留请求。绿色表示首次提供的内容，不代表此前曾有一条空请求。'));
    const appendLine = (container, line) => {
      const node = el('div', `prompt-diff-line ${line.kind}`);
      node.append(el('span', 'diff-line-number', line.oldLine ?? ''), el('span', 'diff-line-number', line.newLine ?? ''), el('span', 'diff-sign', { added: '+', removed: '−', context: ' ' }[line.kind]), el('code', '', line.text || ' ')); container.append(node);
    };
    for (const file of files) {
      const panel = el('section', 'prompt-diff-file');
      const title = el('div', 'prompt-diff-file-heading'); title.append(el('strong', '', file.label), el('span', 'mono', `+${file.added} / −${file.removed}`)); panel.append(title);
      if (file.coarse) panel.append(el('p', 'hint', '变化块较大，按整块删除/新增展示，内容完整保留。'));
      let i = 0;
      while (i < file.lines.length) {
        if (file.lines[i].kind !== 'context') { appendLine(panel, file.lines[i++]); continue; }
        const start = i; while (i < file.lines.length && file.lines[i].kind === 'context') i++;
        const count = i - start;
        if (count <= 8) { for (let k = start; k < i; k++) appendLine(panel, file.lines[k]); continue; }
        for (let k = start; k < start + 3; k++) appendLine(panel, file.lines[k]);
        const folded = el('details', 'diff-unchanged'); folded.dataset.detailKey = `diff-${file.key}-${start}`;
        folded.append(el('summary', '', `展开 ${count - 6} 行未变化内容`));
        for (let k = start + 3; k < i - 3; k++) appendLine(folded, file.lines[k]); panel.append(folded);
        for (let k = i - 3; k < i; k++) appendLine(panel, file.lines[k]);
      }
      if (!file.lines.length) panel.append(el('p', 'hint', '两边内容均为空。'));
      parent.append(panel);
    }
    setEvidence(patch);
    paint('#evidence-content', JSON.stringify(['prompt-diff', item.id, baseline?.id, state.diffRole, patch]), inspector => {
      evidenceHeader(inspector, '请求提示词差异', roles[state.diffRole]);
      row(inspector, '基线运行', baseline ? shortId(baseline.id) : '无（首次请求）', true);
      row(inspector, '基线状态', baseline ? statuses[baseline.status] : '空基线');
      row(inspector, '当前运行', shortId(item.id), true); row(inspector, '当前状态', statuses[item.status]);
      inspector.append(el('p', 'hint', '红色 − 为删除，绿色 + 为新增。行号分别对应基线与当前请求；内容来自保存的实际模型请求。'), raw('完整统一差异', patch, 'prompt-patch'), raw('当前系统提示词', after.systemPrompt, 'diff-system'), raw('当前用户消息', after.userPrompt, 'diff-user'));
    });
  }
  function renderChanges(parent) {
    const item = run(); if (!item) { parent.append(empty('尚无世界变化', '探索产生的新增区域、细节补充、状态与位置变化会显示在这里。', true)); renderEmptyEvidence(); return; }
    const outcome = runOutcome(item);
    if (!outcome.committed) parent.append(el('div', 'callout warning', item.draft ? '以下为解析后的候选更新，尚未提交。它们没有改变当前世界。' : '这一轮没有提交世界变化，也没有可展示的候选更新。'));
    if (!outcome.committed && !item.draft) { parent.append(empty('没有可展示的候选更新', '可以返回运行链路，检查本次停止位置与原始输出。')); renderEmptyEvidence(); return; } const movement = section(outcome.committed ? '位置结果' : '候选位置'); const path = el('div', `location-transfer ${outcome.committed ? '' : 'candidate'}`);
    [['出发', outcome.from], [outcome.committed ? '到达' : '拟到达', outcome.to]].forEach(([label, place], index) => { if (index) path.append(el('span', 'transfer-arrow', outcome.from.id === outcome.to.id ? '＝' : '→')); const card = el('div', 'transfer-place'); card.append(el('span', 'eyebrow', label), el('strong', '', place.name), el('span', 'mono hint', place.id || '位置未记录')); path.append(card); }); movement.append(path); parent.append(movement);
    const changes = section(outcome.committed ? '已提交的区域变化' : '候选区域变化', `${outcome.groups.length} 个区域 · ${outcome.changeCount} 项${outcome.committed ? '实际' : '候选'}变化`);
    if (!outcome.groups.length) { changes.append(el('p', 'inline-empty', '没有区域变更记录。')); parent.append(changes); renderEmptyEvidence(); return; }
    const selected = outcome.groups.find(group => group.regionId === state.changeRegion) || outcome.groups[0]; const cards = el('div', 'change-region-grid');
    outcome.groups.forEach(group => { const button = btn('', `change-region-card ${selected.regionId === group.regionId ? 'selected' : ''} ${outcome.committed ? '' : 'candidate'}`, () => { state.changeRegion = group.regionId; renderDebug(); }); button.dataset.changeRegion = group.regionId; button.dataset.focusKey = `change-${group.regionId}`; button.setAttribute('aria-pressed', String(selected.regionId === group.regionId)); const heading = el('span', 'change-card-heading'); heading.append(el('span', 'region-glyph', group.changes.some(change => change.kind === 'created') ? '+' : '◇'), el('strong', '', group.name), el('span', '', '↗')); button.append(heading, el('span', 'mono hint', group.regionId)); const chips = el('span', 'change-chips'); Object.entries(changeNames).forEach(([kind, name]) => { const count = group.changes.filter(change => change.kind === kind).length; if (count) chips.append(pill(`${name} ${count}`, kind)); }); button.append(chips); cards.append(button); }); changes.append(cards); parent.append(changes);
    setEvidence(JSON.stringify({ runId: item.id, committed: outcome.committed, region: selected }, null, 2));
    paint('#evidence-content', JSON.stringify(['changes', item.id, selected, outcome.committed]), inspector => {
      evidenceHeader(inspector, selected.name, selected.regionId, outcome.committed ? 'completed' : 'pending'); if (!outcome.committed) inspector.append(el('div', 'callout warning', '候选内容 · 未写入世界'));
      selected.changes.forEach((change, index) => { const card = el('section', `change-evidence ${change.kind}`); card.append(pill(changeNames[change.kind], change.kind), el('h3', '', change.label));
        if (change.kind === 'created') { let created; try { created = JSON.parse(change.after); } catch {} if (created) { card.append(el('p', '', created.summary)); if (created.details?.length) { const list = el('ul', 'detail-list'); created.details.forEach(text => list.append(el('li', '', text))); card.append(list); } card.append(raw('新区域完整记录', change.after, `created-${index}`)); } else card.append(el('p', '', change.after || '无')); }
        else { const before = el('div', 'diff-value before'); before.append(el('span', 'diff-label', '之前'), el('p', '', change.before ?? '无已记录值')); const after = el('div', 'diff-value after'); after.append(el('span', 'diff-label', outcome.committed ? '之后' : '候选'), el('p', '', change.after ?? '删除此字段')); card.append(before, after); } inspector.append(card);
      });
    });
  }
  function renderWorld(parent) {
    const world = state.view.world; const selected = region(state.regionId) || region(world.playerLocationId); state.regionId = selected?.id;
    parent.append(el('p', 'view-note', `这里是当前已保存的世界 r${world.revision}，不会随左侧历史运行切换。`));
    const map = section('已展开的世界', `${world.regions.length} 个地点 · 地点按需生成，持续补充`); const tree = el('div', 'world-tree'); const seen = new Set();
    function entry(item, depth) { if (seen.has(item.id)) return; seen.add(item.id); const button = btn('', `world-region ${selected?.id === item.id ? 'selected' : ''}`, () => { state.regionId = item.id; renderDebug(); }); button.style.setProperty('--depth', Math.min(depth, 4)); button.dataset.regionId = item.id; button.dataset.focusKey = `region-${item.id}`; button.setAttribute('aria-pressed', String(selected?.id === item.id)); const icon = el('span', 'world-region-icon', depth ? '└' : '◇'); const label = el('span', 'world-region-label'); label.append(el('strong', '', item.name), el('span', 'hint', `${item.details.length} 条细节 · ${Object.keys(item.state).length} 项状态`)); button.append(icon, label); if (item.id === world.playerLocationId) button.append(pill('在此', 'completed')); else { button.append(pill(state.view.nextContext.activeRegionIds.includes(item.id) ? '背景已加载' : '档案保留', 'neutral'), el('span', 'region-revision mono', `r${item.revision}`)); } tree.append(button); world.regions.filter(child => child.parentId === item.id).forEach(child => entry(child, depth + 1)); }
    world.regions.filter(item => !item.parentId || !region(item.parentId)).forEach(item => entry(item, 0)); world.regions.forEach(item => entry(item, 0)); map.append(tree); parent.append(map, raw('世界核心设定', world.core, 'world-core'));
    if (!selected) { renderEmptyEvidence(); return; } setEvidence(JSON.stringify({ worldId: world.id, revision: world.revision, region: selected }, null, 2));
    paint('#evidence-content', JSON.stringify(['world', selected, world.revision]), inspector => {
      evidenceHeader(inspector, selected.name, regionPath(selected.id).join(' / ')); inspector.append(pill(`当前快照 r${world.revision}`, 'neutral'), el('p', 'region-summary', selected.summary));
      const properties = el('div', 'inspector-properties'); row(properties, '地点 ID', selected.id, true); row(properties, '首次展开', `第 ${selected.createdTurn} 轮`); row(properties, '最近更新', `第 ${selected.updatedTurn} 轮`); inspector.append(properties);
      const facts = section('当前状态'); if (!Object.keys(selected.state).length) facts.append(el('p', 'hint', '尚无独立状态记录。')); Object.entries(selected.state).forEach(([key, value]) => row(facts, key, value)); inspector.append(facts);
      const details = section(`累积细节 · ${selected.details.length}`); const list = el('ul', 'detail-list'); selected.details.forEach(value => list.append(el('li', '', value))); details.append(selected.details.length ? list : el('p', 'hint', '继续探索，可逐渐补充这里的细节。')); inspector.append(details);
      const leads = section('互动线索'); const leadsList = el('ul', 'detail-list'); selected.opportunities.forEach(value => leadsList.append(el('li', '', value))); leads.append(selected.opportunities.length ? leadsList : el('p', 'hint', '暂无已记录线索，可自由提出行动。')); inspector.append(leads, raw('区域原始记录', JSON.stringify(selected, null, 2), 'region-json'));
    });
  }
  function renderDebug() {
    if (!state.view) return; renderSummary(); document.querySelectorAll('[data-tab]').forEach(tab => { const active = tab.dataset.tab === state.tab; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }); $('#debug-content').setAttribute('aria-labelledby', `tab-${state.tab}`);
    const selected = run(); const tick = selected?.status === 'running' && state.tab === 'overview' ? Date.now() : null;
    paint('#debug-content', JSON.stringify([state.tab, selected, state.stage, state.contextMode, state.segment, state.changeRegion, state.regionId, state.diffRole, state.diffBaseline, state.view.world.revision, state.view.world.id, tick]), parent => ({ overview: renderOverview, context: renderContext, diff: renderPromptDiff, changes: renderChanges, world: renderWorld })[state.tab](parent));
  }
  function renderPlayMap() {
    if (!state.view) return;
    const { world, runs, config } = state.view; const locked = busy() || !state.connected || !config.configured;
    const active = runs.find(item => item.id === state.view.activeRunId);
    $('#map-region-count').textContent = `${world.regions.length} 个地点`;
    $('#explore-region').disabled = busy() || !state.connected || !config.configured;
    paint('#play-map', JSON.stringify([world.id, world.revision, state.mapRegionId, locked, active?.intent]), parent => {
      const visited = new Set(world.turns.flatMap(turn => [turn.fromId, turn.toId])); visited.add(world.playerLocationId);
      const seen = new Set();
      function addRegion(item, container, depth = 0) {
        if (seen.has(item.id)) return; seen.add(item.id);
        const group = el('div', 'map-region-branch'); const card = el('div', `map-region-card ${item.id === world.playerLocationId ? 'current' : ''} ${state.mapRegionId === item.id ? 'inspected' : ''}`);
        const moving = active?.intent?.kind === 'travel' && active.intent.destinationId === item.id;
        const move = btn('', 'map-region-target', () => travelTo(item.id)); move.dataset.mapRegion = item.id; move.dataset.focusKey = `map-travel-${item.id}`;
        move.disabled = locked || item.id === world.playerLocationId; move.setAttribute('aria-label', item.id === world.playerLocationId ? `${item.name}，当前所在` : `前往${item.name}`);
        move.append(el('span', 'map-region-symbol', item.id === world.playerLocationId ? '●' : '◇'), el('strong', '', item.name), el('span', 'map-region-caption', moving ? '正在前往…' : item.id === world.playerLocationId ? '当前所在' : visited.has(item.id) ? '再次前往 ↗' : '前往 ↗'));
        const detail = btn('详情', 'map-region-inspect', () => { state.mapRegionId = item.id; renderPlayMap(); }); detail.setAttribute('aria-label', `查看${item.name}详情`); detail.dataset.focusKey = `map-detail-${item.id}`;
        card.append(move, detail); group.append(card);
        const children = world.regions.filter(child => child.parentId === item.id);
        if (children.length) { const branch = el('div', `map-region-children ${depth >= 3 ? 'compact-depth' : ''}`); children.forEach(child => addRegion(child, branch, depth + 1)); group.append(branch); }
        container.append(group);
      }
      world.regions.filter(item => item.parentId === null || !region(item.parentId)).forEach(item => addRegion(item, parent));
      world.regions.forEach(item => addRegion(item, parent));
    });
    const selected = region(state.mapRegionId) || region(world.playerLocationId);
    paint('#play-region-detail', JSON.stringify([world.id, selected]), parent => {
      if (!selected) return;
      parent.append(el('span', 'eyebrow', '地点档案'), el('h3', '', selected.name), el('p', 'hint', regionPath(selected.id).join(' / ')), el('p', 'map-detail-summary', selected.summary));
      const facts = Object.entries(selected.state); if (facts.length) { const list = el('dl', 'map-state-list'); for (const [key, value] of facts) list.append(el('dt', '', key), el('dd', '', value)); parent.append(list); }
      if (selected.opportunities.length) { const list = el('ul', 'map-opportunities'); selected.opportunities.slice(0, 3).forEach(value => list.append(el('li', '', value))); parent.append(list); }
    });
  }
  // The play shell consumes generic entries; this adapter owns exploration-specific fields.
  function playEntries() {
    const { world, runs } = state.view;
    const entries = [];
    if (!world.turns.length) entries.push({ id: 'opening', type: 'narration', text: region(world.playerLocationId)?.summary || '世界正在等待你的第一步。' });
    const attempts = revision => runs.filter(item => item.baseRevision === revision && item.status !== 'completed').forEach(item => {
      entries.push({ id: item.id, type: 'attempt', text: item.action, status: item.status, source: item });
    });
    attempts(0);
    world.turns.forEach(turn => {
      entries.push({ id: turn.id, type: 'turn', action: turn.action, text: turn.narration, caption: regionName(turn.toId), number: turn.number });
      attempts(turn.number);
    });
    return entries;
  }
  function scrollLatest() { const scroll = $('#story-scroll'); scroll.scrollTop = scroll.scrollHeight; $('#latest-story').hidden = true; }
  function renderStory() {
    const entries = playEntries(), scroll = $('#story-scroll');
    const worldChanged = $('#story').dataset.worldId !== state.view.world.id;
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    paint('#story', JSON.stringify([state.view.world.id, entries]), parent => {
      entries.forEach(entry => {
        const article = el('article', `game-entry ${entry.type}`); article.dataset.entryId = entry.id;
        if (entry.type === 'turn') {
          const action = el('div', 'game-player-message'); action.setAttribute('aria-label', '你的行动'); action.append(el('p', '', entry.action));
          article.append(el('div', 'game-entry-caption', `第 ${entry.number} 段 · ${entry.caption}`), action);
        }
        if (entry.type === 'attempt') {
          article.append(el('div', 'game-player-message', entry.text), el('p', 'hint', entry.status === 'running' ? '世界正在回应…' : entry.status === 'failed' ? '这次行动未完成，世界保持原状。' : '已停止生成，世界保持原状。'));
          if (entry.status !== 'running') article.append(btn('修改后重试', 'button secondary', () => fillAction(entry.source)), btn('查看原因', 'button quiet', () => openRun(entry.source)));
        } else { const narrative = el('div', 'game-narration'); paragraphs(narrative, entry.text); article.append(narrative); }
        parent.append(article);
      });
    });
    $('#story').dataset.worldId = state.view.world.id;
    if (worldChanged || atBottom) scrollLatest();
    else $('#latest-story').hidden = false;
  }
  const playPanels = {
    map: { title: '世界地图', id: '#panel-map' },
    scene: { title: '当前场景', id: '#panel-scene' },
    journal: { title: '旅程日志', id: '#panel-journal' },
  };
  let panelOpener = null;
  function showPanel(name) {
    if (name && !playPanels[name]) return;
    if (name) panelOpener = document.activeElement;
    state.panel = name; $('#game-panel').hidden = !name;
    $('#play-page').classList.toggle('panel-open', Boolean(name));
    Object.entries(playPanels).forEach(([key, value]) => { $(value.id).hidden = key !== name; });
    document.querySelectorAll('[data-panel]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.panel === name)));
    if (name) { $('#game-panel-title').textContent = playPanels[name].title; renderPlayPanels(); $('#close-game-panel').focus(); }
    else if (panelOpener?.isConnected) panelOpener.focus();
  }
  function renderPlayPanels() {
    if (!state.view) return;
    const world = state.view.world, current = region(world.playerLocationId);
    paint('#panel-scene', JSON.stringify([world.id, current]), parent => {
      parent.append(el('p', 'hint', '你当前所在'), el('h3', '', current?.name || '未知地点'));
      paragraphs(parent, current?.summary);
      if (current?.details.length) { const list = el('ul', 'detail-list'); current.details.forEach(text => list.append(el('li', '', text))); parent.append(list); }
      if (current?.opportunities.length) { parent.append(el('h3', '', '可以留意')); const list = el('ul', 'detail-list'); current.opportunities.forEach(text => list.append(el('li', '', text))); parent.append(list); }
      parent.append(btn('打开地图', 'button secondary', () => showPanel('map')));
    });
    paint('#panel-journal', JSON.stringify([world.id, world.turns]), parent => {
      parent.append(el('h3', '', world.title), el('p', 'hint', '记录已完成的行动。点击回到故事中的那一刻。'));
      if (!world.turns.length) parent.append(el('p', '', '旅程刚刚开始，还没有完成的行动。'));
      [...world.turns].reverse().forEach(turn => {
        const button = btn('', 'journal-entry', () => { showPanel(null); const entry = [...$('#story').children].find(node => node.dataset.entryId === turn.id); if (entry) { $('#story-scroll').scrollTop += entry.getBoundingClientRect().top - $('#story-scroll').getBoundingClientRect().top; entry.tabIndex = -1; entry.focus({ preventScroll: true }); } });
        button.append(el('span', 'hint', `第 ${turn.number} 段 · ${regionName(turn.toId)}`), el('strong', '', turn.action)); parent.append(button);
      });
    });
  }
  function updateInput() {
    const configured = Boolean(state.view?.config.configured), locked = busy(); $('#action-input').disabled = !configured || locked; $('#send-action').disabled = !configured || !state.connected || locked || !$('#action-input').value.trim(); $('#send-action').hidden = Boolean(state.view?.activeRunId); $('#cancel-turn').hidden = !state.view?.activeRunId; $('#cancel-turn').disabled = state.cancelBusy || !state.connected; $('#cancel-turn').textContent = state.cancelBusy ? '正在取消…' : '取消生成';
    $('#character-count').textContent = `${$('#action-input').value.length} / 2000`; $('#new-world').disabled = !state.view || !state.connected || locked; $('#load-save').disabled = !state.view || !state.connected || locked || !$('#save-select').value || $('#save-select').value === state.view.world.id; $('#save-select').disabled = !state.view || locked; document.querySelectorAll('[data-cancel-run]').forEach(button => { button.disabled = state.cancelBusy || !state.connected; });
    $('#action-mode').disabled = locked || !configured;
    const exploring = $('#action-mode').value === 'explore';
    $('#action-mode-help').textContent = exploring ? '发送后尝试进入你描述的新地点' : '自由描述对白、行动或想去的地方';
    $('#exploration-intent').hidden = !exploring; $('#clear-intent').disabled = locked;
    $('#action-input').placeholder = exploring ? '想探索哪里？例如：前往南疆的一处渡口…' : '说些什么，或描述你想做的事…';
    renderPlayMap();
  }
  function render(view) {
    const previous = state.view, changedWorld = previous?.world.id !== view.world.id; state.view = view; const input = $('#action-input'); const pending = view.runs.find(item => item.id === input.dataset.pendingRunId);
    if (pending && pending.status !== 'running') { if (pending.status === 'completed' && input.value.trim() === pending.action) { input.value = ''; $('#action-mode').value = 'interact'; } delete input.dataset.pendingRunId; }
    if (changedWorld) { state.runId = view.runs.at(-1)?.id || null; state.regionId = view.world.playerLocationId; state.mapRegionId = view.world.playerLocationId; state.diffBaseline = 'previous'; state.stage = null; state.segment = null; state.changeRegion = null; }
    else if (state.follow || !view.runs.some(item => item.id === state.runId)) { const latest = view.runs.at(-1)?.id || null; if (state.runId !== latest) { state.stage = null; state.segment = null; state.changeRegion = null; } state.runId = latest; }
    if (!changedWorld && previous?.world.playerLocationId !== view.world.playerLocationId) state.mapRegionId = view.world.playerLocationId;
    $('#world-title').textContent = view.world.title; $('#save-world-title').textContent = view.world.title; $('#current-location').textContent = regionPath(view.world.playerLocationId).join(' / '); $('#world-clock').textContent = worldTime(view.world.timeMinutes);
    $('#mode-badge').textContent = view.config.mode === 'scripted' ? '脚本演示' : view.config.configured ? '真实模型' : '待配置'; $('#mode-badge').classList.toggle('scripted', view.config.mode === 'scripted'); $('#mode-notice').hidden = view.config.mode !== 'scripted'; $('#mode-notice').textContent = '脚本演示环境 · 使用预设响应验证流程，不代表真实模型生成。'; $('#config-notice').hidden = view.config.configured;
    $('#save-status').textContent = view.activeRunId ? '运行中 · 新变化尚未提交' : `自动保存 · 世界版本 r${view.world.revision}`; $('#connection-status').textContent = '本地已连接'; $('#connection-status').classList.remove('offline'); const active = view.runs.find(item => item.id === view.activeRunId); $('#turn-status').hidden = !active; if (active) $('#turn-status').textContent = `${active.phase || '世界正在回应'} · 可随时取消`;
    $('#play-save-state').hidden = false; $('#play-save-state').textContent = view.activeRunId ? '正在回应…' : '✓ 已保存';
    renderRuns(); renderDebug(); renderStory(); renderPlayPanels(); updateInput(); if (changedWorld || previous?.world.revision !== view.world.revision) void fetchSaves();
  }
  async function fetchSaves() { try { const data = await api('/api/saves'); const selection = $('#save-select').value; state.saves = data.saves; const select = $('#save-select'); select.replaceChildren(); data.saves.forEach(save => select.append(new Option(`${save.title} · r${save.revision} · ${dateTime(save.updatedAt, true)}`, save.id))); select.value = data.saves.some(save => save.id === selection) ? selection : state.view?.world.id || ''; updateInput(); } catch (error) { toast(`存档列表读取失败：${error.message}`); } }
  async function refresh(fresh = false) {
    if (state.refreshPromise) { await state.refreshPromise; if (!fresh) return; }
    state.refreshPromise = (async () => { try { const view = await api('/api/state'); state.connected = true; $('#connection-alert').hidden = true; render(view); } catch (error) { state.connected = false; $('#connection-alert').textContent = `无法连接本地服务：${error.message}。正在重连，输入与已读取的记录会保留。`; $('#connection-alert').hidden = false; $('#play-save-state').textContent = '连接中断'; $('#connection-status').textContent = '连接中断'; $('#connection-status').classList.add('offline'); updateInput(); } })(); try { await state.refreshPromise; } finally { state.refreshPromise = null; }
  }
  function poll() { clearTimeout(state.timer); state.timer = setTimeout(async () => { await refresh(); poll(); }, state.view?.activeRunId ? 800 : 3000); }
  async function submitAction(event) { event.preventDefault(); const action = $('#action-input').value.trim(); if (!action || busy() || !state.connected || !state.view?.config.configured) return; state.busy = true; actionError(); updateInput(); try { const result = await api('/api/turn', { action, mode: $('#action-mode').value }); $('#action-input').dataset.pendingRunId = result.runId; state.view.activeRunId = result.runId; if (state.follow) { state.runId = result.runId; state.stage = null; } await refresh(true); } catch (error) { actionError(error.message); } finally { state.busy = false; updateInput(); poll(); } }
  async function travelTo(destinationId) {
    if (busy() || !state.connected || !state.view?.config.configured || destinationId === state.view.world.playerLocationId) return;
    const payload = { destinationId, worldId: state.view.world.id, baseRevision: state.view.world.revision };
    state.busy = true; state.mapRegionId = destinationId; actionError(); updateInput();
    try { const result = await api('/api/travel', payload); state.view.activeRunId = result.runId; if (state.follow) { state.runId = result.runId; state.stage = null; } await refresh(true); }
    catch (error) { actionError(error.message); await refresh(true); }
    finally { state.busy = false; updateInput(); poll(); }
  }
  async function cancelTurn() { if (!state.view?.activeRunId || state.cancelBusy) return; state.cancelBusy = true; updateInput(); try { await api('/api/cancel', {}); await refresh(true); toast('取消已处理，记录已保留。'); } catch (error) { actionError(error.message); } finally { state.cancelBusy = false; updateInput(); } }
  async function changeWorld(path, payload) { if (busy()) return; state.busy = true; actionError(); updateInput(); try { await api(path, payload); $('#action-input').value = ''; delete $('#action-input').dataset.pendingRunId; await refresh(true); await fetchSaves(); $('#save-select').value = state.view.world.id; toast(path === '/api/new' ? '已打开新世界，已有存档保留。' : '已继续所选存档。'); } catch (error) { actionError(error.message); } finally { state.busy = false; updateInput(); } }
  $('#action-form').addEventListener('submit', submitAction); $('#action-input').addEventListener('input', updateInput); $('#action-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#action-form').requestSubmit(); } });
  $('#cancel-turn').addEventListener('click', cancelTurn); $('#new-world').addEventListener('click', () => changeWorld('/api/new', {})); $('#load-save').addEventListener('click', () => changeWorld('/api/load', { worldId: $('#save-select').value })); $('#save-select').addEventListener('change', updateInput); $('#refresh-saves').addEventListener('click', fetchSaves);
  $('#toggle-saves').addEventListener('click', () => { const open = $('#save-drawer').hidden; $('#save-drawer').hidden = !open; $('#toggle-saves').setAttribute('aria-expanded', String(open)); });
  $('#toggle-runs').addEventListener('click', () => { const open = $('#toggle-runs').getAttribute('aria-expanded') !== 'true'; $('#toggle-runs').setAttribute('aria-expanded', String(open)); $('#runs-body').hidden = !open; $('#toggle-runs').textContent = open ? '收起列表' : '选择运行'; });
  $('#run-search').addEventListener('input', renderRuns); $('#run-filter').addEventListener('change', renderRuns); $('#follow-latest').addEventListener('change', () => { state.follow = $('#follow-latest').checked; if (state.follow) selectRun(state.view?.runs.at(-1)?.id || null, true); else renderSummary(); }); $('#copy-evidence').addEventListener('click', () => copy(state.evidence));
  document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => showPanel(state.panel === button.dataset.panel ? null : button.dataset.panel)));
  $('#close-game-panel').addEventListener('click', () => showPanel(null));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.panel && state.mode === 'play') showPanel(null); });
  $('#clear-intent').addEventListener('click', () => { $('#action-mode').value = 'interact'; updateInput(); $('#action-input').focus(); });
  $('#latest-story').addEventListener('click', scrollLatest);
  $('#story-scroll').addEventListener('scroll', () => { const area = $('#story-scroll'); $('#latest-story').hidden = area.scrollHeight - area.scrollTop - area.clientHeight < 100; });
  $('#action-mode').addEventListener('change', updateInput);
  $('#explore-region').addEventListener('click', () => { showPanel(null); $('#action-mode').value = 'explore'; updateInput(); $('#action-input').focus(); });
  document.querySelectorAll('[data-tab]').forEach(button => { button.addEventListener('click', () => selectTab(button.dataset.tab)); button.addEventListener('keydown', event => { const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.indexOf(button); let next; if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]; if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length]; if (event.key === 'Home') next = tabs[0]; if (event.key === 'End') next = tabs.at(-1); if (next) { event.preventDefault(); next.click(); next.focus(); } }); });
  window.addEventListener('hashchange', mode); document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refresh(); poll(); } });
  const compactViewport = window.matchMedia('(max-width: 760px)');
  function adaptRuns() {
    const open = !compactViewport.matches;
    $('#runs-body').hidden = !open;
    $('#toggle-runs').setAttribute('aria-expanded', String(open));
    $('#toggle-runs').textContent = open ? '收起列表' : '选择运行';
  }
  compactViewport.addEventListener('change', adaptRuns);
  adaptRuns();
  mode(); void refresh().then(poll);
}
