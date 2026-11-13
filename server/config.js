import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const env = process.env;
const home = os.homedir();

function expand(p) {
  if (!p) return p;
  return path.resolve(p.replace(/^~(?=$|[\\/])/, home));
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

const dataDir = expand(env.CW_DATA_DIR || path.join(home, '.claude-web'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// Cookie signing secret: from env, or generated once and persisted.
let secret = env.CW_SECRET;
if (!secret) {
  const f = path.join(dataDir, 'secret');
  try {
    secret = fs.readFileSync(f, 'utf8').trim();
  } catch {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, secret, { mode: 0o600 });
  }
}

const defaultRoot = fs.existsSync(path.join(home, 'projects')) ? path.join(home, 'projects') : home;

export const config = {
  host: env.CW_HOST || '127.0.0.1',
  port: int(env.CW_PORT, 8787),
  password: env.CW_PASSWORD || '',
  passwordHash: env.CW_PASSWORD_HASH || '',
  secret,
  dataDir,
  projectsRoot: expand(env.CW_PROJECTS_ROOT || defaultRoot),
  allowAnyDir: env.CW_ALLOW_ANY_DIR === '1',
  claudeBin: env.CW_CLAUDE_BIN || 'claude',
  claudeArgs: (env.CW_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean),
  scrollback: int(env.CW_SCROLLBACK_LINES, 5000),
  cookieSecure: env.CW_COOKIE_SECURE, // 'true' | 'false' | undefined (auto)
  sessionDays: int(env.CW_SESSION_DAYS, 30),
  claudeConfigDir: expand(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
  chatIdleMinutes: int(env.CW_CHAT_IDLE_MINUTES, 30),
  trustProxy: env.CW_TRUST_PROXY === '1',
};

// Env vars that must never leak into the spawned claude / shell processes.
export const PRIVATE_ENV = ['CW_PASSWORD', 'CW_PASSWORD_HASH', 'CW_SECRET'];
