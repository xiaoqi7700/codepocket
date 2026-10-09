import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

const clip = (s, max = 40000) => typeof s === 'string' ? s.slice(0, max) : s;
export function writerConflict(error) { return /\bthread\b[^\n]*\balready has an active writer\b/i.test(String(error?.message || error || '')); }
export function writerConflictError(error, writer = { blocked: true, owner: 'unknown' }) {
  const holder = writer.owner === 'desktop' ? '桌面 Codex' : '另一个 Codex 客户端';
  return Object.assign(new Error(`此会话被${holder}占用，这条消息尚未提交。停止生成不一定释放写入权；要继续原会话，请完全退出桌面客户端后重新检查。也可手动复制历史到新会话继续。`), { status: 409, code: 'THREAD_WRITER_BUSY', recovery: 'close-desktop-or-use-shared-server', writer: { ...writer, blocked: true }, cause: error });
}
export function safeItem(item) {
  if (!item || item.type === 'reasoning') return null;
  const result = { id: item.id, type: item.type, status: item.status };
  if (item.type === 'userMessage') result.content = (item.content || []).filter(x => x.type === 'text').map(x => ({ type: 'text', text: clip(x.text) }));
  else if (['agentMessage', 'plan'].includes(item.type)) { result.text = clip(item.text, 120000); result.phase = item.phase; }
  else if (item.type === 'commandExecution') Object.assign(result, { command: clip(item.command), cwd: item.cwd, aggregatedOutput: clip(item.aggregatedOutput), exitCode: item.exitCode });
  else if (item.type === 'fileChange') result.changes = (item.changes || []).slice(0, 30).map(c => ({ path: c.path, kind: c.kind, diff: clip(c.diff) }));
  else if (item.type === 'mcpToolCall') Object.assign(result, { server: item.server, tool: item.tool, error: item.error ? { message: clip(item.error.message, 1000) } : null });
  else if (item.type === 'webSearch') result.query = clip(item.query, 4000);
  else if (item.type === 'contextCompaction') result.text = '上下文已压缩';
  else result.text = item.type;
  return result;
}
export function safeTurn(t) { return { id: t.id, status: t.status, error: t.error ? { message: clip(t.error.message, 2000) } : null, startedAt: t.startedAt, completedAt: t.completedAt, items: (t.items || []).map(safeItem).filter(Boolean) }; }
export function safeThread(t) { return { id: t.id, name: t.name, preview: clip(t.preview, 250), cwd: t.cwd, projectId: t.projectId, model: t.model, modelProvider: t.modelProvider, status: t.status, updatedAt: t.updatedAt, createdAt: t.createdAt }; }

