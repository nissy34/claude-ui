// Local environments: a named set of folders and environment variables a chat can start in.
// The first folder is the chat's working folder, the rest are passed with --add-dir, and the
// variables go into the claude process. Stored in ~/.claude-web/environments.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, PRIVATE_ENV } from './config.js';

const FILE = path.join(config.dataDir, 'environments.json');
// Variables the UI server sets itself, which an environment must not override.
const RESERVED = new Set([...PRIVATE_ENV, 'CW_INTERNAL_URL', 'CW_INTERNAL_TOKEN', 'CW_SESSION_ID', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING']);

let list = null;

function load() {
  if (list) return list;
  try {
    list = JSON.parse(fs.readFileSync(FILE, 'utf8')).environments || [];
  } catch {
    list = [];
  }
  return list;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ environments: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function listEnvironments() {
  return load().map(decorate);
}

export function getEnvironment(id) {
  return id ? load().find((e) => e.id === id) || null : null;
}

// Folder rows carry whether each still exists and is a git repo, for the dialog.
function decorate(e) {
  return {
    ...e,
    folderInfo: e.folders.map((p) => {
      let exists = false;
      try {
        exists = fs.statSync(p).isDirectory();
      } catch {}
      return { path: p, exists, git: exists && fs.existsSync(path.join(p, '.git')) };
    }),
  };
}

/** Accepts env as an object or as "KEY=value" lines (.env style). */
export function parseEnv(input) {
  const out = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input)) out[String(k).trim()] = String(v ?? '');
  } else {
    for (const raw of String(input || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.replace(/^export\s+/, '').match(/^([^=]+)=(.*)$/);
      if (!m) throw new Error(`Not KEY=value: ${line.slice(0, 60)}`);
      let v = m[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      out[m[1].trim()] = v;
    }
  }
  for (const k of Object.keys(out)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Bad variable name: ${k.slice(0, 60)}`);
    if (RESERVED.has(k)) throw new Error(`${k} is set by Claude UI and can't be changed here`);
  }
  return out;
}

function clean(body, resolveDir) {
  const name = String(body?.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the environment a name');
  const folders = [];
  for (const f of Array.isArray(body?.folders) ? body.folders : []) {
    const p = resolveDir(String(f));
    if (!folders.includes(p)) folders.push(p);
  }
  return { name, folders, env: parseEnv(body?.env) };
}

export function createEnvironment(body, resolveDir) {
  const e = { id: crypto.randomUUID(), ...clean(body, resolveDir), createdAt: Date.now() };
  if (load().some((x) => x.name.toLowerCase() === e.name.toLowerCase())) throw new Error(`There is already an environment called ${e.name}`);
  list.push(e);
  save();
  return decorate(e);
}

export function updateEnvironment(id, body, resolveDir) {
  const e = getEnvironment(id);
  if (!e) throw new Error('No such environment');
  const next = clean(body, resolveDir);
  if (load().some((x) => x.id !== id && x.name.toLowerCase() === next.name.toLowerCase())) throw new Error(`There is already an environment called ${next.name}`);
  Object.assign(e, next, { updatedAt: Date.now() });
  save();
  return decorate(e);
}

export function deleteEnvironment(id) {
  load();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) throw new Error('No such environment');
  list.splice(i, 1);
  save();
}

/** What a session started in this environment adds to its process: extra dirs and variables. */
export function sessionExtras(meta) {
  const e = getEnvironment(meta?.envId);
  if (!e) return { addDirs: [], env: {} };
  const addDirs = e.folders.filter((p) => p !== meta.cwd && p !== meta.project && fs.existsSync(p));
  return { addDirs, env: { ...e.env } };
}
