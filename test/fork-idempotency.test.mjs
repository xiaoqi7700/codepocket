import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPanel } from '../server.mjs';

// Isolated fake RPC server: never accesses Codex processes, user threads, or writer locks.
class DelayedForkBridge extends EventEmitter {
  constructor(root) {
    super();
    this.root = root; this.id = crypto.randomUUID(); this.ready = false;
    this.active = new Map(); this.approvals = new Map(); this.calls = [];
    this.holdFork = false;
    this.forkStarted = new Promise(resolve => { this.markForkStarted = resolve; });
    this.forkGate = new Promise(resolve => { this.releaseFork = resolve; });
  }
  async start() { this.ready = true; }
  async stop() { this.ready = false; this.releaseFork(); }
  async rpc(method, params) {
    this.calls.push({ method, params });
    const thread = {
      id: params.threadId || this.id, cwd: this.root, name: 'fork idempotency fixture',
      model: 'test-model', modelProvider: 'custom', updatedAt: 1, createdAt: 1,
      status: { type: 'notLoaded' }, preview: 'saved test history', ephemeral: false,
    };
    if (method === 'thread/read') return { thread };
    if (method === 'config/read') return { config: { model: 'test-model', model_provider: 'custom' } };
    if (method === 'thread/fork') {
      const id = crypto.randomUUID();
      this.markForkStarted();
      if (this.holdFork) await this.forkGate;
      return { thread: { ...thread, id } };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  }
  get forks() { return this.calls.filter(call => call.method === 'thread/fork'); }
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fork-idempotency-'));
  const root = path.join(temp, 'project'), home = path.join(temp, 'codex-home');
  await fs.mkdir(root); await fs.mkdir(home);
  const bridge = new DelayedForkBridge(root);
  const panel = await createPanel({
    stateDir: path.join(temp, 'panel-private'), codexHome: home, bridge,
    writerInspector: async () => ({ blocked: true, owner: 'desktop' }),
  });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { bridge.releaseFork(); await panel.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${panel.server.address().port}`;
  const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: panel.auth.bootstrap }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = (data, id = bridge.id) => fetch(`${base}/api/threads/${id}/fork`, {
    method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { bridge, request };
}

test('parallel and repeated same-source same-client forks share exactly one RPC and thread', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.bridge.holdFork = true;
  const body = { confirmFork: true, clientId: 'same-source-request-001', sandbox: 'workspace-write' };
  const first = f.request(body);
  await f.bridge.forkStarted;
  const second = f.request(body);
  await delay(30);
  f.bridge.releaseFork();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  const [a, b] = await Promise.all(responses.map(r => r.json()));
  assert.equal(a.thread.id, b.thread.id);
  assert.notEqual(a.thread.id, f.bridge.id);
  assert.equal(a.forkedFrom, f.bridge.id);
  const repeated = await f.request(body);
  assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).thread.id, a.thread.id);
  assert.equal(f.bridge.forks.length, 1);
  assert.equal(f.bridge.forks[0].params.threadId, f.bridge.id);
});

test('same source and client key with a different sandbox returns 409 without another fork', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.bridge.holdFork = true;
  const key = 'sandbox-conflict-001';
  const first = f.request({ confirmFork: true, clientId: key, sandbox: 'workspace-write' });
  await f.bridge.forkStarted;
  const conflicting = f.request({ confirmFork: true, clientId: key, sandbox: 'read-only' });
  await delay(30);
  f.bridge.releaseFork();
  assert.equal((await first).status, 201);
  assert.equal((await conflicting).status, 409);
  const repeatedConflict = await f.request({ confirmFork: true, clientId: key, sandbox: 'danger-full-access' });
  assert.equal(repeatedConflict.status, 409);
  assert.equal(f.bridge.forks.length, 1);
});

test('explicit fork without a client key remains compatible and creates independent copies', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = await f.request({ confirmFork: true });
  const second = await f.request({ confirmFork: true });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const a = await first.json(), b = await second.json();
  assert.notEqual(a.thread.id, b.thread.id);
  assert.equal(f.bridge.forks.length, 2);
});

test('fork idempotency key accepts 8 and 100 characters and valid underscore/hyphen characters', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const clientId of ['a_B-1234', 'x'.repeat(100)]) {
    const response = await f.request({ confirmFork: true, clientId });
    assert.equal(response.status, 201, `valid clientId length ${clientId.length}`);
  }
  assert.equal(f.bridge.forks.length, 2);
});

test('fork idempotency key rejects invalid length, characters, and non-string values before RPC', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const clientId of ['', 'short', 'x'.repeat(101), 'bad key00', 'bad.key00', null, 123]) {
    const response = await f.request({ confirmFork: true, clientId });
    assert.equal(response.status, 400, `invalid clientId ${JSON.stringify(clientId)}`);
  }
  assert.equal(f.bridge.forks.length, 0);
  assert.equal(f.bridge.calls.length, 0);
});

test('the same client key on different sources creates separate forks', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const body = { confirmFork: true, clientId: 'shared-key-different-source' };
  const a = await f.request(body), b = await f.request(body, crypto.randomUUID());
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.notEqual((await a.json()).thread.id, (await b.json()).thread.id);
  assert.equal(f.bridge.forks.length, 2);
});
