import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AuthStore, sessionCookie, localAdminRequest, isPrivateIp, isLoopback } from './lib/auth.mjs';
import { CodexBridge, safeThread, safeTurn, writerConflict, writerConflictError } from './lib/codex.mjs';
import { createWriterInspector } from './lib/writer.mjs';
import { readJson, atomicWrite, contains } from './lib/files.mjs';

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP_DIR);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
const modes = new Set(['read-only', 'workspace-write', 'danger-full-access']);
function checkId(id) { if (!uuid.test(id)) throw fail('无效会话 ID'); return id; }
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail('请求必须为 JSON', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw fail('请求体过大', 413); chunks.push(chunk); }
  try { const b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error(); return b; }
  catch { throw fail('请求 JSON 无效'); }
}
function knownAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal && isPrivateIp(x.address)).map(x => x.address);
}

export async function createPanel(options = {}) {
  const stateDir = options.stateDir || process.env.PANEL_STATE_DIR || path.join(APP_DIR, '.local');
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const bridge = options.bridge || new CodexBridge({ cwd: ROOT });
  const writerInspector = options.writerInspector || createWriterInspector({ codexHome, bridge });
  const instanceId = crypto.randomUUID();
  const auth = new AuthStore(stateDir); await auth.init();
  let extraProjects = await readJson(path.join(stateDir, 'projects.json'), []);
  const clients = new Set(), events = []; let eventId = 0, eventBytes = 0;
  const locks = new Set();
  const forkRequests = new Map();
  const hostSet = new Set(['localhost', '127.0.0.1', ...knownAddresses()]);

  async function projects() {
    const state = await readJson(path.join(codexHome, '.codex-global-state.json'), {});
    const saved = Object.values(state['local-projects'] || {}).filter(p => !String(p.id).startsWith('g-p-')).flatMap(p => (p.rootPaths || []).map(root => ({ id: p.id, name: p.name || path.basename(root), path: root })));
    const legacy = (state['electron-saved-workspace-roots'] || []).map(root => ({ id: root, path: root, name: state['electron-workspace-root-labels']?.[root] || path.basename(root) }));
    const list = [...saved, ...legacy, ...extraProjects, { id: 'current-workspace', name: path.basename(ROOT), path: ROOT }];
    const result = new Map();
    for (const p of list) {
      try { const real = await fs.realpath(p.path); if ((await fs.stat(real)).isDirectory() && !result.has(real)) result.set(real, { ...p, path: real }); } catch { /* stale saved project */ }
    }
    return [...result.values()];
  }
  async function projectPath(root) {
    const target = await fs.realpath(String(root || '')).catch(() => { throw fail('项目目录不存在'); });
    if (!(await projects()).some(p => p.path === target)) throw fail('请先在电脑面板中添加这个项目', 403);
    return target;
  }
  async function filePath(root, relative) {
    const target = await fs.realpath(path.resolve(root, relative || '.')).catch(() => { throw fail('文件不存在', 404); });
    if (!contains(root, target)) throw fail('文件路径超出项目范围', 403);
    const components = path.relative(root, target).split(path.sep);
    if (components.some(c => c.startsWith('.') || /\.(pem|key|p12|pfx)$/i.test(c))) throw fail('私有配置与密钥文件不通过面板显示', 403);
    return target;
  }
  const broadcast = message => {
    const entry = { id: ++eventId, message }; const bytes = Buffer.byteLength(JSON.stringify(entry));
    entry.bytes = bytes; events.push(entry); eventBytes += bytes;
    while (events.length > 500 || eventBytes > 1024 * 1024) eventBytes -= events.shift().bytes;
    const value = `id: ${entry.id}\ndata: ${JSON.stringify(message)}\n\n`;
    for (const c of clients) {
      const device = auth.getDevice(c.req);
      if (!device || device.status !== 'approved' || c.res.writableLength > 1024 * 1024) { c.res.end(); clients.delete(c); continue; }
      c.res.write(value);
    }
  };
  bridge.on('event', broadcast);

  async function guard(req) {
    if (!isPrivateIp(req.socket.remoteAddress)) throw fail('仅允许本机、局域网或 Tailscale 私网访问', 403);
    const parsed = new URL(`http://${req.headers.host || ''}`);
    const network = await readJson(path.join(stateDir, 'network.json'), {});
    const allowedHost = network.publicOrigin ? new URL(network.publicOrigin).hostname : process.env.PANEL_PUBLIC_HOST;
    if (!hostSet.has(parsed.hostname) && !knownAddresses().includes(parsed.hostname) && parsed.hostname !== allowedHost) throw fail('访问主机名不受信任', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('跨站请求已阻止', 403);
    const secureProxy = isLoopback(req.socket.remoteAddress) && (req.headers['x-forwarded-proto'] === 'https' || network.publicOrigin && new URL(network.publicOrigin).host === req.headers.host);
    const protocol = req.socket.encrypted || secureProxy ? 'https:' : 'http:';
    req.panelSecure = protocol === 'https:';
    const expected = `${protocol}//${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expected) throw fail('请求来源不匹配', 403);
    if (!['GET', 'HEAD'].includes(req.method) && !req.headers.origin) throw fail('缺少同源验证', 403);
    return expected;
  }
  function requireDevice(req) {
    const d = auth.getDevice(req);
    if (!d) throw fail('请先登录', 401);
    if (d.status !== 'approved') throw fail('请在电脑上批准此设备', 403);
    return d;
  }
  function requireOwner(req) {
    const d = requireDevice(req);
    if (d.role !== 'owner' || !localAdminRequest(req)) throw fail('设备管理仅允许在电脑本机操作', 403);
    return d;
  }
  async function threadMeta(id) { return (await bridge.rpc('thread/read', { threadId: checkId(id), includeTurns: false })).thread; }
  async function withLock(id, fn) {
    if (locks.has(id)) throw fail('该会话正在提交，请稍后刷新', 409);
    locks.add(id); const unhold = bridge.hold?.();
    try { return await fn(); } finally { locks.delete(id); unhold?.(); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      await guard(req);
      const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
      if (route === '/api/control/identity' && req.method === 'GET' && localAdminRequest(req)) return json(res, 200, { instanceId });
      if (route === '/api/control/login-link' && req.method === 'POST') {
        const b = await body(req); const value = auth.newLoginLink(req, b.token);
        return json(res, 200, { url: `http://${req.headers.host}/#setup=${value}` });
      }
      if (route === '/api/auth/session' && req.method === 'GET') return json(res, 200, { device: auth.publicDevice(auth.getDevice(req)), local: localAdminRequest(req) });
      if (['/api/auth/login', '/api/auth/bootstrap'].includes(route) && req.method === 'POST') {
        const b = await body(req);
        const result = route.endsWith('bootstrap') ? await auth.bootstrapLogin(req, b.token) : await auth.login(req, b.password, b.label);
        return json(res, 200, { device: result.device }, { 'Set-Cookie': sessionCookie(result.secret, req) });
      }
      if (route === '/api/auth/logout' && req.method === 'POST') {
        await body(req); await auth.logout(req);
        broadcast({ method: 'panel/devicesChanged', params: {} });
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'mcpanel=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
      }
      if (route.startsWith('/api/')) {
        requireDevice(req);
        if (route.startsWith('/api/admin/')) requireOwner(req);
        if (route === '/api/status' && req.method === 'GET') {
          const r = await bridge.rpc('config/read', { includeLayers: false }); const config = r.config || {};
          const network = await readJson(path.join(stateDir, 'network.json'), {});
          return json(res, 200, { ready: bridge.ready, model: config.model || null, provider: config.model_provider || config.modelProvider || '默认提供方', active: Object.fromEntries(bridge.active), idleReleaseEnabled: !!bridge.releaseIdle, mobileUrls: [...new Set([...knownAddresses().map(ip => `http://${ip}:${server.address().port}`), network.publicOrigin].filter(Boolean))], secureRemote: !!network.publicOrigin });
        }
        if (route === '/api/projects' && req.method === 'GET') return json(res, 200, { data: await projects() });
        if (route === '/api/threads' && req.method === 'GET') {
          const params = { limit: 40, sortKey: 'updated_at', modelProviders: [] };
          if (url.searchParams.get('cursor')) params.cursor = url.searchParams.get('cursor');
          if (url.searchParams.get('cwd')) params.cwd = await projectPath(url.searchParams.get('cwd'));
          if (url.searchParams.get('q')) params.searchTerm = url.searchParams.get('q').slice(0, 200);
          const result = await bridge.rpc('thread/list', params);
          return json(res, 200, { data: result.data.map(safeThread), nextCursor: result.nextCursor });
        }
        if (route === '/api/threads' && req.method === 'POST') {
          const b = await body(req); const cwd = await projectPath(b.cwd); const sandbox = b.sandbox || 'workspace-write';
          if (!modes.has(sandbox)) throw fail('无效执行权限');
          const ephemeral = b.ephemeral === true;
          if (ephemeral) requireOwner(req);
          const r = await bridge.rpc('thread/start', { cwd, sandbox, approvalPolicy: 'on-request', ephemeral });
          return json(res, 201, { thread: safeThread(r.thread) });
        }
        const match = route.match(/^\/api\/threads\/([^/]+)(?:\/(history|send|interrupt|fork))?$/);
        if (match) {
          const id = checkId(match[1]), action = match[2];
          if (!action && req.method === 'GET') return json(res, 200, { thread: safeThread(await threadMeta(id)), activeTurnId: bridge.active.get(id) || null, writer: await writerInspector(id) });
          if (action === 'history' && req.method === 'GET') {
            const p = { threadId: id, limit: 20, itemsView: 'full', sortDirection: 'desc' };
            if (url.searchParams.get('cursor')) p.cursor = url.searchParams.get('cursor');
            const r = await bridge.rpc('thread/turns/list', p);
            return json(res, 200, { data: r.data.map(safeTurn), nextCursor: r.nextCursor });
          }
          if (action === 'send' && req.method === 'POST') {
            const b = await body(req); const sandbox = b.sandbox || 'workspace-write';
            if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 40000) throw fail('消息必须为 1–40000 字');
            if (!modes.has(sandbox)) throw fail('无效执行权限');
            const r = await withLock(id, async () => {
              if (bridge.active.has(id)) throw fail('该会话正在执行。请等待完成或点击停止后再发送。', 409);
              const writer = await writerInspector(id);
              if (writer.blocked) throw writerConflictError(null, writer);
              let meta = await threadMeta(id);
              // A persisted in-progress desktop turn must not be resumed by a second executor.
              if (!meta.ephemeral) {
                const history = await bridge.rpc('thread/turns/list', { threadId: id, limit: 1, itemsView: 'summary', sortDirection: 'desc' });
                if (history.data?.[0]?.status === 'inProgress') throw fail('这条会话可能仍在桌面端执行，请先在桌面停止，再刷新。', 409);
                const { config } = await bridge.rpc('config/read', { includeLayers: false, cwd: meta.cwd });
                let resumed;
                try { resumed = await bridge.rpc('thread/resume', { threadId: id, excludeTurns: true, sandbox, approvalPolicy: 'on-request', model: config.model || undefined, modelProvider: config.model_provider || config.modelProvider || undefined }); }
                catch (e) { if (writerConflict(e)) throw writerConflictError(e, await writerInspector(id)); throw e; }
                meta = resumed.thread;
              }
              const result = await bridge.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: b.text, text_elements: [] }], clientUserMessageId: typeof b.clientId === 'string' ? b.clientId.slice(0, 80) : undefined, approvalPolicy: 'on-request' });
              if (!bridge.completedTurns?.has(result.turn.id)) bridge.active.set(id, result.turn.id);
              return { thread: safeThread(meta), turn: safeTurn(result.turn) };
            });
            return json(res, 202, r);
          }
          if (action === 'fork' && req.method === 'POST') {
            const b = await body(req);
            if (b.confirmFork !== true) throw fail('复制历史会创建新会话，需要你明确确认');
            const sandbox = b.sandbox || 'workspace-write'; if (!modes.has(sandbox)) throw fail('无效执行权限');
            if (b.clientId !== undefined && (typeof b.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(b.clientId))) throw fail('无效复制请求 ID');
            const key = `${id}:${b.clientId || crypto.randomUUID()}`;
            const previous = forkRequests.get(key);
            if (previous && previous.sandbox !== sandbox) throw fail('同一复制请求的执行权限不一致', 409);
            if (previous) return json(res, 201, await previous.promise);
            const entry = { sandbox, createdAt: Date.now() };
            entry.promise = (async () => {
              const meta = await threadMeta(id);
              const { config } = await bridge.rpc('config/read', { includeLayers: false, cwd: meta.cwd });
              // Snapshot saved history to a NEW ID; never change/release the source writer.
              const result = await bridge.rpc('thread/fork', { threadId: id, excludeTurns: true, sandbox, approvalPolicy: 'on-request', model: config.model || undefined, modelProvider: config.model_provider || config.modelProvider || undefined });
              entry.done = true;
              return { thread: safeThread(result.thread), forkedFrom: id };
            })();
            forkRequests.set(key, entry);
            try { return json(res, 201, await entry.promise); }
            catch (e) { forkRequests.delete(key); throw e; }
            finally {
              for (const [k, value] of forkRequests) if (value.done && (forkRequests.size > 100 || Date.now() - value.createdAt > 600000)) forkRequests.delete(k);
            }
          }
          if (action === 'interrupt' && req.method === 'POST') {
            await body(req); const turnId = bridge.active.get(id);
            if (!turnId) throw fail('面板没有正在执行的任务', 409);
            await bridge.rpc('turn/interrupt', { threadId: id, turnId }); return json(res, 200, { ok: true });
          }
        }
        if (route === '/api/release' && req.method === 'POST') {
          const b = await body(req);
          if (b.confirmRelease !== true) throw fail('请明确确认释放空闲面板会话');
          if (locks.size) throw fail('有消息正在提交，请稍后再释放', 409);
          if (!bridge.releaseIdle) throw fail('当前执行器不支持释放', 501);
          const result = await bridge.releaseIdle('manual'); return json(res, 200, { ...result, message: '面板写入权已释放，请在桌面点击重试。面板仍可查看历史。' });
        }
        if (route === '/api/approvals' && req.method === 'GET') return json(res, 200, { data: [...bridge.approvals.values()].map(({ rpcId, ...a }) => a) });
        if (route.startsWith('/api/approvals/') && req.method === 'POST') {
          const id = decodeURIComponent(route.slice('/api/approvals/'.length)); const b = await body(req);
          const a = bridge.approvals.get(id); if (!a) throw fail('审批已结束', 409);
          if (a.method === 'item/tool/requestUserInput') {
            const answers = {};
            for (const q of a.params.questions || []) {
              const value = b.answers?.[q.id];
              if (typeof value !== 'string' || value.length > 10000) throw fail('请填写所有问题的回答');
              answers[q.id] = { answers: [value] };
            }
            bridge.answer(id, { answers });
          } else {
            if (!['accept', 'decline', 'cancel'].includes(b.decision)) throw fail('无效审批决定');
            bridge.answer(id, { decision: b.decision });
          }
          return json(res, 200, { ok: true });
        }
        if (route === '/api/events' && req.method === 'GET') {
          if (clients.size >= 12) throw fail('连接数已达上限', 429);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          const last = Number(req.headers['last-event-id'] || 0);
          if (last) for (const e of events) if (e.id > last) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.message)}\n\n`);
          res.write(`data: ${JSON.stringify({ method: 'panel/snapshot', params: { ready: bridge.ready, active: Object.fromEntries(bridge.active), approvals: [...bridge.approvals.values()].map(({ rpcId, ...a }) => a) } })}\n\n`);
          const c = { req, res }; clients.add(c);
          const timer = setInterval(() => { const d = auth.getDevice(req); if (!d || d.status !== 'approved') res.end(); else res.write(': keepalive\n\n'); }, 10000);
          res.on('close', () => { clearInterval(timer); clients.delete(c); }); return;
        }
        if (route === '/api/files' && req.method === 'GET') {
          const root = await projectPath(url.searchParams.get('root'));
          const target = await filePath(root, url.searchParams.get('path'));
          const stat = await fs.stat(target);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(target, { withFileTypes: true });
            return json(res, 200, { type: 'directory', path: path.relative(root, target), data: entries.filter(x => !x.name.startsWith('.') && !['node_modules', 'vendor'].includes(x.name) && !/\.(pem|key|p12|pfx)$/i.test(x.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 250).map(x => ({ name: x.name, directory: x.isDirectory(), path: path.relative(root, path.join(target, x.name)) })) });
          }
          if (stat.size > 256 * 1024) throw fail('预览只支持 256 KB 以内的文本文件', 413);
          const data = await fs.readFile(target); if (data.includes(0)) throw fail('二进制文件不支持文本预览', 415);
          return json(res, 200, { type: 'file', path: path.relative(root, target), content: data.toString('utf8') });
        }
        if (route === '/api/admin/devices' && req.method === 'GET') return json(res, 200, { data: auth.state.devices.filter(d => d.role !== 'owner' && d.expiresAt > Date.now()).map(d => auth.publicDevice(d)) });
        if (route === '/api/admin/pairing' && req.method === 'GET') {
          const text = await fs.readFile(path.join(stateDir, 'access.txt'), 'utf8');
          const password = text.split('\n')[1]?.trim();
          if (!password) throw fail('密码文件不可用', 503);
          return json(res, 200, { password });
        }
        if (route.startsWith('/api/admin/devices/') && req.method === 'POST') {
          const b = await body(req); const d = await auth.setStatus(route.slice('/api/admin/devices/'.length), b.status);
          broadcast({ method: 'panel/devicesChanged', params: {} }); return json(res, 200, { device: d });
        }
        if (route === '/api/admin/projects' && req.method === 'POST') {
          const b = await body(req); const target = await fs.realpath(String(b.path || ''));
          if (!(await fs.stat(target)).isDirectory()) throw fail('请选择文件夹');
          extraProjects = extraProjects.filter(p => p.path !== target);
          extraProjects.push({ id: target, name: String(b.name || path.basename(target)).slice(0, 100), path: target });
          await atomicWrite(path.join(stateDir, 'projects.json'), JSON.stringify(extraProjects, null, 2)); return json(res, 200, { ok: true });
        }
        if (route === '/api/admin/restart' && req.method === 'POST') {
          await body(req); if (bridge.active.size) throw fail('仍有任务执行中，请先停止', 409);
          await bridge.stop(); await new Promise(r => setTimeout(r, 300)); await bridge.start(); return json(res, 200, { ok: true });
        }
        throw fail('接口不存在', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail('请求方法不支持', 405);
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'] };
      const asset = assets[route]; if (!asset) throw fail('页面不存在', 404);
      const data = await fs.readFile(path.join(APP_DIR, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const error = writerConflict(e) ? writerConflictError(e) : e;
      json(res, error.status || 502, { error: error.message || '请求失败', ...(error.code ? { code: error.code } : {}), ...(error.recovery ? { recovery: error.recovery } : {}), ...(error.writer ? { writer: error.writer } : {}) });
    }
  });
  server.maxHeadersCount = 60; server.headersTimeout = 15000; server.requestTimeout = 120000;
  await bridge.start();
  return { server, auth, bridge, stateDir, instanceId, async close() { for (const c of clients) c.res.end(); await bridge.stop(); await new Promise(r => server.close(r)); bridge.off('event', broadcast); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PANEL_PORT || 47831);
  const host = process.env.PANEL_HOST || '0.0.0.0';
  const panel = await createPanel();
  panel.server.on('error', e => { console.error(`启动失败：${e.message}`); panel.bridge.stop(); process.exitCode = 1; });
  panel.server.listen(port, host, async () => {
    const bootstrapUrl = `http://127.0.0.1:${port}/#setup=${panel.auth.bootstrap}`;
    await atomicWrite(path.join(panel.stateDir, 'runtime.json'), JSON.stringify({ pid: process.pid, port, host, instanceId: panel.instanceId, bootstrapUrl, startedAt: Date.now() }, null, 2));
    console.log(`Codex Pocket 已启动：http://127.0.0.1:${port}/`);
    console.log(`登录密码保存于 ${path.join(panel.stateDir, 'access.txt')}`);
    console.log('手机首次登录需在电脑端批准。中转配置未修改。');
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await panel.close(); await fs.unlink(path.join(panel.stateDir, 'runtime.json')).catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
