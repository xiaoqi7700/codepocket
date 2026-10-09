// Explicit engineering smoke test. Uses the current local provider, never contacts a relay directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../lib/files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = path.join(root, '.local');
const runtime = JSON.parse(await fs.readFile(path.join(local, 'runtime.json'), 'utf8'));
const base = `http://127.0.0.1:${runtime.port}`;
const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const digest = async () => crypto.createHash('sha256').update(await fs.readFile(config)).digest('hex');
const before = await digest();
const password = (await fs.readFile(path.join(local, 'access.txt'), 'utf8')).split('\n')[1];
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, label: '工程验证（本机）' }) });
if (!login.ok) throw new Error('smoke login failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
async function post(route, data) { const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(data) }); const v = await r.json(); if (!r.ok) throw new Error(`${route}: ${v.error}`); return v; }
const abort = new AbortController(); let threadId, completed, answer = '', deltas = 0;
const stream = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: abort.signal });
const reader = stream.body.getReader();
const waiter = (async () => {
  const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      const line = block.split('\n').find(s => s.startsWith('data: ')); if (!line) continue;
      const event = JSON.parse(line.slice(6)); if (event.params?.threadId !== threadId) continue;
      if (event.method === 'item/agentMessage/delta') { deltas++; answer += event.params.delta; }
      if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') answer = event.params.item.text;
      if (event.method === 'turn/completed') { completed = event.params.turn; return; }
    }
  }
})();
const timeout = setTimeout(() => abort.abort(), 150000);
try {
  const started = await post('/api/threads', { cwd: path.dirname(root), sandbox: 'read-only', ephemeral: true });
  threadId = started.thread.id;
  console.log('temporary thread: created; provider:', started.thread.modelProvider, 'model:', started.thread.model);
  await post(`/api/threads/${threadId}/send`, { text: '这是手机私有网页面板的一次连接验收。不要调用任何工具，不要读写文件，不要创建子代理。请只回复：手机面板连接成功', sandbox: 'read-only', clientId: crypto.randomUUID() });
  console.log('turn submitted; waiting for actual streamed reply');
  await waiter;
  if (completed?.status !== 'completed') throw new Error(completed?.error?.message || `turn status: ${completed?.status || 'timeout'}`);
  if (!answer.includes('手机面板连接成功')) throw new Error('unexpected reply');
  const after = await digest(); if (after !== before) throw new Error('existing provider config changed');
  const result = { status: 'passed', provider: started.thread.modelProvider, model: started.thread.model, streamedDeltas: deltas, reply: answer, configurationUnchanged: true, ephemeral: true, at: new Date().toISOString() };
  await atomicWrite(path.join(root, '.case', 'real-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { clearTimeout(timeout); abort.abort(); await waiter.catch(() => {}); await post('/api/auth/logout', {}).catch(() => {}); }
