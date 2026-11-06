/** Compare recorded request text, never reconstructed world state. */
export function actualRequest(run, role) {
  if (!run) return null;
  if (Array.isArray(run.calls)) {
    const call = run.calls.find(value => value.role === role && value.modelRequests > 0);
    return call?.context && typeof call.context.systemPrompt === 'string' && typeof call.context.userPrompt === 'string' ? call.context : null;
  }
  return role === 'structure' && run.modelRequests > 0 && run.context ? run.context : null;
}

export function promptBaseline(runs, selected, role, baselineId = 'previous') {
  const index = runs.findIndex(run => run.id === selected?.id);
  const candidates = index < 0 ? [] : runs.slice(0, index).filter(run => run.worldId === selected.worldId && actualRequest(run, role));
  return { candidates, baseline: candidates.find(run => run.id === baselineId) || candidates.at(-1) || null };
}

export function lineDiff(before, after) {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  const operations = [];
  for (let i = 0; i < prefix; i++) operations.push(['context', a[i]]);
  // Bound work on pathological input with thousands of tiny lines. The fallback is
  // non-minimal but exact: no changed text is hidden, fabricated or truncated.
  const coarse = n * m > 400000;
  if (coarse || !n || !m) {
    for (let i = 0; i < n; i++) operations.push(['removed', a[prefix + i]]);
    for (let j = 0; j < m; j++) operations.push(['added', b[prefix + j]]);
  } else {
    const width = m + 1, cells = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      cells[i * width + j] = a[prefix + i] === b[prefix + j]
        ? cells[(i + 1) * width + j + 1] + 1
        : Math.max(cells[(i + 1) * width + j], cells[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { operations.push(['context', a[prefix + i]]); i++; j++; }
      else if (i < n && (j === m || cells[(i + 1) * width + j] >= cells[i * width + j + 1])) operations.push(['removed', a[prefix + i++]]);
      else operations.push(['added', b[prefix + j++]]);
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) operations.push(['context', a[i]]);
  let oldLine = 0, newLine = 0, added = 0, removed = 0;
  const lines = operations.map(([kind, text]) => {
    if (kind === 'added') added++;
    if (kind === 'removed') removed++;
    return { kind, text, oldLine: kind === 'added' ? null : ++oldLine, newLine: kind === 'removed' ? null : ++newLine };
  });
  return { lines, added, removed, coarse, oldCount: a.length, newCount: b.length };
}

export function promptDiff(before, after) {
  return ['systemPrompt', 'userPrompt'].map(key => ({ key, label: key === 'systemPrompt' ? '系统提示词' : '用户消息', ...lineDiff(before?.[key] || '', after[key]) }));
}

export function unifiedPromptDiff(files, beforeLabel, afterLabel) {
  return files.map(file => [
    `--- ${beforeLabel}/${file.key}`, `+++ ${afterLabel}/${file.key}`,
    `@@ -${file.oldCount ? 1 : 0},${file.oldCount} +${file.newCount ? 1 : 0},${file.newCount} @@`,
    ...file.lines.map(line => ({ added: '+', removed: '-', context: ' ' }[line.kind]) + line.text),
  ].join('\n')).join('\n\n');
}
