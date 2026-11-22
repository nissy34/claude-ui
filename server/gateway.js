// Company AI gateway mode (for example Bifrost): every claude process this server starts talks
// to an Anthropic-compatible gateway with a personal key instead of a Claude login or Bedrock.
//
// Same three variables the gateway's own setup puts in ~/.claude/settings.json on a machine with
// no browser (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY),
// but kept in the data folder (mode 0600) and passed in the environment of the processes this
// server starts, so the UI can change them and the host's own Claude Code is left alone.
//
// The key is never sent back to the browser, logged, or written anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { config, PRIVATE_ENV } from './config.js';

const FILE = () => path.join(config.dataDir, 'gateway.json');

// Set any of these and Claude Code skips the gateway: it goes to Bedrock / Vertex / Foundry, or
// sends a different credential. Removed from the server's own environment in gateway mode.
export const CONFLICT_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
// Model pins that usually hold a Bedrock model id (the gateway's setup says to remove ANTHROPIC_MODEL).
// Dropped from the server's environment only: a per-environment value set in the UI still wins.
const MODEL_PINS = ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
// In ~/.claude/settings.json "env", Claude Code applies these over the environment we pass, so
// they break gateway mode even though we remove them from the environment.
const SETTINGS_CONFLICTS = [...CONFLICT_ENV, 'AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

export const DEFAULT_URL = 'https://bifrost.ai.synamedia.com/anthropic';

let cached;
function load() {
  if (cached !== undefined) return cached;
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cached = { enabled: !!j.enabled, baseUrl: String(j.baseUrl || ''), token: String(j.token || ''), discovery: j.discovery !== false };
  } catch {
    cached = { enabled: false, baseUrl: '', token: '', discovery: true };
  }
  return cached;
}

function save(c) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  try {
    fs.chmodSync(FILE(), 0o600);
  } catch {}
  cached = c;
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

const listeners = new Set();
export function onGatewayChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True when the UI's gateway setting is on and complete. */
export function gatewayActive() {
  const c = load();
  return !!(c.enabled && c.baseUrl && c.token);
}

/** Gateway set up outside the UI: in the server's environment or ~/.claude/settings.json. */
function externalGateway() {
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) return { source: 'env', baseUrl: process.env.ANTHROPIC_BASE_URL };
  const e = settingsEnv();
  if (e.ANTHROPIC_BASE_URL && e.ANTHROPIC_AUTH_TOKEN) return { source: 'settings', baseUrl: e.ANTHROPIC_BASE_URL };
  return null;
}

/** Any gateway in use (the UI's, or one configured by hand): the Claude login doesn't matter then. */
export function gatewayMode() {
  if (gatewayActive()) return { source: 'ui', baseUrl: load().baseUrl };
  return externalGateway();
}

function settingsFile() {
  return path.join(config.claudeConfigDir, 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return null;
  }
}

function settingsEnv() {
  const s = readSettings();
  return s && s.env && typeof s.env === 'object' ? s.env : {};
}

/** Keys in ~/.claude/settings.json "env" that override what gateway mode passes. */
export function settingsConflicts() {
  const e = settingsEnv();
  const c = load();
  return SETTINGS_CONFLICTS.filter((k) => {
    if (e[k] == null || e[k] === '') return false;
    // Same gateway already written there by hand: not a conflict.
    if (k === 'ANTHROPIC_BASE_URL') return trimUrl(e[k]) !== trimUrl(c.baseUrl);
    if (k === 'ANTHROPIC_AUTH_TOKEN') return e[k] !== c.token;
    return true;
  });
}

/** Remove those keys from ~/.claude/settings.json (a copy of the old file is kept next to it). */
export function fixSettingsConflicts() {
  const s = readSettings();
  const keys = settingsConflicts();
  if (!s || !keys.length) return { removed: [] };
  const f = settingsFile();
  fs.copyFileSync(f, f + '.before-gateway');
  for (const k of keys) delete s.env[k];
  if (!Object.keys(s.env).length) delete s.env;
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
  return { removed: keys, backup: f + '.before-gateway' };
}

function trimUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function hint(token) {
  return token ? `…${token.slice(-4)}` : '';
}

/** What Settings shows. Never includes the key itself. */
export function gatewayStatus() {
  const c = load();
  const ext = externalGateway();
  const envConflicts = CONFLICT_ENV.filter((k) => process.env[k]);
  return {
    enabled: c.enabled,
    active: gatewayActive(),
    baseUrl: c.baseUrl,
    defaultUrl: DEFAULT_URL,
    hasToken: !!c.token,
    tokenHint: hint(c.token),
    discovery: c.discovery,
    mode: gatewayMode(),
    external: ext && !gatewayActive() ? ext : null,
    settingsConflicts: settingsConflicts(),
    envConflicts,
    settingsPath: settingsFile(),
  };
}

/** Update the setting. token: undefined keeps the saved key, '' removes it. */
export function setGateway({ enabled, baseUrl, token, discovery }) {
  const c = { ...load() };
  if (baseUrl !== undefined) {
    const u = trimUrl(baseUrl);
    if (u && !/^https?:\/\/[^\s/]+/i.test(u)) throw new Error('The gateway address must start with https://');
    c.baseUrl = u;
  }
  if (token !== undefined) {
    const t = String(token).trim();
    if (/\s/.test(t)) throw new Error('The key has spaces in it. Paste only the key.');
    c.token = t;
  }
  if (discovery !== undefined) c.discovery = !!discovery;
  if (enabled !== undefined) c.enabled = !!enabled;
  if (c.enabled && (!c.baseUrl || !c.token)) throw new Error('Enter the gateway address and your key first.');
  save(c);
  return gatewayStatus();
}

/**
 * Apply gateway mode to the environment of a claude (or shell) process this server starts.
 * `env` is already the merged environment; `extra` is what the user set for this chat's
 * environment in the UI (kept as is). Also strips the server's private variables.
 */
export function applyGateway(env, extra = {}) {
  for (const k of PRIVATE_ENV) delete env[k];
  if (!gatewayActive()) return env;
  const c = load();
  for (const k of CONFLICT_ENV) delete env[k];
  for (const k of MODEL_PINS) if (!(k in extra)) delete env[k];
  env.ANTHROPIC_BASE_URL = c.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = c.token;
  if (c.discovery) env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  else delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  return env;
}

/** The environment for a claude process: the server's own, plus `extra`, in gateway mode if on. */
export function claudeEnv(extra = {}) {
  return applyGateway({ ...process.env, ...extra }, extra);
}

/**
 * The gateway's model list (GET <base>/v1/models with the key), as { id, displayName }.
 * Throws with a readable message when the gateway can't be reached or refuses the key.
 * `override` tests an address/key typed in Settings before it is saved.
 */
export async function gatewayModels(override = {}) {
  const c = load();
  const baseUrl = trimUrl(override.baseUrl ?? c.baseUrl);
  const token = override.token || c.token;
  if (!baseUrl || !token) throw new Error('Enter the gateway address and your key first.');
  let r;
  try {
    r = await fetch(`${baseUrl}/v1/models?limit=1000`, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const why = e?.cause?.code || e?.name || e?.message || 'error';
    throw new Error(`Could not reach the gateway (${why}). If it is on the company network, check this server can reach it (VPN).`);
  }
  if (r.status === 401 || r.status === 403) throw new Error(`The gateway refused the key (HTTP ${r.status}). Get a new one with "bifrost-auth get-key" on your laptop.`);
  if (!r.ok) throw new Error(`The gateway answered HTTP ${r.status}.`);
  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error('The gateway did not answer with a model list. Check the address (it usually ends in /anthropic).');
  }
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  return list.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, displayName: m.display_name || m.id }));
}
