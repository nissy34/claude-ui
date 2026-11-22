// Keeps sign-ins fresh: refreshes MCP OAuth logins shortly before their access tokens expire,
// so an idle server never lets the refresh token lapse while nobody is using it.
//
// We never refresh a token ourselves. Claude Code refreshes an MCP login when it connects to the
// server and the access token expires within 5 minutes, and saves the new tokens in its own
// credential store (with its own locking and rotation handling). So for each login due soon we
// reconnect that server in a background Claude process (McpAdmin) and check the store afterwards.
//
// The Claude Code login itself refreshes whenever a chat talks to Claude; here we only report it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { homeConfigPath } from './claude-admin.js';
import { McpAdmin } from './mcp-admin.js';

const WINDOW = 5 * 60_000; // Claude refreshes when the access token expires within this window
const LEAD = 4 * 60_000; // so we wake up this long before expiry, safely inside the window
const SCAN_MS = 5 * 60_000; // re-read the store for new sign-ins
const BACKOFF = [2, 10, 30, 60].map((m) => m * 60_000);
const SOON = 3 * 24 * 3600_000; // warn when a hard login limit is this close

const stateFile = () => path.join(config.dataDir, 'token-keeper.json');
const credFile = () => path.join(config.claudeConfigDir, '.credentials.json');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Claude Code's key for an MCP login: name|sha256({type,url,headers}) (first 16 hex). */
export function mcpKey(name, cfg) {
  const h = crypto
    .createHash('sha256')
    .update(JSON.stringify({ type: cfg.type, url: cfg.url, headers: cfg.headers || {} }))
    .digest('hex')
    .slice(0, 16);
  return `${name}|${h}`;
}

/** Folders whose Claude config defines each MCP server: key -> cwd, and name -> cwd as a fallback. */
export function serverFolders(home = readJson(homeConfigPath()) || {}, root = config.projectsRoot) {
  const byKey = new Map();
  const byName = new Map();
  const add = (servers, cwd) => {
    for (const [name, cfg] of Object.entries(servers || {})) {
      if (!cfg || typeof cfg !== 'object' || !cfg.url) continue;
      const k = mcpKey(name, { type: cfg.type || 'http', ...cfg });
      if (!byKey.has(k)) byKey.set(k, cwd);
      if (!byName.has(name)) byName.set(name, cwd);
    }
  };
  add(home.mcpServers, root);
  for (const [dir, p] of Object.entries(home.projects || {})) {
    if (!fs.existsSync(dir)) continue;
    add(p?.mcpServers, dir);
    add(readJson(path.join(dir, '.mcp.json'))?.mcpServers, dir);
  }
  return { byKey, byName };
}

/** What the store holds, without any secret: one row per login. */
export function describeStore(store, now = Date.now()) {
  const rows = [];
  const c = store?.claudeAiOauth;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    rows.push({ id: 'claude', kind: 'claude', name: 'Claude Code', state: 'long-lived', note: 'Uses a long-lived token (CLAUDE_CODE_OAUTH_TOKEN). Nothing to refresh.' });
  } else if (c) {
    const hasRefresh = !!c.refreshToken;
    const hard = typeof c.refreshTokenExpiresAt === 'number' ? c.refreshTokenExpiresAt : null;
    let state = 'ok';
    let note = 'Refreshes by itself whenever a chat talks to Claude.';
    if (c.loginEnded || !hasRefresh) {
      state = 'signed-out';
      note = c.loginEnded === 'time_limit' ? 'The login reached its time limit. Log in again from a chat menu.' : 'Signed out. Log in again from a chat menu.';
    } else if (hard && hard - now < SOON) {
      state = 'ending';
      note = 'This login has a fixed end date that refreshing cannot move. Log in again before then.';
    }
    rows.push({ id: 'claude', kind: 'claude', name: 'Claude Code', state, expiresAt: c.expiresAt || null, hardLimitAt: hard, hasRefresh, auto: false, note });
  }
  for (const [key, e] of Object.entries(store?.mcpOAuth || {})) {
    if (!e || typeof e !== 'object') continue;
    const name = e.serverName || key.split('|')[0];
    const hasRefresh = !!e.refreshToken;
    const expiresAt = typeof e.expiresAt === 'number' && e.expiresAt > 0 ? e.expiresAt : null;
    let host = '';
    try {
      host = new URL(e.serverUrl).host;
    } catch {}
    let state;
    if (!e.accessToken) state = hasRefresh ? 'expired' : 'signed-out';
    else if (!expiresAt) state = 'no-expiry';
    else if (expiresAt <= now) state = hasRefresh ? 'expired' : 'signed-out';
    else state = hasRefresh ? 'ok' : 'no-refresh';
    rows.push({ id: key, kind: 'mcp', name, host, state, expiresAt, hasRefresh, auto: state === 'ok' || state === 'expired' });
  }
  return rows;
}

