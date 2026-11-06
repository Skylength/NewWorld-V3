export function renderNpcPanel(parent, view, submit, locked) {
  const data = view.npcView;
  if (!data) { parent.textContent = '当前服务尚未启用人物功能。'; return; }
  const signature = JSON.stringify([view.world.id, view.world.revision, locked]);
  if (parent.dataset.signature === signature) return;
  // Preserve an unsent message across polling, but never across worlds.
  const drafts = parent.dataset.worldId === view.world.id ? new Map([...parent.querySelectorAll('textarea')].map(e => [e.dataset.npc, e.value])) : new Map();
  parent.dataset.worldId = view.world.id;
  parent.dataset.signature = signature;
  parent.replaceChildren();
  const el = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (label, action) => { const b = el('button', label, 'button secondary'); b.type = 'button'; b.disabled = locked; b.addEventListener('click', action); return b; };
  parent.append(el('p', '遇见的人会留在世界里。选为重要人物后，他会独立决定自己的活动。', 'hint'));
  if (data.advance) {
    parent.append(el('p', data.advance.reason || '人物正在行动…', 'callout'));
    parent.append(button('继续人物活动', () => submit({ kind: 'continue' })));
    parent.append(button('停止此次推进', () => submit({ kind: 'stop' })));
  } else {
    const wait = el('div', '', 'npc-controls');
    wait.append(button('等待 10 分钟', () => submit({ kind: 'advance', minutes: 10 })), button('等待 1 小时', () => submit({ kind: 'advance', minutes: 60 })));
    parent.append(wait);
  }
  if (!data.actors.length) parent.append(el('p', '尚未遇见具体人物。可以在故事中寻找或与当地人交谈。'));
  for (const npc of data.actors) {
    const card = el('section', '', 'npc-card');
    card.append(el('h3', npc.name), el('p', npc.description), el('p', `${npc.mode === 'agent' ? '重要人物' : '普通人物'} · ${npc.present ? '在场' : '当前不在场'}`, 'hint'));
    if (npc.mode === 'background') {
      const promote = button('设为重要人物', () => submit({ kind: 'promote', npcId: npc.id })); promote.disabled ||= Boolean(data.advance); card.append(promote);
    }
    if (npc.present && npc.mode === 'agent') {
      const input = document.createElement('textarea'); input.dataset.npc = npc.id; input.maxLength = 1800; input.rows = 3; input.placeholder = `对${npc.name}说些什么…`; input.setAttribute('aria-label', `对${npc.name}说话`); input.value = drafts.get(npc.id) || ''; input.disabled = locked || Boolean(data.advance);
      const send = button('交谈', async () => { const text = input.value.trim(); if (text) { const accepted = await submit({ kind: 'talk', npcId: npc.id, text }); if (accepted) { input.value = ''; const current = [...parent.querySelectorAll('textarea')].find(e => e.dataset.npc === npc.id); if (current) current.value = ''; } } });
      send.disabled ||= Boolean(data.advance); card.append(input, send);
    }
    parent.append(card);
  }
  const messages = data.letters.filter(l => l.toId === 'player' && l.status === 'delivered');
  if (messages.length) {
    parent.append(el('h3', '收到的消息'));
    for (const letter of messages.slice(-10).reverse()) parent.append(el('p', `${data.actors.find(n => n.id === letter.fromId)?.name || '来信'}：${letter.text}`, 'npc-letter'));
  }
}
