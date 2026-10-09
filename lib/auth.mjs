import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWrite, readJson } from './files.mjs';

const scrypt = promisify(crypto.scrypt);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const token = () => crypto.randomBytes(32).toString('base64url');
export function isLoopback(ip) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip); }
export function isPrivateIp(raw = '') {
  const ip = raw.replace(/^::ffff:/, '');
  if (isLoopback(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || parts[0] === 169 && parts[1] === 254;
  }
  return /^(fc|fd|fe80:)/i.test(ip);
}
export function localAdminRequest(req) {
  const host = (req.headers.host || '').split(':')[0];
  return isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1'].includes(host) && !req.headers['x-forwarded-for'] && !req.headers['forwarded'];
}

export class AuthStore {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'auth.json'); this.failures = new Map(); this.writeQueue = Promise.resolve(); }
  async init() {
    this.state = await readJson(this.file);
    if (!this.state) {
      const password = crypto.randomBytes(18).toString('base64url');
      const salt = crypto.randomBytes(16).toString('hex');
      const derived = await scrypt(password, salt, 64);
      this.state = { version: 1, salt, passwordHash: derived.toString('hex'), devices: [] };
      await this.persist();
      await atomicWrite(path.join(this.dir, 'access.txt'), `手机面板登录密码（不是中转 API Key）：\n${password}\n\n首次手机登录后，需要在电脑面板的“设备管理”里批准。\n`);
    }
    const controlFile = path.join(this.dir, 'control-token');
    try { this.controlKey = (await fs.readFile(controlFile, 'utf8')).trim(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.controlKey = token(); await atomicWrite(controlFile, this.controlKey); }
    this.bootstrap = token(); this.bootstrapExpires = Date.now() + 10 * 60_000;
  }
  persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => atomicWrite(this.file, snapshot));
    return this.writeQueue;
  }
  getDevice(req) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)mcpanel=([A-Za-z0-9_-]{43})(?:;|$)/);
    if (!match) return null;
    const key = hash(match[1]);
    const d = this.state.devices.find(x => equal(x.tokenHash, key));
    return d && d.status !== 'revoked' && d.expiresAt > Date.now() ? d : null;
  }
  publicDevice(d) {
    return d ? { id: d.id, label: d.label, role: d.role, status: d.status, createdAt: d.createdAt, expiresAt: d.expiresAt, ip: d.ip, agent: d.agent } : null;
  }
  async createDevice(req, label, owner = false) {
    this.state.devices = this.state.devices.filter(d => d.expiresAt > Date.now() && d.status !== 'revoked');
    if (this.state.devices.length >= 30) throw Object.assign(new Error('设备数量已达上限，请在电脑端清理设备'), { status: 429 });
    const secret = token();
    const d = { id: crypto.randomUUID(), label: String(label || '我的设备').slice(0, 80), tokenHash: hash(secret), role: owner ? 'owner' : 'phone', status: owner ? 'approved' : 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000, ip: (req.headers['x-forwarded-for'] && isLoopback(req.socket.remoteAddress) ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress), agent: String(req.headers['user-agent'] || '').slice(0, 220) };
    this.state.devices.push(d); await this.persist();
    return { device: this.publicDevice(d), secret };
  }
  async login(req, password, label) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let rate = this.failures.get(ip);
    if (!rate || rate.until <= now) { rate = { count: 0, until: now + 15 * 60_000 }; this.failures.set(ip, rate); }
    if (rate.count >= 5) throw Object.assign(new Error('尝试次数过多，请 15 分钟后重试'), { status: 429 });
    rate.count++;
    if (typeof password !== 'string' || password.length > 256) throw Object.assign(new Error('密码不正确'), { status: 401 });
    const derived = await scrypt(password, this.state.salt, 64);
    if (!equal(derived.toString('hex'), this.state.passwordHash)) throw Object.assign(new Error('密码不正确'), { status: 401 });
    return this.createDevice(req, label, localAdminRequest(req));
  }
  async bootstrapLogin(req, value) {
    if (!localAdminRequest(req) || Date.now() > this.bootstrapExpires || !equal(value, this.bootstrap)) throw Object.assign(new Error('电脑端登录链接已失效，请用本地密码登录'), { status: 403 });
    this.bootstrap = ''; this.bootstrapExpires = 0;
    return this.createDevice(req, '这台 Mac', true);
  }
  newLoginLink(req, value) {
    if (!localAdminRequest(req) || !equal(value, this.controlKey)) throw Object.assign(new Error('电脑控制凭据不正确'), { status: 403 });
    this.bootstrap = token(); this.bootstrapExpires = Date.now() + 10 * 60_000;
    return this.bootstrap;
  }
  async setStatus(id, status) {
    const d = this.state.devices.find(d => d.id === id);
    if (!d || d.role === 'owner') throw Object.assign(new Error('设备不存在或不是手机设备'), { status: 404 });
    if (!['approved', 'revoked'].includes(status)) throw Object.assign(new Error('无效设备状态'), { status: 400 });
    d.status = status; await this.persist(); return this.publicDevice(d);
  }
  async logout(req) { const d = this.getDevice(req); if (d) { d.status = 'revoked'; await this.persist(); } }
}

export function sessionCookie(secret, req) {
  const secure = !!req.panelSecure || !!req.socket.encrypted || isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
  return `mcpanel=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`;
}
