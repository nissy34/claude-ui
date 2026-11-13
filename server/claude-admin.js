// Read-only views of the Claude Code setup on this machine (account, MCP servers, plugins)
// and management of saved permission rules, for the Settings screen.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, PRIVATE_ENV } from './config.js';
import { resolveCommand } from './launch.js';

function runClaude(args, cwd, timeout = 30_000) {
  const env = { ...process.env };
  for (const k of PRIVATE_ENV) delete env[k];
  const cmd = resolveCommand(config.claudeBin, args);
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { cwd: cwd || process.cwd(), env, timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

export async function authStatus() {
  const r = await runClaude(['auth', 'status']);
  try {
    return JSON.parse(r.out);
  } catch {
    return { raw: r.out || r.err };
  }
}

export async function mcpList(cwd) {
  const r = await runClaude(['mcp', 'list'], cwd, 60_000);
  return { text: r.out || r.err };
}

export async function pluginList() {
  const r = await runClaude(['plugin', 'list']);
  return { text: r.out || r.err };
}

export async function cliVersion() {
  const r = await runClaude(['--version']);
  return r.out || r.err;
}

function settingsFiles(cwd) {
  const files = [{ scope: 'user', path: path.join(config.claudeConfigDir, 'settings.json') }];
  if (cwd) {
    files.push({ scope: 'project', path: path.join(cwd, '.claude', 'settings.json') });
    files.push({ scope: 'local', path: path.join(cwd, '.claude', 'settings.local.json') });
  }
  return files;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function permissionRules(cwd) {
  const out = [];
  for (const f of settingsFiles(cwd)) {
    const j = readJson(f.path);
    const perms = j?.permissions || {};
    for (const behavior of ['allow', 'ask', 'deny']) {
      for (const rule of perms[behavior] || []) out.push({ scope: f.scope, file: f.path, behavior, rule });
    }
    if (perms.defaultMode) out.push({ scope: f.scope, file: f.path, behavior: 'defaultMode', rule: perms.defaultMode });
  }
  return out;
}

export function removePermissionRule(cwd, { scope, behavior, rule }) {
  const f = settingsFiles(cwd).find((x) => x.scope === scope);
  if (!f) throw new Error('Unknown settings scope');
  const j = readJson(f.path);
  const list = j?.permissions?.[behavior];
  if (!Array.isArray(list) || !list.includes(rule)) throw new Error('Rule not found');
  j.permissions[behavior] = list.filter((r) => r !== rule);
  fs.writeFileSync(f.path, JSON.stringify(j, null, 2) + '\n');
}
