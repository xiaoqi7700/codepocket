import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createPanel } from '../server.mjs';
import { writerConflict, writerConflictError } from '../lib/codex.mjs';

// No actual Codex process or persisted user thread is accessed by these tests.
class WriterBridge extends EventEmitter {
  constructor(root) {
    super();
    this.root = root; this.id = crypto.randomUUID(); this.forkId = crypto.randomUUID(); this.ready = false;
    this.active = new Map(); this.approvals = new Map(); this.calls = [];
    this.resumeError = null;
  }
  async start() { this.ready = true; }
  async stop() { this.ready = false; }
  async rpc(method, params) {
    this.calls.push({ method, params });
    const thread = {
      id: this.id, cwd: this.root, name: 'writer ownership regression',
      model: 'configured-model', modelProvider: 'custom',
      updatedAt: 1, createdAt: 1, status: { type: 'notLoaded' },
      preview: 'completed desktop thread', ephemeral: false,
    };
    if (method === 'thread/read') return { thread };
    if (method === 'thread/turns/list') return { data: [{ id: 'last-completed-turn', status: 'completed', items: [] }] };
    if (method === 'config/read') return { config: { model: 'configured-model', model_provider: 'custom' } };
    if (method === 'thread/resume') {
      if (this.resumeError) throw this.resumeError;
      return { thread };
    }
    if (method === 'thread/fork') return { thread: { ...thread, id: this.forkId } };
    if (method === 'turn/start') return { turn: { id: crypto.randomUUID(), status: 'inProgress', items: [] } };
    throw new Error(`Unexpected RPC: ${method}`);
  }
}

