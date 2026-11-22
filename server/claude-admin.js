// Read-only views of the Claude Code setup on this machine (account, MCP servers, plugins)
// and management of saved permission rules, for the Settings screen.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { claudeEnv } from './gateway.js';
import { resolveCommand } from './launch.js';

function runClaude(args, cwd, timeout = 30_000, input) {
  const env = claudeEnv();
  const cmd = resolveCommand(config.claudeBin, args);
  return new Promise((resolve) => {
    const child = execFile(cmd.file, cmd.args, { cwd: cwd || process.cwd(), env, timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
    if (input != null) child.stdin?.end(input);
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

// ---------- MCP servers (structured) ----------
export const homeConfigPath = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(config.claudeConfigDir, '.claude.json') : path.join(path.dirname(config.claudeConfigDir), '.claude.json'));

function statusMap(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([^:\s][^:]*):\s.*\s-\s(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export async function mcpServers(cwd, { status = true } = {}) {
  const home = readJson(homeConfigPath()) || {};
  const proj = (cwd && home.projects?.[cwd]) || {};
  const disabled = new Set(proj.disabledMcpServers || []);
  const list = [];
  const add = (scope, servers) => {
    for (const [name, cfg] of Object.entries(servers || {})) list.push({ name, scope, config: cfg, enabled: !disabled.has(name) });
  };
  add('user', home.mcpServers);
  add('local', proj.mcpServers);
  if (cwd) add('project', readJson(path.join(cwd, '.mcp.json'))?.mcpServers);
  if (!status) return { servers: list };
  const r = await runClaude(['mcp', 'list'], cwd, 60_000);
  const st = statusMap(r.out);
  for (const s of list) s.status = s.enabled ? st[s.name] || 'unknown' : 'disabled';
  return { servers: list, raw: r.out || r.err };
}

function checkName(name) {
  if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) throw new Error('Name can use letters, numbers, dots, dashes and underscores');
  return name;
}
const SCOPES = ['user', 'local', 'project'];
const scopeOf = (s) => (SCOPES.includes(s) ? s : 'user');

async function mustRun(args, cwd, timeout, input) {
  const r = await runClaude(args, cwd, timeout, input);
  if (!r.ok) throw new Error(r.err || r.out || 'Command failed');
  return r.out;
}

export async function mcpAdd(cwd, { name, scope, server }) {
  checkName(name);
  if (!server || typeof server !== 'object') throw new Error('Server config is required');
  return { out: await mustRun(['mcp', 'add-json', name, JSON.stringify(server), '-s', scopeOf(scope)], cwd) };
}

// Edit = remove + add-json (the CLI has no update). If the new config is refused, put the old one back.
export async function mcpUpdate(cwd, { name, scope, server }) {
  checkName(name);
  if (!server || typeof server !== 'object') throw new Error('Server config is required');
  const s = scopeOf(scope);
  const { servers } = await mcpServers(cwd, { status: false });
  const old = servers.find((x) => x.name === name && x.scope === s);
  if (!old) throw new Error(`No ${s} MCP server named "${name}"`);
  await mustRun(['mcp', 'remove', name, '-s', s], cwd);
  const r = await runClaude(['mcp', 'add-json', name, JSON.stringify(server), '-s', s], cwd);
  if (!r.ok) {
    await runClaude(['mcp', 'add-json', name, JSON.stringify(old.config), '-s', s], cwd);
    throw new Error(r.err || r.out || 'Could not save the server');
  }
  return { out: r.out };
}

export async function mcpRemove(cwd, { name, scope }) {
  checkName(name);
  return { out: await mustRun(['mcp', 'remove', name, '-s', scopeOf(scope)], cwd) };
}

// Same switch as /mcp's enable/disable: the project's disabledMcpServers in ~/.claude.json.
export function mcpToggle(cwd, { name, enabled }) {
  checkName(name);
  if (!cwd) throw new Error('Pick a project first');
  const file = homeConfigPath();
  const j = readJson(file) || {};
  j.projects ||= {};
  const p = (j.projects[cwd] ||= {});
  const set = new Set(p.disabledMcpServers || []);
  enabled ? set.delete(name) : set.add(name);
  p.disabledMcpServers = [...set];
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  return { ok: true };
}

// ---------- plugins ----------
function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function plugins() {
  const [a, m] = await Promise.all([runClaude(['plugin', 'list', '--available', '--json'], null, 60_000), runClaude(['plugin', 'marketplace', 'list', '--json'], null, 30_000)]);
  const data = parseJson(a.out, null);
  const installed = data?.installed || (Array.isArray(data) ? data : []);
  // Flag plugins whose options (usernames, passwords, …) are not all set yet.
  await Promise.all(
    installed
      .filter((p) => p.hasUserConfig && PLUGIN_ID.test(p.id || p.pluginId || ''))
      .map(async (p) => {
        const c = await pluginConfigGet({ id: p.id || p.pluginId }).catch(() => null);
        if (c) p.unconfigured = (c.unconfigured || []).filter((k) => c.schema?.[k]?.default == null); // unset and no default
      })
  );
  return {
    installed,
    available: data?.available || [],
    marketplaces: parseJson(m.out, []),
    error: data ? undefined : a.err || a.out,
  };
}

const PLUGIN_ID = /^[\w.@/:-]{1,200}$/;
export async function pluginAction({ action, id, scope }) {
  if (!PLUGIN_ID.test(id || '')) throw new Error('Bad plugin id');
  const s = ['-s', scopeOf(scope)];
  const args = {
    install: ['plugin', 'install', id, ...s],
    uninstall: ['plugin', 'uninstall', id, ...s, '-y'],
    enable: ['plugin', 'enable', id, ...s],
    disable: ['plugin', 'disable', id, ...s],
    update: ['plugin', 'update', id],
  }[action];
  if (!args) throw new Error('Unknown action');
  return { out: await mustRun(args, null, 180_000) };
}

// Plugin options declared in the plugin's manifest (userConfig), used as ${user_config.KEY} in its MCP servers.
// Sensitive values live in Claude Code's secure storage and are never read back: inputs come back empty for them.
export async function pluginConfigGet({ id }) {
  if (!PLUGIN_ID.test(id || '')) throw new Error('Bad plugin id');
  const r = await runClaude(['plugin', 'configure', id, '--json'], null, 60_000);
  const j = parseJson(r.out, null);
  if (!j) throw new Error(r.err || r.out || 'Could not read the plugin options');
  return j;
}

export async function pluginConfigSet({ id, values }) {
  if (!PLUGIN_ID.test(id || '')) throw new Error('Bad plugin id');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Values are required');
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z_]\w*$/.test(k)) throw new Error(`Bad option name: ${k}`);
    const str = String(v ?? '');
    if (/[\r\n]/.test(str)) throw new Error(`${k} must be a single line`);
    clean[k] = str;
  }
  if (!Object.keys(clean).length) return { out: 'No changes' };
  return { out: await mustRun(['plugin', 'configure', id, '--values-stdin'], null, 60_000, JSON.stringify(clean)) };
}

export async function marketplaceAction({ action, source, name }) {
  if (action === 'add') {
    if (typeof source !== 'string' || !source.trim() || source.startsWith('-')) throw new Error('Give a GitHub repo (owner/repo), URL or path');
    return { out: await mustRun(['plugin', 'marketplace', 'add', source.trim()], null, 180_000) };
  }
  if (action === 'remove') return { out: await mustRun(['plugin', 'marketplace', 'remove', checkName(name)], null) };
  if (action === 'update') return { out: await mustRun(['plugin', 'marketplace', 'update', ...(name ? [checkName(name)] : [])], null, 180_000) };
  throw new Error('Unknown action');
}

// ---------- skills ----------
// A skill is a folder with SKILL.md. Disabling renames SKILL.md to SKILL.md.disabled.
function skillRoots(cwd) {
  const roots = [{ scope: 'user', dir: path.join(config.claudeConfigDir, 'skills') }];
  if (cwd) roots.push({ scope: 'project', dir: path.join(cwd, '.claude', 'skills') });
  return roots;
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function skills(cwd) {
  const list = [];
  for (const { scope, dir } of skillRoots(cwd)) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    for (const n of names) {
      const on = path.join(dir, n, 'SKILL.md');
      const off = on + '.disabled';
      const file = fs.existsSync(on) ? on : fs.existsSync(off) ? off : null;
      if (!file) continue;
      const fm = frontmatter(fs.readFileSync(file, 'utf8').slice(0, 4000));
      list.push({ id: n, scope, name: fm.name || n, description: fm.description || '', enabled: file === on, path: path.join(dir, n) });
    }
  }
  return list;
}

function skillDir(cwd, scope, id) {
  checkName(id);
  const root = skillRoots(cwd).find((r) => r.scope === scope);
  if (!root) throw new Error('Pick a project for project skills');
  return { root: root.dir, dir: path.join(root.dir, id) };
}

export function skillGet(cwd, { scope, id }) {
  const { dir } = skillDir(cwd, scope, id);
  const f = fs.existsSync(path.join(dir, 'SKILL.md')) ? path.join(dir, 'SKILL.md') : path.join(dir, 'SKILL.md.disabled');
  return { content: fs.readFileSync(f, 'utf8') };
}

export function skillSave(cwd, { scope, id, content, create }) {
  const { dir } = skillDir(cwd, scope, id);
  if (typeof content !== 'string' || content.length > 200_000) throw new Error('Bad content');
  if (create && fs.existsSync(dir)) throw new Error('A skill with that name already exists');
  fs.mkdirSync(dir, { recursive: true });
  const off = path.join(dir, 'SKILL.md.disabled');
  fs.writeFileSync(fs.existsSync(off) ? off : path.join(dir, 'SKILL.md'), content);
  return { ok: true };
}

export function skillToggle(cwd, { scope, id, enabled }) {
  const { dir } = skillDir(cwd, scope, id);
  const on = path.join(dir, 'SKILL.md');
  const off = on + '.disabled';
  if (enabled && fs.existsSync(off)) fs.renameSync(off, on);
  if (!enabled && fs.existsSync(on)) fs.renameSync(on, off);
  return { ok: true };
}

export function skillDelete(cwd, { scope, id }) {
  const { root, dir } = skillDir(cwd, scope, id);
  // Move to a trash folder instead of deleting outright.
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(dir, path.join(trash, `${id}-${Date.now()}`));
  return { ok: true };
}
