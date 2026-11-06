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
  const creation = el('details', '', 'npc-card');
  creation.append(el('summary', '创建人物'));
  const fields = {};
  for (const [key, label, max] of [['name', '姓名', 80], ['description', '公开外观与身份', 600], ['persona', '性格与背景（不作为其他人物的已知信息）', 1200], ['goals', '当前目标（每行一项，最多五项）', 1500]]) {
    const wrapper = el('label', label);
    const input = document.createElement('textarea'); input.dataset.npc = 'create-' + key;
    input.maxLength = max; input.rows = key === 'name' ? 1 : 3;
    input.value = drafts.get(input.dataset.npc) || ''; input.disabled = locked || Boolean(data.advance);
    wrapper.append(input); creation.append(wrapper); fields[key] = input;
  }
  const error = el('p', '', 'hint'); error.setAttribute('role', 'status');
  const create = button('在当前地点实体化', async () => {
    const values = Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value.trim()]));
    if (!values.name || !values.description || !values.persona) { error.textContent = '请填写姓名、公开简介和性格背景。'; return; }
    const goals = values.goals.split('\n').map(s => s.trim()).filter(Boolean);
    if (goals.length > 5 || goals.some(goal => goal.length > 200)) { error.textContent = '目标最多五项，每项最多200字。'; return; }
    const accepted = await submit({ kind: 'create', seed: { id: 'npc_' + crypto.randomUUID().replaceAll('-', ''), name: values.name, description: values.description, persona: values.persona, goals, locationId: view.world.playerLocationId } });
    if (accepted) for (const input of parent.querySelectorAll('textarea')) if (input.dataset.npc?.startsWith('create-')) input.value = '';
  });
  create.disabled ||= Boolean(data.advance); creation.append(error, create); parent.append(creation);
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