async function fixture(t, initialWriter = { blocked: false, owner: 'unknown' }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-writer-test-'));
  const root = path.join(temp, 'project');
  const home = path.join(temp, 'codex-home');
  await fs.mkdir(root); await fs.mkdir(home);
  const bridge = new WriterBridge(root);
  let writer = initialWriter;
  const inspected = [];
  const panel = await createPanel({
    stateDir: path.join(temp, 'panel-private'), codexHome: home, bridge,
    writerInspector: async id => { inspected.push(id); return writer; },
  });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await panel.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${panel.server.address().port}`;
  const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: panel.auth.bootstrap }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = (route, data) => fetch(base + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(data === undefined ? {} : { Origin: base, 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { bridge, inspected, request, setWriter(value) { writer = value; } };
}

function executionCalls(bridge) {
  return bridge.calls.filter(call => ['thread/resume', 'turn/start', 'thread/fork'].includes(call.method));
}

test('writer errors are classified narrowly and expose the 409 recovery contract', () => {
  const conflict = Object.assign(new Error('Thread 00000000-0000-4000-8000-000000000001 already has an active writer'), { rpcCode: -32000 });
  assert.equal(writerConflict(conflict), true);
  assert.equal(writerConflict(new Error('Codex service disconnected')), false);
  assert.equal(writerConflict(new Error('thread could not be resumed')), false);
  const mapped = writerConflictError(conflict);
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, 'THREAD_WRITER_BUSY');
  assert.equal(mapped.recovery, 'close-desktop-or-use-shared-server');
  assert.ok(mapped.message);
});

test('completed history does not imply an external writer has released the thread', async t => {
  const f = await fixture(t, { blocked: true, owner: 'desktop', message: '桌面会话仍持有写锁' });
  const response = await f.request(`/api/threads/${f.bridge.id}`);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.writer.blocked, true);
  assert.equal(value.writer.owner, 'desktop');
  assert.equal(value.activeTurnId, null);
  assert.deepEqual(f.inspected, [f.bridge.id]);
  assert.deepEqual(executionCalls(f.bridge), []);
});

test('known external writer returns 409 without resume, turn creation, or implicit fork', async t => {
  const f = await fixture(t, { blocked: true, owner: 'desktop' });
  const response = await f.request(`/api/threads/${f.bridge.id}/send`, { text: '保留这份手机草稿', clientId: 'writer-test-draft' });
  assert.equal(response.status, 409);
  const value = await response.json();
  assert.equal(value.code, 'THREAD_WRITER_BUSY');
  assert.equal(value.recovery, 'close-desktop-or-use-shared-server');
  assert.deepEqual(executionCalls(f.bridge), []);
  assert.equal(f.bridge.active.size, 0);
});

test('resume race maps active writer to 409 and only an explicit retry starts the draft', async t => {
  const f = await fixture(t);
  f.bridge.resumeError = Object.assign(new Error(`Thread ${f.bridge.id} already has an active writer`), { rpcCode: -32000 });
  const draft = { text: '同一份草稿仅在明确重试后发送', clientId: 'writer-test-explicit-retry' };
  const first = await f.request(`/api/threads/${f.bridge.id}/send`, draft);
  assert.equal(first.status, 409);
  const value = await first.json();
  assert.equal(value.code, 'THREAD_WRITER_BUSY');
  assert.equal(value.recovery, 'close-desktop-or-use-shared-server');
  assert.equal(f.bridge.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.equal(f.bridge.calls.filter(c => c.method === 'thread/fork').length, 0);

  // Merely refreshing metadata/history must never retry a failed message.
  assert.equal((await f.request(`/api/threads/${f.bridge.id}`)).status, 200);
  assert.equal((await f.request(`/api/threads/${f.bridge.id}/history`)).status, 200);
  assert.equal(f.bridge.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.equal(f.bridge.calls.filter(c => c.method === 'thread/resume').length, 1);

  f.bridge.resumeError = null;
  f.setWriter({ blocked: false, owner: 'unknown' });
  const retry = await f.request(`/api/threads/${f.bridge.id}/send`, draft);
  assert.equal(retry.status, 202);
  const started = f.bridge.calls.filter(c => c.method === 'turn/start');
  assert.equal(started.length, 1);
  assert.equal(started[0].params.input[0].text, draft.text);
  assert.equal(started[0].params.clientUserMessageId, draft.clientId);
  assert.equal(f.bridge.calls.filter(c => c.method === 'thread/fork').length, 0);
});

test('unknown owner is represented as unknown, not as desktop execution', async t => {
  const f = await fixture(t);
  const response = await f.request(`/api/threads/${f.bridge.id}`);
  const value = await response.json();
  assert.equal(response.status, 200);
  assert.equal(value.writer.owner, 'unknown');
  assert.equal(value.writer.blocked, false);
  assert.equal(value.activeTurnId, null);
  assert.deepEqual(executionCalls(f.bridge), []);
});

test('unrelated resume failures are not misreported as writer conflicts', async t => {
  const f = await fixture(t);
  f.bridge.resumeError = new Error('Codex service disconnected');
  const response = await f.request(`/api/threads/${f.bridge.id}/send`, { text: 'draft' });
  assert.equal(response.status, 502);
  const value = await response.json();
  assert.notEqual(value.code, 'THREAD_WRITER_BUSY');
  assert.match(value.error, /Codex service disconnected/);
  assert.equal(f.bridge.calls.filter(c => c.method === 'turn/start' || c.method === 'thread/fork').length, 0);
});

test('explicit history fork rejects missing or non-boolean confirmation without touching the thread', async t => {
  const f = await fixture(t, { blocked: true, owner: 'desktop' });
  for (const data of [{}, { confirmFork: false }, { confirmFork: 'true' }]) {
    const response = await f.request(`/api/threads/${f.bridge.id}/fork`, data);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /明确确认/);
  }
  assert.deepEqual(f.bridge.calls, []);
  assert.equal(f.bridge.active.size, 0);
});

test('explicit history fork creates only a new thread and never resumes or sends to its source', async t => {
  const f = await fixture(t, { blocked: true, owner: 'desktop' });
  const originalId = f.bridge.id;
  f.bridge.active.set(originalId, 'source-active-turn');
  f.bridge.resumeError = new Error(`Thread ${originalId} already has an active writer`);
  const response = await f.request(`/api/threads/${originalId}/fork`, { confirmFork: true });
  assert.equal(response.status, 201);
  const value = await response.json();
  assert.equal(value.forkedFrom, originalId);
  assert.equal(value.thread.id, f.bridge.forkId);
  assert.notEqual(value.thread.id, originalId);
  const forks = f.bridge.calls.filter(call => call.method === 'thread/fork');
  assert.equal(forks.length, 1);
  assert.equal(forks[0].params.threadId, originalId);
  assert.equal(forks[0].params.modelProvider, 'custom');
  assert.equal(forks[0].params.model, 'configured-model');
  assert.deepEqual(f.bridge.calls.filter(call => ['thread/resume', 'thread/start', 'turn/start', 'turn/interrupt'].includes(call.method)), []);
  assert.deepEqual([...f.bridge.active], [[originalId, 'source-active-turn']]);
  assert.equal(f.bridge.id, originalId);
});
