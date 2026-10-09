import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function atomicWrite(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, value, { mode, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, mode);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export function contains(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