class TokenKeeper {
  constructor() {
    const saved = readJson(stateFile()) || {};
    this.enabled = saved.enabled !== false;
    this.results = saved.results || {}; // key -> { at, ok, message, failures }
    this.timer = null;
    this.scanTimer = null;
    this.running = new Set();
  }

  save() {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ enabled: this.enabled, results: this.results }, null, 2));
    } catch {}
  }

  start() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.plan(), SCAN_MS);
    this.scanTimer.unref?.();
    setTimeout(() => this.plan(), 20_000).unref?.();
  }

  stop() {
    clearInterval(this.scanTimer);
    clearTimeout(this.timer);
    this.scanTimer = this.timer = null;
  }

  store() {
    if (!fs.existsSync(credFile())) return null;
    return readJson(credFile());
  }

  /** When each auto-refreshed login is next due (expiry minus lead, or the failure backoff). */
  dueAt(row, now = Date.now()) {
    if (!row.auto) return null;
    const r = this.results[row.id];
    const due = row.expiresAt ? row.expiresAt - LEAD : now;
    if (r && !r.ok && r.failures) return Math.max(due, r.at + BACKOFF[Math.min(r.failures, BACKOFF.length) - 1]);
    return due;
  }

  plan() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    const rows = describeStore(this.store());
    const now = Date.now();
    let next = Infinity;
    for (const row of rows) {
      const d = this.dueAt(row, now);
      if (d == null) continue;
      if (d <= now) this.refresh(row.id).catch(() => {});
      else next = Math.min(next, d);
    }
    if (next !== Infinity) {
      this.timer = setTimeout(() => this.plan(), Math.min(next - now, 2 ** 31 - 1));
      this.timer.unref?.();
    }
  }

  /** Reconnect one MCP server in a background Claude so that Claude refreshes its login. */
  async refresh(key, { manual = false } = {}) {
    if (this.running.has(key)) return this.results[key];
    const before = (this.store()?.mcpOAuth || {})[key];
    if (!before) throw new Error('That sign-in is gone');
    // Claude only refreshes inside its 5-minute window, so an early "Refresh now" has nothing to do.
    if (manual && before.accessToken && (before.expiresAt || 0) - Date.now() > WINDOW) throw new Error(`Still valid until ${new Date(before.expiresAt).toLocaleTimeString()}. It refreshes by itself shortly before then.`);
    const name = before.serverName || key.split('|')[0];
    this.running.add(key);
    const prev = this.results[key] || {};
    let ok = false;
    let message = '';
    try {
      if (!before.refreshToken) throw new Error('There is no refresh token. Sign in again.');
      const { byKey, byName } = serverFolders();
      const cwd = byKey.get(key) || byName.get(name) || config.projectsRoot;
      const a = McpAdmin.for(cwd);
      // A fresh process connects every server at start, which already refreshes logins due soon.
      await a.mcpStatus({ start: true });
      const list = a.mcpServerList();
      if (!list.some((s) => s.name === name)) throw new Error(`"${name}" is not set up in ${cwd} any more`);
      if (!this.refreshed(before, key)) await a.mcpReconnect(name);
      a.touchIdle();
      ok = this.refreshed(before, key);
      if (!ok) {
        const s = list.find((x) => x.name === name);
        message = `Refresh did not go through${s?.error ? `: ${s.error}` : ''}. Sign in again if this keeps failing.`;
      } else message = 'Refreshed';
    } catch (e) {
      message = e.message;
    } finally {
      this.running.delete(key);
    }
    this.results[key] = { at: Date.now(), ok, message, failures: ok ? 0 : (prev.failures || 0) + 1 };
    this.save();
    setTimeout(() => this.plan(), 1000).unref?.();
    return this.results[key];
  }

  /** The stored login moved on from `before` (new access token or later expiry). */
  refreshed(before, key) {
    const now = (this.store()?.mcpOAuth || {})[key];
    if (!now?.accessToken) return false;
    return now.accessToken !== before.accessToken || (now.expiresAt || 0) > (before.expiresAt || 0);
  }

  /** A fresh sign-in starts over: forget earlier failures for that server. */
  signedIn(name) {
    for (const k of Object.keys(this.results)) if (k.split('|')[0] === name) delete this.results[k];
    this.save();
    setTimeout(() => this.plan(), 3000).unref?.();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.save();
    this.plan();
  }

  status() {
    const supported = fs.existsSync(credFile()) || process.platform !== 'darwin';
    const rows = describeStore(this.store()).map((r) => ({
      ...r,
      nextAt: this.enabled ? this.dueAt(r) : null,
      last: this.results[r.id] || null,
      busy: this.running.has(r.id),
    }));
    return {
      enabled: this.enabled,
      supported,
      note: supported ? '' : 'Claude Code keeps its sign-ins in the macOS keychain here, which this server cannot read.',
      rows,
    };
  }
}

export const tokenKeeper = new TokenKeeper();
