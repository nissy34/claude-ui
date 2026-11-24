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

function publicUrl(v) {
  v = (v || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
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

// The token built-in MCP servers and hooks use to call /internal. Kept in a file so CLIs that
// outlive a server restart (in the session runner) still get in afterwards.
function internalToken() {
  const f = path.join(dataDir, 'internal-token');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t.length === 48) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const defaultRoot = fs.existsSync(path.join(home, 'projects')) ? path.join(home, 'projects') : home;

// On macOS the disk ignores letter case, so a root typed as /users/me/projects works but gives
// Claude a different folder key (-users-me-...) than Claude on the same Mac (-Users-me-...).
// The native realpath returns the case as it is on disk.
function trueCase(p) {
  if (process.platform !== 'darwin') return p;
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// Where chats started with "No folder" run. One shared folder, so Past conversations works there.
const scratchDir = expand(env.CW_SCRATCH_DIR || path.join(dataDir, 'scratch'));
fs.mkdirSync(scratchDir, { recursive: true });

export const config = {
  host: env.CW_HOST || '127.0.0.1',
  port: int(env.CW_PORT, 8787),
  password: env.CW_PASSWORD || '',
  passwordHash: env.CW_PASSWORD_HASH || '',
  secret,
  dataDir,
  projectsRoot: trueCase(expand(env.CW_PROJECTS_ROOT || defaultRoot)),
  scratchDir: trueCase(scratchDir),
  allowAnyDir: env.CW_ALLOW_ANY_DIR === '1',
  claudeBin: env.CW_CLAUDE_BIN || 'claude',
  claudeArgs: (env.CW_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean),
  scrollback: int(env.CW_SCROLLBACK_LINES, 5000),
  cookieSecure: env.CW_COOKIE_SECURE, // 'true' | 'false' | undefined (auto)
  sessionDays: int(env.CW_SESSION_DAYS, 30),
  claudeConfigDir: expand(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
  chatIdleMinutes: int(env.CW_CHAT_IDLE_MINUTES, 30),
  // Days to keep files and pictures sent in chats (and tool pictures); 0 keeps them.
  uploadDays: int(env.CW_UPLOAD_DAYS, 30),
  browser: env.CW_BROWSER !== '0',
  browserPath: env.CW_BROWSER_PATH || '',
  childSessions: env.CW_CHILD_SESSIONS !== '0',
  // The CLI's predicted next message after each turn, shown as gray text in the composer.
  promptSuggestions: env.CW_PROMPT_SUGGESTIONS !== '0',
  // Short chat titles from a quick call to a small model after the first reply (like Claude Desktop).
  autoTitles: env.CW_AUTO_TITLES !== '0',
  titleModel: env.CW_TITLE_MODEL || 'haiku',
  schedules: env.CW_SCHEDULES !== '0',
  desktopMcp: env.CW_DESKTOP_MCP !== '0',
  bridgeApi: env.CW_BRIDGE_API !== '0',
  assistant: env.CW_ASSISTANT !== '0',
  // Permission mode for new chats that don't pick one (the Assistant, chats from Teams or other chats).
  defaultMode: env.CW_DEFAULT_MODE || 'auto',
  assistantModel: env.CW_ASSISTANT_MODEL || 'haiku',
  assistantMayApprove: env.CW_ASSISTANT_APPROVE !== '0',
  internalToken: internalToken(),
  // The session runner's socket (server/runner.js). Set: chats and terminals run there and survive
  // server restarts. Unset: they are child processes of the server, as before.
  runnerSocket: env.CW_RUNNER ? expand(env.CW_RUNNER) : '',
  // Chats cut off mid-turn by a restart resume by themselves when the server is back.
  autoResume: env.CW_AUTO_RESUME !== '0',
  internalUrl: '',
  trustProxy: env.CW_TRUST_PROXY === '1',
  // Address other computers use to reach this server (e.g. http://myserver:8787),
  // for the setup snippets in Settings. Needed in Docker, where the machine's
  // hostname is the container id.
  publicUrl: publicUrl(env.CW_PUBLIC_URL),
  inDocker: env.CW_IN_DOCKER === '1' || fs.existsSync('/.dockerenv'),
};

// A projects root whose letter case differs from the home folder's (e.g. /users/me/projects
// with HOME=/Users/me). Inside Docker the disk is case-sensitive, so the folder only exists
// as typed, and Claude in the container files its sessions under a different key than Claude
// on the host. Returns the corrected path to suggest, or ''.
export function rootCaseWarning(root = config.projectsRoot) {
  const h = home.replace(/[\\/]+$/, '');
  if (!h || root === h || root.startsWith(h + path.sep)) return '';
  const lower = root.toLowerCase();
  if (lower === h.toLowerCase() || lower.startsWith(h.toLowerCase() + path.sep)) return h + root.slice(h.length);
  return '';
}

// Env vars that must never leak into the spawned claude / shell processes.
export const PRIVATE_ENV = ['CW_PASSWORD', 'CW_PASSWORD_HASH', 'CW_SECRET', 'CW_MCP_TOKEN'];
