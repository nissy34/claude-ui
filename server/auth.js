import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'cw_auth';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || !pw) return false;
  if (config.passwordHash) {
    const [scheme, saltHex, hashHex] = config.passwordHash.split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(expected, got);
  }
  if (config.password) {
    const a = crypto.createHash('sha256').update(pw).digest();
    const b = crypto.createHash('sha256').update(config.password).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

function sign(payload) {
  return crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
}

export function makeToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + config.sessionDays * 86400_000, n: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function isSecure(req) {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function setAuthCookie(req, res) {
  const parts = [
    `${COOKIE}=${makeToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${config.sessionDays * 86400}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Simple in-memory login rate limiter: 10 failed attempts per IP per 15 minutes.
const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start > 15 * 60_000) return true;
  return rec.count < 10;
}
export function loginFailed(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start > 15 * 60_000) attempts.set(ip, { start: now, count: 1 });
  else rec.count++;
}
export function loginSucceeded(ip) {
  attempts.delete(ip);
}
