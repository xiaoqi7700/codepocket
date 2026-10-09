import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, atomicWrite } from '../lib/files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = process.env.PANEL_STATE_DIR || path.join(root, '.local');
const runtimeFile = path.join(local, 'runtime.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function running() {
  const r = await readJson(runtimeFile); if (!r) return null;
  try { const response = await fetch(`http://127.0.0.1:${r.port}/api/control/identity`, { signal: AbortSignal.timeout(2500) }); const data = await response.json(); return data.instanceId === r.instanceId ? r : null; }
  catch { return null; }
}
async function start() {
  let r = await running(); if (r) return r;
  await fs.mkdir(local, { recursive: true, mode: 0o700 });
  const lock = path.join(local, 'start.lock');
  try { await fs.mkdir(lock); } catch (e) { if (e.code !== 'EEXIST') throw e; throw new Error('另一个启动操作正在进行。如果上次启动被强制中断，可删除 .local/start.lock 后重试。'); }
  try {
    const log = await fs.open(path.join(local, 'server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', () => {}); child.unref(); await log.close();
    for (let i = 0; i < 80; i++) { await sleep(250); r = await running(); if (r) return r; }
    throw new Error(`启动未完成，请检查 ${path.join(local, 'server.log')}`);
  } finally { await fs.rmdir(lock).catch(() => {}); }
}
function openURL(url) { const p = spawn('open', [url], { stdio: 'ignore', detached: true }); p.unref(); }
async function stop() {
  const r = await running();
  if (!r) { console.log('面板未运行，无需停止。'); return; }
  process.kill(r.pid, 'SIGTERM'); console.log('已停止 Codex Pocket（不影响 Codex 桌面应用）。');
}
async function ensureIdle() {
  const r = await running(); if (!r) return;
  const base = `http://127.0.0.1:${r.port}`;
  const password = (await fs.readFile(path.join(local, 'access.txt'), 'utf8')).split('\n')[1];
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, label: '本机服务控制' }) });
  const value = await login.json(); if (!login.ok) throw new Error(value.error || '服务状态验证失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  try {
    const s = await fetch(base + '/api/status', { headers: { Cookie: cookie } }).then(r => r.json());
    const a = await fetch(base + '/api/approvals', { headers: { Cookie: cookie } }).then(r => r.json());
    if (!s.active || !Array.isArray(a.data)) throw new Error('服务状态不明，未重启');
    if (Object.keys(s.active).length || a.data.length) throw new Error('面板任务或审批尚未结束，未重启。请先等待完成。');
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' }); }
}
const command = process.argv[2] || 'start';
try {
  if (command === 'start' || command === 'open') {
    const r = await start(); console.log(`面板已运行：http://127.0.0.1:${r.port}/`);
    if (command === 'open') {
      const base = `http://127.0.0.1:${r.port}`;
      const token = (await fs.readFile(path.join(local, 'control-token'), 'utf8')).trim();
      const response = await fetch(base + '/api/control/login-link', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '本机登录链接生成失败');
      openURL(value.url);
    }
  } else if (command === 'restart') { await ensureIdle(); await stop(); await sleep(500); const r = await start(); console.log(`面板已重启：http://127.0.0.1:${r.port}/`); }
  else if (command === 'stop') await stop();
  else if (command === 'status') { const r = await running(); console.log(r ? `运行中：http://127.0.0.1:${r.port}/` : '未运行'); }
  else if (command === 'tailscale') {
    const r = await start();
    let bin = process.env.TAILSCALE_BIN;
    if (!bin) { for (const candidate of ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) { try { await fs.access(candidate); bin = candidate; break; } catch {} } }
    if (!bin) {
      console.log('尚未安装 Tailscale。请安装 macOS 版并登录；手机也登录同一账号，然后再次双击「开启跨网络访问.command」。');
      openURL('https://tailscale.com/download/mac'); process.exitCode = 2;
    } else {
      const status = spawnSync(bin, ['status', '--json'], { encoding: 'utf8' });
      if (status.status !== 0) throw new Error('Tailscale 未连接，请打开应用完成登录。');
      const data = JSON.parse(status.stdout);
      if (data.BackendState !== 'Running' || !data.Self?.DNSName) throw new Error('请先登录 Tailscale，再开启私网 HTTPS。');
      const url = `https://${data.Self.DNSName.replace(/\.$/, '')}`;
      await atomicWrite(path.join(local, 'network.json'), JSON.stringify({ publicOrigin: url }, null, 2));
      const result = spawnSync(bin, ['serve', '--bg', `http://127.0.0.1:${r.port}`], { stdio: 'inherit' });
      if (result.status !== 0) { await fs.unlink(path.join(local, 'network.json')).catch(() => {}); throw new Error('Tailscale Serve 未开启。请按上面的提示启用 HTTPS 后重试。'); }
      console.log(`手机私网地址：${url}\n手机和电脑需在同一个 Tailnet。没有开启公网 Funnel。`);
    }
  } else throw new Error('用法：node scripts/control.mjs start|open|stop|restart|status|tailscale');
} catch (e) { console.error(e.message); process.exitCode = 1; }
