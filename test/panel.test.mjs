import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createPanel, APP_DIR } from '../server.mjs';
import { isPrivateIp, localAdminRequest, AuthStore } from '../lib/auth.mjs';
import { safeItem } from '../lib/codex.mjs';
import { contains } from '../lib/files.mjs';

class FakeBridge extends EventEmitter {
  constructor(root) { super(); this.root = root; this.ready = false; this.active = new Map(); this.approvals = new Map(); this.calls = []; this.id = crypto.randomUUID(); this.latestStatus = 'completed'; }
  async start() { this.ready = true; }
  async stop() { this.ready = false; }
  async rpc(method, params) {
    this.calls.push({ method, params });
    const thread = { id: this.id, cwd: this.root, name: 'test thread', model: 'existing-model', modelProvider: 'custom', updatedAt: 1, createdAt: 1, status: { type: 'notLoaded' }, preview: 'test', turns: [] };
    if (method === 'config/read') return { config: { model: 'existing-model', model_provider: 'custom', secret_key: 'DO_NOT_EXPOSE', model_providers: { custom: { base_url: 'SECRET_URL' } } } };
    if (method === 'thread/list') return { data: [thread], nextCursor: 'page2' };
    if (method === 'thread/read' || method === 'thread/start' || method === 'thread/resume') return { thread };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: this.latestStatus, items: [{ id: 'hidden', type: 'reasoning', content: ['DO_NOT_EXPOSE_REASONING'] }, { id: 'answer', type: 'agentMessage', text: 'hello' }] }] };
    if (method === 'turn/start') return { turn: { id: crypto.randomUUID(), status: 'inProgress', items: [] } };
    if (method === 'turn/interrupt') { this.active.delete(params.threadId); return {}; }
    throw new Error(`unexpected RPC: ${method}`);
  }
  answer(id, result) { assert.ok(this.approvals.has(id)); this.lastAnswer = result; this.approvals.delete(id); }
}

