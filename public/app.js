'use strict';
const $ = id => document.getElementById(id);
const welcome = document.querySelector('.welcome').cloneNode(true);
const state = { device: null, projects: [], threads: [], thread: null, nextThreads: null, nextHistory: null, active: {}, approvals: new Map(), items: new Map(), drafts: new Map(), writers: new Map(), forking: new Set(), forkIntents: new Map(), completedTurns: new Set(), stream: null, epoch: 0, loading: false, desktopBusy: false };
const clientId = () => window.crypto?.randomUUID?.() || `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const button = (text, action, className = 'secondary') => { const b = el('button', text, className); b.type = 'button'; b.addEventListener('click', () => Promise.resolve(action()).catch(e => toast(e.message))); return b; };
let toastTimer, searchTimer, pollTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(route, method = 'GET', data) {
  const r = await fetch(route, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await r.json();
  if (!r.ok) { if (r.status === 401 && !route.startsWith('/api/auth/')) { state.stream?.close(); showLogin(); } throw Object.assign(new Error(value.error || `请求失败 (${r.status})`), { status: r.status, code: value.code, recovery: value.recovery, writer: value.writer }); }
  return value;
}
const post = (route, data = {}) => api(route, 'POST', data);
function showLogin() { state.device = null; $('app').hidden = true; $('auth-view').hidden = false; $('login-form').hidden = false; $('waiting').hidden = true; clearInterval(pollTimer); }
async function updateAuth() {
  const r = await api('/api/auth/session'); state.device = r.device; $('local-login-help').hidden = !r.local;
  if (r.device?.status === 'approved') { clearInterval(pollTimer); await enterApp(); }
  else if (r.device?.status === 'pending') {
    $('auth-view').hidden = false; $('app').hidden = true; $('login-form').hidden = true; $('waiting').hidden = false;
    clearInterval(pollTimer); pollTimer = setInterval(() => updateAuth().catch(e => $('auth-error').textContent = e.message), 3000);
  } else showLogin();
}
async function enterApp() {
  $('auth-view').hidden = true; $('app').hidden = false;
  document.querySelectorAll('.owner-only').forEach(e => e.hidden = state.device.role !== 'owner');
  await Promise.all([loadProjects(), loadStatus()]); await loadThreads(); connectStream();
  if (state.device.role === 'owner') refreshDeviceCount();
  const saved = sessionStorage.getItem('lastThread');
  if (saved && state.threads.some(t => t.id === saved)) await loadThread(saved);
}
async function loadStatus() {
  const s = await api('/api/status'); state.status = s; state.active = s.active;
  $('model-label').textContent = `${s.model || '本机模型'} · ${s.provider}`;
  setConnected(s.ready); updateRun();
}
function setConnected(ready, message) { $('connection-dot').style.background = ready ? '#639461' : '#c8955b'; $('connection-label').textContent = message || (ready ? 'Mac 已连接' : '连接恢复中'); }
async function loadProjects() {
  const r = await api('/api/projects'); state.projects = r.data;
  const selected = $('project-select').value; $('project-select').replaceChildren(el('option', '所有项目'));
  $('project-select').firstChild.value = '';
  for (const p of r.data) { const o = el('option', p.name); o.value = p.path; $('project-select').append(o); }
  $('project-select').value = selected;
}
async function loadThreads(append = false) {
  const p = new URLSearchParams(); if ($('project-select').value) p.set('cwd', $('project-select').value); if ($('thread-search').value.trim()) p.set('q', $('thread-search').value.trim()); if (append && state.nextThreads) p.set('cursor', state.nextThreads);
  const r = await api(`/api/threads?${p}`);
  state.threads = append ? [...state.threads, ...r.data.filter(t => !state.threads.some(x => x.id === t.id))] : r.data;
  state.nextThreads = r.nextCursor; renderThreads();
}
function renderThreads() {
  const fragment = document.createDocumentFragment();
  for (const t of state.threads) {
    const b = button('', () => loadThread(t.id), `thread-card${state.thread?.id === t.id ? ' selected' : ''}`);
    b.append(el('strong', t.name || t.preview?.replace(/\s+/g, ' ').slice(0, 50) || '新会话'));
    const p = state.projects.find(p => p.id === t.projectId || p.path === t.cwd);
    b.append(el('span', `${p?.name || t.cwd.split('/').pop() || '项目'} · ${new Date(t.updatedAt * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}`)); fragment.append(b);
  }
  if (!state.threads.length) fragment.append(el('p', '这里还没有会话。选择项目后，点击「新建会话」。', 'thread-empty'));
  $('thread-list').replaceChildren(fragment); $('more-threads').hidden = !state.nextThreads;
}
function drawer(open) { $('sidebar').classList.toggle('open', open); $('drawer-backdrop').hidden = !open; }
async function loadThread(id) {
  if (state.thread) state.drafts.set(state.thread.id, $('message-input').value);
  state.thread = null; state.desktopBusy = false;
  const epoch = ++state.epoch; state.loading = true; drawer(false); state.items.clear();
  $('messages').replaceChildren(el('p', '正在读取本地会话…', 'muted small'));
  $('message-input').disabled = true; $('send').disabled = true;
  try {
    const [meta, history] = await Promise.all([api(`/api/threads/${id}`), api(`/api/threads/${id}/history`)]);
    if (epoch !== state.epoch) return;
    state.thread = meta.thread; state.nextHistory = history.nextCursor;
    state.writers.set(id, meta.writer || { blocked: false, owner: 'unknown' });
    state.desktopBusy = history.data[0]?.status === 'inProgress' && !state.active[id];
    if (meta.activeTurnId) state.active[id] = meta.activeTurnId;
    sessionStorage.setItem('lastThread', id); renderThreads();
    $('thread-title').textContent = meta.thread.name || meta.thread.preview?.replace(/\s+/g, ' ').slice(0, 50) || '新会话';
    $('project-title').textContent = state.projects.find(p => p.id === meta.thread.projectId || p.path === meta.thread.cwd)?.name || meta.thread.cwd.split('/').pop();
    $('thread-meta').hidden = false; $('thread-meta').textContent = `${meta.thread.cwd} · ${meta.thread.model || state.status?.model || ''} · ${meta.thread.modelProvider}`;
    $('messages').replaceChildren();
    for (const t of [...history.data].reverse()) putTurn(t);
    if (!history.data.length) $('messages').append(el('p', '会话已准备好。发出第一条指令吧。', 'muted small'));
    $('older-history').hidden = !state.nextHistory; $('message-input').value = state.drafts.get(id) || ''; $('message-input').disabled = false; updateRun(); scrollBottom(); renderApprovals();
  } catch (e) { if (epoch === state.epoch) { $('messages').replaceChildren(el('p', e.message, 'turn-error')); toast(e.message); } }
  finally { if (epoch === state.epoch) { state.loading = false; updateRun(); } }
}
function inline(text, target) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(last, m.index)));
    if (m[0].startsWith('`')) target.append(el('code', m[0].slice(1, -1)));
    else if (m[0].startsWith('**')) target.append(el('strong', m[0].slice(2, -2)));
    else { const a = el('a', m[2]); a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer'; target.append(a); }
    last = m.index + m[0].length;
  }
  target.append(document.createTextNode(text.slice(last)));
}
function markdown(text, target) {
  const lines = (text || '').split('\n'); let code = null, buffer = [], list = null;
  target.replaceChildren();
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) { if (code) { code.append(el('code', buffer.join('\n'))); target.append(code); code = null; buffer = []; } else code = el('pre'); list = null; continue; }
    if (code) { buffer.push(line); continue; }
    if (/^[-*]\s/.test(line)) { if (!list) { list = el('ul'); target.append(list); } const li = el('li'); inline(line.slice(2), li); list.append(li); continue; }
    list = null; if (!line.trim()) continue;
    const p = el(/^#{1,6}\s/.test(line) ? 'h3' : 'p'); inline(line.replace(/^#{1,6}\s/, ''), p); target.append(p);
  }
  if (code) { code.append(el('code', buffer.join('\n'))); target.append(code); }
}
function itemNode(item) {
  if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
    const article = el('article', undefined, `message ${item.type === 'userMessage' ? 'user' : 'agent'}`);
    const heading = el('div', undefined, 'message-heading'); heading.append(el('span', item.type === 'userMessage' ? '你' : '>_', 'avatar'), el('span', item.type === 'userMessage' ? '你' : item.phase === 'commentary' ? 'CODEX · 进度' : item.type === 'plan' ? 'CODEX · 计划' : 'CODEX'));
    const content = el('div', undefined, 'message-content'); article.append(heading, content);
    if (item.type === 'userMessage') for (const c of item.content || []) content.append(el('p', c.text)); else markdown(item.text, content);
    return article;
  }
  const details = el('details', undefined, 'tool-message');
  let label = item.type;
  if (item.type === 'commandExecution') label = `⌘ ${item.command || '执行命令'}${item.exitCode !== undefined && item.exitCode !== null ? ` · exit ${item.exitCode}` : ''}`;
  else if (item.type === 'fileChange') label = `↳ 文件修改 · ${(item.changes || []).map(c => c.path.split('/').pop()).join('、')}`;
  else if (item.type === 'mcpToolCall') label = `◇ ${item.server} / ${item.tool} · ${item.status || '执行中'}`;
  else if (item.type === 'webSearch') label = `⌕ 搜索 · ${item.query || ''}`;
  else if (item.type === 'contextCompaction') label = '上下文已压缩';
  details.append(el('summary', label.slice(0, 300)));
  if (item.aggregatedOutput) details.append(el('pre', item.aggregatedOutput));
  for (const c of item.changes || []) { details.append(el('p', c.path)); if (c.diff) details.append(el('pre', c.diff)); }
  if (item.error) details.append(el('pre', item.error.message || '工具调用失败'));
  return details;
}
function putItem(item) {
  if (!item || item.type === 'reasoning') return;
  const previous = state.items.get(item.id);
  const merged = { ...previous?.item, ...item }; const node = itemNode(merged);
  if (previous) { if (previous.node.tagName === 'DETAILS') node.open = previous.node.open; previous.node.replaceWith(node); }
  else $('messages').append(node);
  state.items.set(item.id, { item: merged, node });
}
function putTurn(turn) { for (const i of turn.items || []) putItem(i); if (turn.error && !$(`err-${turn.id}`)) { const p = el('p', turn.error.message, 'turn-error'); p.id = `err-${turn.id}`; $('messages').append(p); } }
function scrollBottom() { $('messages').scrollTop = $('messages').scrollHeight; }
function updateRun() {
  const active = state.thread && state.active[state.thread.id]; const writer = state.thread && state.writers.get(state.thread.id);
  $('run-status').textContent = active ? '执行中' : writer?.blocked ? writer.owner === 'desktop' ? '桌面占用' : '会话占用' : state.desktopBusy ? '会话未结束' : '就绪'; $('run-status').classList.toggle('busy', !!active || state.desktopBusy || !!writer?.blocked);
  $('stop').hidden = !active; $('send').disabled = !state.thread || !!active || state.loading || state.desktopBusy || !!writer?.blocked;
  $('release-writer').hidden = !state.thread || !!active || !!writer?.blocked;
  $('release-writer').disabled = Object.keys(state.active).length > 0;
  renderWriterWarning();
}
function renderWriterWarning() {
  const id = state.thread?.id; const writer = state.writers.get(id);
  $('writer-warning').hidden = !id || !writer?.blocked; $('writer-warning').replaceChildren();
  if (!id || !writer?.blocked) return;
  $('writer-warning').append(el('strong', writer.owner === 'desktop' ? '桌面仍占用这条会话 · 可以查看，暂不能发送' : '其他进程占用这条会话 · 可以查看，暂不能发送'));
  $('writer-warning').append(el('p', '停止生成不一定释放写入权。要继续原会话，请完全退出桌面 Codex，然后重新检查。未发送的文字会保留，不会自动重提。'));
  const actions = el('div', undefined, 'writer-actions');
  actions.append(button('重新检查占用', async () => { if (state.thread?.id === id) await loadThread(id); }));
  const forkButton = button(state.forking.has(id) ? '正在复制…' : '复制历史到新会话', async () => {
    if (state.thread?.id !== id || state.forking.has(id)) return;
    if (!confirm('这会复制目前已保存的历史，创建一条新会话。原会话保持不变；之后的新消息不会写回原会话，也不会接管桌面正在进行的工作。确认创建？')) return;
    const draft = $('message-input').value;
    let intent = state.forkIntents.get(id);
    if (!intent || intent.sandbox !== $('sandbox').value) { intent = { clientId: clientId(), sandbox: $('sandbox').value }; state.forkIntents.set(id, intent); }
    state.forking.add(id); renderWriterWarning();
    try {
      const r = await post(`/api/threads/${id}/fork`, { confirmFork: true, ...intent });
      await loadThreads();
      state.drafts.set(r.thread.id, state.thread?.id === id ? $('message-input').value : state.drafts.get(id) ?? draft);
      if (state.thread?.id === id) await loadThread(r.thread.id);
      state.forkIntents.delete(id);
      toast('已创建新会话；原会话未改动，草稿尚未发送');
    } finally { state.forking.delete(id); renderWriterWarning(); }
  });
  forkButton.disabled = state.forking.has(id); actions.append(forkButton);
  $('writer-warning').append(actions);
}
function connectStream() {
  state.stream?.close(); const stream = state.stream = new EventSource('/api/events');
  stream.onopen = () => setConnected(true);
  stream.onerror = () => { setConnected(false); api('/api/auth/session').then(r => { if (!r.device || r.device.status !== 'approved') { stream.close(); updateAuth().catch(() => {}); } }).catch(() => {}); };
  stream.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch { /* ignore malformed event */ } };
}
function handleEvent({ method, params: p = {} }) {
  if (method === 'panel/snapshot') { state.active = p.active; state.approvals = new Map((p.approvals || []).map(a => [a.requestId, a])); setConnected(p.ready); updateRun(); renderApprovals(); return; }
  if (method === 'bridge/status') { setConnected(p.ready || p.idle, p.idle ? 'Mac 已连接 · 写入权已释放' : p.message); if (!p.ready && !p.idle) { state.active = {}; state.approvals.clear(); updateRun(); renderApprovals(); } return; }
  if (method === 'panel/writersReleased') {
    for (const id of p.threadIds || []) state.writers.set(id, { blocked: false, owner: 'none', verified: true });
    updateRun(); return;
  }
  if (method === 'panel/devicesChanged') { refreshDeviceCount(); return; }
  if (method === 'panel/approval') { state.approvals.set(p.requestId, p); renderApprovals(); return; }
  if (method === 'panel/approvalResolved') { state.approvals.delete(p.requestId); renderApprovals(); return; }
  if (method === 'turn/started') state.active[p.threadId] = p.turn.id;
  if (method === 'turn/completed') {
    state.completedTurns.add(p.turn.id); if (state.completedTurns.size > 500) state.completedTurns.delete(state.completedTurns.values().next().value);
    delete state.active[p.threadId]; for (const [id, a] of state.approvals) if (a.params.threadId === p.threadId) state.approvals.delete(id);
    loadThreads().catch(() => {}); renderApprovals();
  }
  updateRun();
  if (!state.thread || p.threadId !== state.thread.id || state.loading) return;
  const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 160;
  if (method === 'item/started' || method === 'item/completed') putItem(p.item);
  else if (method === 'item/agentMessage/delta') { const prev = state.items.get(p.itemId)?.item; putItem({ id: p.itemId, type: 'agentMessage', text: (prev?.text || '') + p.delta }); }
  else if (method === 'item/commandExecution/outputDelta') { const prev = state.items.get(p.itemId)?.item; putItem({ id: p.itemId, type: 'commandExecution', aggregatedOutput: ((prev?.aggregatedOutput || '') + p.delta).slice(-40000) }); }
  else if (method === 'turn/completed') { putTurn(p.turn); toast(p.turn.status === 'completed' ? '任务已完成' : p.turn.status === 'interrupted' ? '任务已停止' : '任务执行失败，请查看错误'); }
  else if (method === 'error') toast(p.error?.message || p.message || 'Codex 执行出现错误');
  if (nearBottom) scrollBottom();
}
function renderApprovals() {
  const current = [...state.approvals.values()].filter(a => a.params.threadId === state.thread?.id);
  $('approvals').hidden = !current.length; $('approvals').replaceChildren();
  for (const a of current) {
    const card = el('section', undefined, 'approval'); card.append(el('h3', a.method.includes('requestUserInput') ? 'Codex 需要你的回答' : '需要你批准此操作'));
    if (a.method === 'item/tool/requestUserInput') {
      const values = new Map();
      for (const q of a.params.questions) {
        const label = el('label', q.question); const input = el('input'); input.type = q.isSecret ? 'password' : 'text';
        if (q.options?.length) { const options = el('select'); options.append(el('option', '选择一个选项，或在下方输入')); for (const o of q.options) { const entry = el('option', o.label); entry.value = o.label; options.append(entry); } options.onchange = () => { input.value = options.value; }; label.append(options); }
        label.append(input); values.set(q.id, input); card.append(label);
      }
      card.append(button('提交回答', async () => { await post(`/api/approvals/${encodeURIComponent(a.requestId)}`, { answers: Object.fromEntries([...values].map(([k, v]) => [k, v.value])) }); state.approvals.delete(a.requestId); renderApprovals(); }, 'primary'));
    } else {
      card.append(el('p', a.params.reason || '此操作将由你的电脑执行。'));
      if (a.params.command) card.append(el('pre', a.params.command));
      if (a.params.cwd) card.append(el('p', a.params.cwd, 'small muted'));
      const actions = el('div', undefined, 'actions');
      for (const [label, decision] of [['批准一次', 'accept'], ['拒绝', 'decline'], ['取消任务', 'cancel']]) actions.append(button(label, async () => { await post(`/api/approvals/${encodeURIComponent(a.requestId)}`, { decision }); state.approvals.delete(a.requestId); renderApprovals(); }, decision === 'accept' ? 'primary' : 'secondary'));
      card.append(actions);
    }
    $('approvals').append(card);
  }
}
function modal(title) { $('modal-title').textContent = title; $('modal-content').replaceChildren(); if (!$('modal').open) $('modal').showModal(); return $('modal-content'); }
async function refreshDeviceCount() { if (state.device?.role !== 'owner') return; try { const r = await api('/api/admin/devices'); const count = r.data.filter(d => d.status === 'pending').length; $('pending-count').textContent = count ? `${count} 待批准` : ''; } catch {} }
async function deviceModal() {
  const content = modal('设备管理'); content.append(el('p', '新设备只有经此电脑批准后，才能读取会话和发送指令。', 'muted'));
  const r = await api('/api/admin/devices'); if (!r.data.length) content.append(el('p', '还没有手机申请连接。先打开「连接手机」。'));
  for (const d of r.data) {
    const card = el('div', undefined, 'device-card'); card.append(el('strong', `${d.label} · ${d.status === 'pending' ? '等待批准' : d.status === 'approved' ? '已批准' : '已撤销'}`)); card.append(el('p', `${d.ip} · ${new Date(d.createdAt).toLocaleString('zh-CN')}\n${d.agent}`));
    if (d.status === 'pending') card.append(button('批准设备', async () => { await post(`/api/admin/devices/${d.id}`, { status: 'approved' }); await deviceModal(); refreshDeviceCount(); }, 'primary'));
    if (d.status !== 'revoked') card.append(button('撤销设备', async () => { await post(`/api/admin/devices/${d.id}`, { status: 'revoked' }); await deviceModal(); refreshDeviceCount(); })); content.append(card);
  }
  content.append(button('刷新申请', deviceModal));
}
async function copy(text) { try { await navigator.clipboard.writeText(text); } catch { const t = el('textarea', text); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); } toast('已复制'); }
async function phoneModal() {
  await loadStatus(); const content = modal('连接你的手机');
  content.append(el('p', state.status.secureRemote ? '手机与电脑加入同一个 Tailscale 网络后，用手机浏览器打开私有 HTTPS 地址。' : '先让手机与这台 Mac 连接同一个 Wi‑Fi，然后打开下面的地址。跨网络访问使用 Tailscale。'));
  for (const url of state.status.mobileUrls) { content.append(el('code', url), button('复制地址', () => copy(url))); }
  content.append(el('p', '登录密码在本机 .local/access.txt。新手机登录后，到此面板「设备管理」批准。', 'muted small'));
  const row = el('div'); row.append(button('显示面板密码', async () => { const r = await api('/api/admin/pairing'); row.replaceChildren(el('code', r.password), button('复制登录密码', () => copy(r.password))); })); content.append(row);
  content.append(el('p', '手机浏览器可添加到主屏幕；电脑须开机、联网，面板须保持运行。', 'muted small'));
}
async function newThreadModal() {
  const content = modal('新建本地会话'); content.append(el('p', '选择项目。模型与中转地址自动继承电脑配置。', 'muted'));
  const select = el('select'); for (const p of state.projects) { const o = el('option', `${p.name} · ${p.path}`); o.value = p.path; select.append(o); } select.value = $('project-select').value || state.projects[0]?.path; content.append(select);
  content.append(button('创建会话', async () => { const r = await post('/api/threads', { cwd: select.value, sandbox: $('sandbox').value }); $('modal').close(); $('project-select').value = select.value; await loadThreads(); await loadThread(r.thread.id); }, 'primary'));
}
async function fileModal(relative = '') {
  const root = $('project-select').value || state.thread?.cwd; if (!root) return toast('请先选择项目或会话');
  const content = modal('项目文件'); const r = await api(`/api/files?${new URLSearchParams({ root, path: relative })}`);
  content.append(el('p', r.path || root, 'muted small'));
  if (r.path) { const parent = r.path.split('/').slice(0, -1).join('/'); content.append(button('← 上一级', () => fileModal(parent))); }
  if (r.type === 'file') content.append(el('pre', r.content, 'file-preview'));
  else for (const f of r.data) content.append(button(`${f.directory ? '▧' : '↳'} ${f.name}`, () => fileModal(f.path), 'file-entry'));
}
async function olderHistory() {
  if (!state.thread || !state.nextHistory) return;
  const r = await api(`/api/threads/${state.thread.id}/history?${new URLSearchParams({ cursor: state.nextHistory })}`);
  const fragment = document.createDocumentFragment(); const oldHeight = $('messages').scrollHeight;
  for (const t of [...r.data].reverse()) for (const item of t.items) if (!state.items.has(item.id)) { const node = itemNode(item); state.items.set(item.id, { item, node }); fragment.append(node); }
  $('messages').prepend(fragment); $('messages').scrollTop += $('messages').scrollHeight - oldHeight; state.nextHistory = r.nextCursor; $('older-history').hidden = !r.nextCursor;
}
$('login-form').onsubmit = async e => { e.preventDefault(); $('auth-error').textContent = ''; const submit = e.submitter; submit.disabled = true; try { await post('/api/auth/login', { password: $('password').value, label: $('device-label').value }); $('password').value = ''; await updateAuth(); } catch (error) { $('auth-error').textContent = error.message; } finally { submit.disabled = false; } };
$('cancel-wait').onclick = async () => { await post('/api/auth/logout'); await updateAuth(); };
$('logout').onclick = async () => { await post('/api/auth/logout'); state.stream?.close(); showLogin(); };
$('open-drawer').onclick = () => drawer(true); $('close-drawer').onclick = () => drawer(false); $('drawer-backdrop').onclick = () => drawer(false);
$('home').onclick = () => { if (state.thread) state.drafts.set(state.thread.id, $('message-input').value); state.epoch++; state.thread = null; state.desktopBusy = false; state.items.clear(); state.loading = false; sessionStorage.removeItem('lastThread'); $('thread-title').textContent = '开始一段新工作'; $('project-title').textContent = '我的工作空间'; $('thread-meta').hidden = true; $('messages').replaceChildren(welcome.cloneNode(true)); $('message-input').value = ''; $('message-input').disabled = true; $('older-history').hidden = true; renderThreads(); renderApprovals(); updateRun(); drawer(false); };
$('project-select').onchange = () => loadThreads().catch(e => toast(e.message));
$('thread-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadThreads().catch(e => toast(e.message)), 350); };
$('refresh').onclick = () => Promise.all([loadThreads(), loadStatus()]).then(async () => { if (state.thread) await loadThread(state.thread.id); toast('已刷新'); }).catch(e => toast(e.message));
$('more-threads').onclick = () => loadThreads(true).catch(e => toast(e.message));
$('older-history').onclick = () => olderHistory().catch(e => toast(e.message));
$('new-thread').onclick = () => newThreadModal().catch(e => toast(e.message));
$('devices').onclick = () => deviceModal().catch(e => toast(e.message));
$('connect-phone').onclick = () => phoneModal().catch(e => toast(e.message));
$('files').onclick = () => fileModal().catch(e => toast(e.message));
$('modal-close').onclick = () => $('modal').close();
$('modal').onclick = e => { if (e.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('modal').close(); } };
$('sandbox').onchange = () => { if ($('sandbox').value === 'danger-full-access' && !confirm('完整访问允许 Codex 操作项目外的文件并执行命令。确认给此会话完整访问？')) $('sandbox').value = 'workspace-write'; };
$('add-project').onclick = () => {
  const content = modal('添加本地项目'); content.append(el('p', '输入这台 Mac 上的文件夹完整路径。仅电脑端可以添加。', 'muted')); const input = el('input'); input.placeholder = '/Users/你/projects/my-app'; content.append(input);
  content.append(button('添加项目', async () => { await post('/api/admin/projects', { path: input.value }); await loadProjects(); $('modal').close(); toast('项目已添加'); }, 'primary'));
};
$('stop').onclick = async () => { try { await post(`/api/threads/${state.thread.id}/interrupt`); toast('已发送停止请求'); } catch (e) { toast(e.message); } };
$('release-writer').onclick = async () => {
  $('release-writer').disabled = true;
  try { await post('/api/release', { confirmRelease: true }); toast('面板写入权已释放。现在到桌面点击「重试」。'); }
  catch (e) { toast(e.message); }
  finally { updateRun(); }
};
$('composer').onsubmit = async e => {
  e.preventDefault(); if (!state.thread || state.loading || state.active[state.thread.id] || state.desktopBusy || state.writers.get(state.thread.id)?.blocked) return;
  const text = $('message-input').value.trim(); if (!text) return; $('send').disabled = true;
  const id = state.thread.id;
  try { const r = await post(`/api/threads/${id}/send`, { text, sandbox: $('sandbox').value, clientId: clientId() }); state.drafts.delete(id); if (!state.completedTurns.has(r.turn.id)) state.active[id] = r.turn.id; if (state.thread?.id === id) { $('message-input').value = ''; $('message-input').style.height = ''; state.thread = r.thread; $('thread-meta').textContent = `${r.thread.cwd} · ${r.thread.model || state.status?.model || ''} · ${r.thread.modelProvider}`; putTurn(r.turn); scrollBottom(); } updateRun(); }
  catch (error) { if (error.code === 'THREAD_WRITER_BUSY') { state.writers.set(id, error.writer || { blocked: true, owner: 'unknown' }); state.drafts.set(id, text); } if (state.thread?.id === id) { toast(error.message); updateRun(); } }
};
$('message-input').oninput = e => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; };
$('message-input').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('composer').requestSubmit(); } };
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && state.device?.status === 'approved') { try { await loadStatus(); await loadThreads(); if (state.thread) await loadThread(state.thread.id); } catch (e) { toast(e.message); } } });
setInterval(() => { if (state.device?.status === 'approved' && document.visibilityState === 'visible') { loadThreads().catch(() => {}); refreshDeviceCount(); } }, 20000);
(async () => {
  $('device-label').value = /iPhone|iPad/.test(navigator.userAgent) ? '我的 iPhone / iPad' : /Android/.test(navigator.userAgent) ? '我的 Android' : '我的浏览器';
  const setup = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (setup) { history.replaceState(null, '', '/'); try { await post('/api/auth/bootstrap', { token: setup }); } catch (e) { $('auth-error').textContent = e.message; } }
  await updateAuth();
})().catch(e => { $('auth-error').textContent = `连接失败：${e.message}`; });
