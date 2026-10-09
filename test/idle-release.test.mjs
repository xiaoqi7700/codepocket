import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { CodexBridge } from '../lib/codex.mjs';
import { belongsToPanel } from '../lib/writer.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function harness() {
  const processes = []; let sequence = 0;
  const state = { runtimeStatus: 'idle', goalStatus: null, fastComplete: false, ephemeral: false, goalChecks: 0 };
  const spawnProcess = () => {
    const c = new EventEmitter(); c.pid = 9000 + sequence++; c.exitCode = null; c.signalCode = null; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.signals = [];
    c.send = m => c.stdout.write(JSON.stringify(m) + '\n');
    c.stdin = new Writable({ write(bytes, encoding, done) {
      const m = JSON.parse(bytes.toString()); if (m.id === undefined) { done(); return; }
      let result = {};
      if (m.method === 'thread/start') result = { thread: { id: 'test-thread', ephemeral: false } };
      else if (m.method === 'thread/resume' || m.method === 'thread/fork') result = { thread: { id: 'test-thread', ephemeral: false } };
      else if (m.method === 'thread/read') result = { thread: { id: 'test-thread', ephemeral: state.ephemeral, status: { type: state.runtimeStatus } } };
      else if (m.method === 'thread/goal/get') { state.goalChecks++; result = { goal: state.goalStatus ? { status: state.goalStatus } : null }; }
      else if (m.method === 'turn/start') {
        result = { turn: { id: 'test-turn', status: 'inProgress' } };
        if (state.fastComplete) c.send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'test-turn', status: 'completed', items: [] } } });
      }
      c.send({ id: m.id, result }); done();
    } });
    c.kill = signal => { c.signals.push(signal); setImmediate(() => { c.signalCode = signal; c.emit('exit', null, signal); c.stdout.end(); }); return true; };
    processes.push(c); return c;
  };
  const bridge = new CodexBridge({ spawnProcess, idleReleaseMs: 20 });
  return { bridge, processes, state };
}
test('npm native grandchild is recognized as the panel, unrelated writer is not', async () => {
  const parents = new Map([[30, 20], [20, 10], [99, 1]]);
  assert.equal(await belongsToPanel(30, 20, async n => parents.get(n)), true);
  assert.equal(await belongsToPanel(99, 20, async n => parents.get(n)), false);
  assert.equal(await belongsToPanel(20, undefined, async n => parents.get(n)), false);
});
test('completed task releases the idle child; next read starts a fresh reader', async t => {
  const { bridge, processes } = harness(); t.after(() => bridge.stop());
  const events = []; bridge.on('event', e => events.push(e));
  await bridge.rpc('thread/resume', { threadId: 'test-thread' });
  await bridge.rpc('turn/start', { threadId: 'test-thread' });
  await sleep(45); assert.equal(processes[0].signals.length, 0);
  processes[0].send({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed', items: [] } } });
  await sleep(55); assert.deepEqual(processes[0].signals, ['SIGTERM']); assert.equal(bridge.child, null);
  assert.ok(events.some(e => e.method === 'panel/writersReleased'));
  await bridge.rpc('thread/read', { threadId: 'test-thread' }); assert.equal(processes.length, 2);
});
test('execution lease prevents release in the gap between resume and send', async t => {
  const { bridge, processes } = harness(); t.after(() => bridge.stop());
  const release = bridge.hold(); await bridge.rpc('thread/resume', { threadId: 'test-thread' });
  await sleep(45); assert.equal(processes[0].signals.length, 0);
  await assert.rejects(bridge.releaseIdle(), e => e.code === 'PANEL_NOT_IDLE');
  await bridge.rpc('turn/start', { threadId: 'test-thread' }); release();
  await sleep(45); assert.equal(processes[0].signals.length, 0);
});
test('blank new thread and pending approval are not auto-discarded', async t => {
  const { bridge, processes } = harness(); t.after(() => bridge.stop());
  await bridge.rpc('thread/start', {}); await sleep(45); assert.equal(processes[0].signals.length, 0);
  await assert.rejects(bridge.releaseIdle(), e => e.code === 'PANEL_NOT_IDLE');
  bridge.unsaved.clear(); bridge.approvals.set('a', { rpcId: 42 });
  await assert.rejects(bridge.releaseIdle(), e => e.code === 'PANEL_NOT_IDLE'); assert.equal(processes[0].signals.length, 0);
});
test('runtime active status and continuing goal prevent manual release', async t => {
  const { bridge, processes, state } = harness(); t.after(() => bridge.stop());
  const release = bridge.hold(); await bridge.rpc('thread/resume', { threadId: 'test-thread' }); release(); clearTimeout(bridge.idleTimer);
  state.runtimeStatus = 'active'; await assert.rejects(bridge.releaseIdle(), e => e.code === 'PANEL_NOT_IDLE');
  state.runtimeStatus = 'idle'; state.goalStatus = 'active'; await assert.rejects(bridge.releaseIdle(), e => e.code === 'PANEL_NOT_IDLE');
  assert.equal(processes[0].signals.length, 0);
});
test('completion before turn/start response never recreates an active task', async t => {
  const { bridge, state, processes } = harness(); t.after(() => bridge.stop()); state.fastComplete = true;
  const release = bridge.hold(); await bridge.rpc('thread/resume', { threadId: 'test-thread' });
  await bridge.rpc('turn/start', { threadId: 'test-thread' }); assert.equal(bridge.active.size, 0); release();
  await sleep(55); assert.deepEqual(processes[0].signals, ['SIGTERM']);
});
test('temporary threads release without calling unsupported goal methods', async t => {
  const { bridge, state, processes } = harness(); t.after(() => bridge.stop());
  state.ephemeral = true; state.fastComplete = true;
  const release = bridge.hold(); await bridge.rpc('thread/start', { ephemeral: true });
  await bridge.rpc('turn/start', { threadId: 'test-thread' }); release();
  await sleep(55); assert.deepEqual(processes[0].signals, ['SIGTERM']); assert.equal(state.goalChecks, 0);
});