export class CodexBridge extends EventEmitter {
  constructor({ bin = process.env.CODEX_BIN || 'codex', cwd = process.cwd(), env = process.env, idleReleaseMs = 1500, spawnProcess = spawn } = {}) {
    super(); this.bin = bin; this.cwd = cwd; this.env = env; this.pending = new Map(); this.approvals = new Map(); this.active = new Map(); this.id = 0; this.ready = false;
    this.idleReleaseMs = idleReleaseMs; this.spawnProcess = spawnProcess; this.owned = new Set(); this.unsaved = new Set(); this.completedTurns = new Set(); this.leases = 0; this.runtimeActive = new Set();
  }
  hold() {
    this.leases++; clearTimeout(this.idleTimer);
    let released = false;
    return () => { if (released) return; released = true; this.leases--; this.scheduleRelease(); };
  }
  canRelease() { return !this.active.size && !this.runtimeActive.size && !this.approvals.size && !this.pending.size && !this.leases && !this.starting && !this.unsaved.size; }
  scheduleRelease() {
    clearTimeout(this.idleTimer);
    if (!this.ready || !this.owned.size || !this.canRelease() || this.releasing || this.shuttingDown) return;
    this.idleTimer = setTimeout(() => { this.releaseIdle('automatic').catch(e => this.emit('event', { method: 'bridge/status', params: { ready: this.ready, message: e.message } })); }, this.idleReleaseMs);
    this.idleTimer.unref?.();
  }
  async releaseIdle(reason = 'manual') {
    if (this.releasing) return this.releasing;
    if (!this.canRelease()) throw Object.assign(new Error('面板还有执行中的任务、审批或未提交的新会话，暂不释放。请等待任务结束。'), { status: 409, code: 'PANEL_NOT_IDLE' });
    if (!this.child) return { released: false };
    const ids = [...this.owned]; const child = this.child;
    clearTimeout(this.idleTimer);
    this.releasing = (async () => {
      for (const id of ids) {
        const result = await this.requestRaw('thread/read', { threadId: id, includeTurns: false });
        if (result.thread?.status?.type === 'active') throw Object.assign(new Error('会话仍在执行，暂不交回桌面'), { status: 409, code: 'PANEL_NOT_IDLE' });
        if (!result.thread?.ephemeral) try {
          const goal = await this.requestRaw('thread/goal/get', { threadId: id });
          if (goal.goal?.status === 'active') throw Object.assign(new Error('会话还有持续目标，暂不交回桌面'), { status: 409, code: 'PANEL_NOT_IDLE' });
        } catch (e) { if (e.rpcCode !== -32601) throw e; }
      }
      if (!this.canRelease()) throw Object.assign(new Error('面板正在执行或提交工作，释放已推迟'), { status: 409, code: 'PANEL_NOT_IDLE' });
      this.intentionalStop = child;
      await this.stopChild(child);
      this.emit('event', { method: 'panel/writersReleased', params: { threadIds: ids, reason } });
      return { released: true, threadIds: ids };
    })();
    try { return await this.releasing; } finally { this.releasing = null; }
  }
  async start() {
    if (this.releasing) await this.releasing;
    if (this.shuttingDown) throw new Error('面板服务正在停止');
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async launch() {
    const child = this.child = this.spawnProcess(this.bin, ['app-server', '--listen', 'stdio://'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = reason => {
      if (this.child !== child) return;
      const released = this.intentionalStop === child;
      this.ready = false; this.child = null; this.active.clear(); this.approvals.clear(); this.owned.clear(); this.unsaved.clear(); this.runtimeActive.clear();
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
      this.pending.clear(); clearTimeout(this.idleTimer);
      this.emit('event', { method: 'bridge/status', params: { ready: false, idle: released, message: released ? '会话写入权已释放，面板随时可重新连接' : reason } });
    };
    child.once('error', e => finish(`Codex 启动失败：${e.message}`));
    child.once('exit', code => finish(`Codex 进程已退出（${code ?? 'signal'}）`));
    child.stdin.on('error', () => {});
    // Stderr can contain local file paths; never forward it to browsers or write credentials to logs.
    child.stderr.on('data', () => {});
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => { try { this.onMessage(JSON.parse(line)); } catch { /* not JSON */ } });
    await this.requestRaw('initialize', { clientInfo: { name: 'mobile_codex_private_panel', title: 'Mobile Codex Private Panel', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    this.ready = true; this.emit('event', { method: 'bridge/status', params: { ready: true } });
  }
  requestRaw(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) return reject(new Error('Codex 服务未连接'));
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 接口超时：${method}。请刷新核对状态，不要重复提交。`)); }, 90000);
      this.pending.set(id, { resolve, reject, timer, method, params });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async rpc(method, params = {}) {
    const unhold = this.hold();
    try { await this.start(); return await this.requestRaw(method, params); }
    finally { unhold(); }
  }
  onMessage(message) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id); if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (!message.error) {
        const result = message.result || {};
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(p.method) && result.thread?.id) {
          this.owned.add(result.thread.id);
          // A blank new thread or ephemeral thread may not exist on disk yet.
          if (p.method === 'thread/start' || result.thread.ephemeral) this.unsaved.add(result.thread.id);
        }
        if (p.method === 'turn/start' && result.turn?.id) {
          this.unsaved.delete(p.params.threadId);
          if (!this.completedTurns.has(result.turn.id)) this.active.set(p.params.threadId, result.turn.id);
        }
      }
      message.error ? p.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code })) : p.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'];
      if (!supported.includes(message.method)) {
        this.child?.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This client does not support this interactive tool' } }) + '\n');
        return;
      }
      const key = String(message.id);
      const entry = { requestId: key, method: message.method, params: message.params };
      this.approvals.set(key, { ...entry, rpcId: message.id });
      this.emit('event', { method: 'panel/approval', params: entry }); return;
    }
    const { method, params = {} } = message;
    if (method === 'turn/started') this.active.set(params.threadId, params.turn.id);
    if (method === 'thread/status/changed') {
      if (params.status?.type === 'active') this.runtimeActive.add(params.threadId);
      else this.runtimeActive.delete(params.threadId);
    }
    if (method === 'turn/completed') {
      this.completedTurns.add(params.turn.id);
      if (this.completedTurns.size > 1000) this.completedTurns.delete(this.completedTurns.values().next().value);
      this.active.delete(params.threadId);
      for (const [id, a] of this.approvals) if (a.params.threadId === params.threadId) this.approvals.delete(id);
    }
    if (method === 'serverRequest/resolved') {
      this.approvals.delete(String(params.requestId));
      this.emit('event', { method: 'panel/approvalResolved', params: { requestId: String(params.requestId) } });
      this.scheduleRelease();
    }
    const allowed = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'thread/status/changed', 'error'];
    if (!allowed.includes(method)) return;
    const safe = { ...params };
    if (safe.item) { safe.item = safeItem(safe.item); if (!safe.item) return; }
    if (safe.turn) safe.turn = safeTurn(safe.turn);
    if (safe.delta) safe.delta = clip(safe.delta, 16000);
    this.emit('event', { method, params: safe });
    if (method === 'turn/completed' || method === 'serverRequest/resolved' || method === 'thread/status/changed') this.scheduleRelease();
  }
  answer(requestId, response) {
    const request = this.approvals.get(String(requestId));
    if (!request) throw Object.assign(new Error('该审批已结束或不存在'), { status: 409 });
    this.child.stdin.write(JSON.stringify({ id: request.rpcId, result: response }) + '\n');
    this.approvals.delete(String(requestId));
    this.emit('event', { method: 'panel/approvalResolved', params: { requestId: String(requestId) } });
  }
  async stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off('exit', onExit); reject(new Error('空闲执行器尚未退出，写入权是否释放仍需核对')); }, 7000);
      child.once('exit', onExit); child.kill('SIGTERM');
    });
  }
  async stop() { clearTimeout(this.idleTimer); this.shuttingDown = true; try { await this.stopChild(this.child); } finally { this.shuttingDown = false; } }
}