test('address, path, and rendering boundaries', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.9', '10.0.0.1', '172.31.0.1', '100.64.0.1', 'fd00::1']) assert.ok(isPrivateIp(ip));
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.168.1.999', 'bad']) assert.equal(isPrivateIp(ip), false);
  assert.equal(localAdminRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:123' } }), true);
  assert.equal(localAdminRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:123', 'x-forwarded-for': '100.80.0.3' } }), false);
  assert.equal(contains('/tmp/work', '/tmp/work/file'), true); assert.equal(contains('/tmp/work', '/tmp/work2/file'), false);
  assert.equal(safeItem({ type: 'reasoning', content: ['hidden'] }), null);
  assert.equal(safeItem({ id: 'x', type: 'commandExecution', aggregatedOutput: 'a'.repeat(50000) }).aggregatedOutput.length, 40000);
});

test('private panel HTTP integration', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-panel-test-'));
  const root = path.join(temp, 'project'); const home = path.join(temp, 'codex-home'); const local = path.join(temp, 'private');
  await fs.mkdir(root); await fs.mkdir(home); await fs.writeFile(path.join(root, 'hello.txt'), 'hello'); await fs.writeFile(path.join(root, '.env'), 'SECRET'); await fs.symlink('/etc/hosts', path.join(root, 'outside.txt'));
  await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { test: { id: 'test', name: '测试项目', rootPaths: [root] } } }));
  const bridge = new FakeBridge(root); const panel = await createPanel({ stateDir: local, codexHome: home, bridge });
  await new Promise(r => panel.server.listen(0, '0.0.0.0', r));
  t.after(async () => { await panel.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const port = panel.server.address().port; const base = `http://127.0.0.1:${port}`;
  const lanIp = Object.values(os.networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal && isPrivateIp(x.address))?.address;
  const remote = lanIp ? `http://${lanIp}:${port}` : base;
  const request = (route, { cookie, data, origin = base, url = base, headers = {}, method = data === undefined ? 'GET' : 'POST' } = {}) => fetch(url + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  let owner, phone, phoneId;
  await t.test('no public history, files, configuration, or event stream', async () => {
    for (const route of ['/api/threads', '/api/projects', '/api/status', '/api/events', '/api/files']) assert.equal((await request(route)).status, 401);
    const page = await request('/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
  await t.test('bootstrap is local and single-use', async () => {
    const token = panel.auth.bootstrap;
    if (lanIp) assert.equal((await request('/api/auth/bootstrap', { url: remote, origin: remote, data: { token } })).status, 403);
    const r = await request('/api/auth/bootstrap', { data: { token } }); assert.equal(r.status, 200); owner = r.headers.get('set-cookie').split(';')[0]; assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await request('/api/auth/bootstrap', { data: { token } })).status, 403);
    assert.equal((await request('/api/control/login-link', { data: { token: 'wrong' } })).status, 403);
    const fresh = await request('/api/control/login-link', { data: { token: panel.auth.controlKey } }); assert.equal(fresh.status, 200); assert.match((await fresh.json()).url, /#setup=/);
    if (lanIp) assert.equal((await request('/api/control/login-link', { url: remote, origin: remote, data: { token: panel.auth.controlKey } })).status, 403);
  });
  await t.test('provider retained, secrets and reasoning not forwarded', async () => {
    const r = await request('/api/status', { cookie: owner }); const text = await r.text(); assert.match(text, /custom/); assert.doesNotMatch(text, /SECRET|DO_NOT_EXPOSE/);
    const h = await request(`/api/threads/${bridge.id}/history`, { cookie: owner }); assert.equal(h.status, 200); assert.doesNotMatch(await h.text(), /reasoning|DO_NOT_EXPOSE/);
    assert.equal((await request('/api/threads', { cookie: owner })).status, 200);
  });
  await t.test('new phone cannot read anything until local approval', async () => {
    const password = (await fs.readFile(path.join(local, 'access.txt'), 'utf8')).split('\n')[1];
    const r = await request('/api/auth/login', { url: remote, origin: remote, headers: lanIp ? {} : { 'x-forwarded-for': '100.80.1.2' }, data: { password, label: '测试手机' } });
    assert.equal(r.status, 200); const data = await r.json(); assert.equal(data.device.status, 'pending'); assert.equal(data.device.role, 'phone'); phoneId = data.device.id; phone = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/threads', { cookie: phone })).status, 403);
    assert.equal((await request('/api/admin/devices', { cookie: phone })).status, 403);
    assert.equal((await request(`/api/admin/devices/${phoneId}`, { cookie: owner, data: { status: 'approved' } })).status, 200);
    assert.equal((await request('/api/threads', { cookie: phone })).status, 200);
    assert.equal((await request('/api/admin/pairing', { cookie: phone })).status, 403);
    if (lanIp) assert.equal((await request('/api/admin/devices', { cookie: owner, url: remote })).status, 403);
  });
  await t.test('Origin, Host, content type, malformed IDs and unknown RPC guarded', async () => {
    assert.equal((await request('/api/threads', { cookie: owner, data: {}, origin: 'https://evil.example' })).status, 403);
    const badHost = await new Promise((resolve, reject) => { const r = http.get(base + '/api/threads', { headers: { Host: 'evil.example', Cookie: owner } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); });
    assert.equal(badHost, 403);
    assert.equal((await request('/api/auth/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/threads/not-a-uuid', { cookie: owner })).status, 400);
    assert.equal((await request('/api/rpc', { cookie: owner, data: { method: 'config/read' } })).status, 404);
    const r = await fetch(base + '/api/threads', { method: 'POST', headers: { Cookie: owner, Origin: base, 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(r.status, 415);
  });
  await t.test('file read is root-scoped, symlink-scoped and blocks private files', async () => {
    for (const name of ['.env', '../codex-home', 'outside.txt']) assert.equal((await request('/api/files?' + new URLSearchParams({ root, path: name }), { cookie: owner })).status, 403);
    const r = await request('/api/files?' + new URLSearchParams({ root, path: 'hello.txt' }), { cookie: owner }); assert.equal(r.status, 200); assert.equal((await r.json()).content, 'hello');
  });
  await t.test('start and resume inherit provider; concurrent desktop turn blocked', async () => {
    assert.equal((await request('/api/threads', { cookie: phone, data: { cwd: os.homedir() } })).status, 403);
    assert.equal((await request('/api/threads', { cookie: phone, data: { cwd: root, sandbox: 'invalid' } })).status, 400);
    assert.equal((await request('/api/threads', { cookie: phone, data: { cwd: root } })).status, 201);
    bridge.latestStatus = 'inProgress'; assert.equal((await request(`/api/threads/${bridge.id}/send`, { cookie: phone, data: { text: 'hello' } })).status, 409);
    bridge.latestStatus = 'completed'; assert.equal((await request(`/api/threads/${bridge.id}/send`, { cookie: phone, data: { text: 'hello' } })).status, 202);
    assert.equal((await request(`/api/threads/${bridge.id}/send`, { cookie: phone, data: { text: 'duplicate' } })).status, 409);
    assert.equal((await request(`/api/threads/${bridge.id}/interrupt`, { cookie: phone, data: {} })).status, 200);
    for (const c of bridge.calls.filter(c => ['thread/start', 'turn/start'].includes(c.method))) { assert.equal(c.params.modelProvider, undefined); assert.equal(c.params.model, undefined); }
    const resumed = bridge.calls.find(c => c.method === 'thread/resume'); assert.equal(resumed.params.modelProvider, 'custom'); assert.equal(resumed.params.model, 'existing-model');
  });
  await t.test('approvals validate decision and route once', async () => {
    bridge.approvals.set('1', { requestId: '1', rpcId: 1, method: 'item/commandExecution/requestApproval', params: { threadId: bridge.id } });
    assert.equal((await request('/api/approvals/1', { cookie: phone, data: { decision: 'anything' } })).status, 400);
    assert.equal((await request('/api/approvals/1', { cookie: phone, data: { decision: 'accept' } })).status, 200);
    assert.deepEqual(bridge.lastAnswer, { decision: 'accept' });
    assert.equal((await request('/api/approvals/1', { cookie: phone, data: { decision: 'accept' } })).status, 409);
  });
  await t.test('SSE emits connected snapshot, revocation blocks reconnect', async () => {
    const abort = new AbortController(); const r = await fetch(base + '/api/events', { headers: { Cookie: phone }, signal: abort.signal }); assert.equal(r.status, 200);
    const reader = r.body.getReader(); const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /panel\/snapshot/); abort.abort(); await reader.cancel().catch(() => {});
    assert.equal((await request(`/api/admin/devices/${phoneId}`, { cookie: owner, data: { status: 'revoked' } })).status, 200);
    assert.equal((await request('/api/threads', { cookie: phone })).status, 401);
  });
  await t.test('credentials at rest are private, derived, not browser tokens', async () => {
    const s = await fs.readFile(path.join(local, 'auth.json'), 'utf8'); assert.doesNotMatch(s, new RegExp(owner.split('=')[1]));
    assert.equal((await fs.stat(path.join(local, 'auth.json'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(local, 'access.txt'))).mode & 0o777, 0o600);
  });
  await t.test('password attempts are rate-limited', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await request('/api/auth/login', { data: { password: 'wrong' } })).status, 401);
    assert.equal((await request('/api/auth/login', { data: { password: 'wrong' } })).status, 429);
  });
});
