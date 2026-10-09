// One temporary read-only turn through the existing provider. No persisted test thread.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite } from '../lib/files.mjs';

const run = promisify(execFile);
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const runtime = JSON.parse(await fs.readFile('.local/runtime.json', 'utf8'));
const base = `http://127.0.0.1:${runtime.port}`;
const password = (await fs.readFile('.local/access.txt', 'utf8')).split('\n')[1];
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, label: '自动释放工程验收' }) });
if (!login.ok) throw new Error('本机验收登录失败');
const cookie = login.headers.get('set-cookie').split(';')[0];
const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
async function post(route, data) { const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw new Error(result.error); return result; }
const abort = new AbortController(); const stream = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: abort.signal }); const reader = stream.body.getReader();
let threadId, turn, released, answer = '';
const events = (async () => {
  let buffer = ''; const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }); let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find(line => line.startsWith('data: ')); if (!line) continue;
      const e = JSON.parse(line.slice(6));
      if (e.params?.threadId === threadId && e.method === 'item/completed' && e.params.item?.type === 'agentMessage') answer = e.params.item.text;
      if (e.params?.threadId === threadId && e.method === 'turn/completed') turn = e.params.turn;
      if (e.method === 'panel/writersReleased' && e.params?.threadIds?.includes(threadId)) { released = e.params; return; }
    }
  }
})();
const timer = setTimeout(() => abort.abort(), 180000);
try {
  const p = await post('/api/threads', { cwd: path.dirname(appRoot), sandbox: 'read-only', ephemeral: true }); threadId = p.thread.id;
  await post(`/api/threads/${threadId}/send`, { sandbox: 'read-only', text: '这是私有手机面板的自动释放验收。不要调用工具、不要访问文件、不要创建子代理。只回复：自动释放验收通过' });
  console.log('temporary turn submitted, waiting for completed AND writer release');
  await events;
  if (turn?.status !== 'completed' || released?.reason !== 'automatic') throw new Error(`自动释放未通过：turn=${turn?.status}, reason=${released?.reason}`);
  let held = false;
  try { const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-Fp', '--', path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`)]); held = /^p\d+/m.test(stdout); }
  catch (e) { if (e.code !== 1) throw e; }
  if (held) throw new Error('释放通知后仍检测到写入进程');
  const evidence = { status: 'passed', ephemeral: true, turnStatus: turn.status, reply: answer, releaseReason: released.reason, liveWriterAfterRelease: false, modelProvider: p.thread.modelProvider, at: new Date().toISOString() };
  await atomicWrite('.case/live-auto-release.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { clearTimeout(timer); abort.abort(); await events.catch(() => {}); await post('/api/auth/logout', {}).catch(() => {}); }
