import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function belongsToPanel(pid, panelPid, parentOf = async id => {
  const { stdout } = await run('/bin/ps', ['-p', String(id), '-o', 'ppid='], { timeout: 1000, maxBuffer: 128 });
  return Number(stdout.trim());
}) {
  if (!panelPid) return false;
  let current = pid;
  for (let i = 0; i < 8 && current > 1; i++) {
    if (current === panelPid) return true;
    try { const parent = await parentOf(current); if (!parent || parent === current) return false; current = parent; }
    catch { return false; }
  }
  return false;
}

// Advisory, read-only ownership check. The existence of a .lock file is NOT a lock.
// Never remove, rename, truncate, or try to take over a live writer's lock.
export function createWriterInspector({ codexHome, bridge }) {
  return async function inspectWriter(threadId) {
    const file = path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
    try { await fs.access(file); }
    catch (e) { return { blocked: false, owner: e.code === 'ENOENT' ? 'none' : 'unknown', verified: e.code === 'ENOENT' }; }
    let stdout;
    try { ({ stdout } = await run('/usr/sbin/lsof', ['-nP', '-Fpc', '--', file], { timeout: 2500, maxBuffer: 16384 })); }
    catch (e) {
      if (e.code === 1 && !e.stdout) return { blocked: false, owner: 'none', verified: true };
      return { blocked: false, owner: 'unknown', verified: false };
    }
    const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
    const external = [];
    // npm codex is a JS launcher; the native grandchild actually owns the lock.
    for (const pid of pids) if (!await belongsToPanel(pid, bridge.child?.pid)) external.push(pid);
    if (!external.length) return { blocked: false, owner: pids.length ? 'panel' : 'none', verified: true };
    let owner = 'unknown';
    // Inspect only processes reported for this exact thread, never enumerate the machine.
    for (const pid of external.slice(0, 3)) {
      try {
        const { stdout: command } = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 1000, maxBuffer: 8192 });
        if (command.includes('/ChatGPT.app/') || command.includes('/Codex.app/')) owner = 'desktop';
      } catch { /* ownership can change between checks */ }
    }
    return { blocked: true, owner, verified: true, message: owner === 'desktop' ? '桌面 Codex 仍持有此会话的写入权，停止生成不一定释放占用。' : '另一个本地进程仍占用此会话。' };
  };
}
