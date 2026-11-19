// Local environments: a named set of folders and environment variables a chat can start in.
// The first folder is the chat's working folder, the rest are passed with --add-dir, and the
// variables go into the claude process. Each folder can pin a branch and run in its own git
// worktree. Stored in ~/.claude-web/environments.json, with the picker's starred entries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, PRIVATE_ENV } from './config.js';

const FILE = path.join(config.dataDir, 'environments.json');
// Variables the UI server sets itself, which an environment must not override.
const RESERVED = new Set([...PRIVATE_ENV, 'CW_INTERNAL_URL', 'CW_INTERNAL_TOKEN', 'CW_SESSION_ID', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING']);

let list = null;
let favorites = [];

// Folders were plain paths before branches and worktrees; read either shape.
const folderOf = (f) => (typeof f === 'string' ? { path: f } : { path: f.path, ...(f.branch ? { branch: f.branch } : {}), ...(f.worktree ? { worktree: true } : {}) });

function load() {
  if (list) return list;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    list = (j.environments || []).map((e) => ({ ...e, folders: (e.folders || []).map(folderOf) }));
    favorites = Array.isArray(j.favorites) ? j.favorites : [];
  } catch {
    list = [];
  }
  return list;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ environments: list, favorites }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** Starred picker entries: "env:<id>" or a folder path. */
export function listFavorites() {
  load();
  return favorites;
}

export function setFavorite(key, on) {
  load();
  key = String(key || '').slice(0, 1000);
  if (!key) throw new Error('Nothing to star');
  favorites = favorites.filter((k) => k !== key);
  if (on) favorites.unshift(key);
  save();
  return favorites;
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
    folderInfo: e.folders.map((f) => {
      let exists = false;
      try {
        exists = fs.statSync(f.path).isDirectory();
      } catch {}
      return { ...f, exists, git: exists && fs.existsSync(path.join(f.path, '.git')) };
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
  for (const raw of Array.isArray(body?.folders) ? body.folders : []) {
    const f = folderOf(raw);
    const p = resolveDir(String(f.path));
    const branch = f.branch ? String(f.branch).trim().slice(0, 200) : '';
    if (branch && (branch.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(branch))) throw new Error(`Bad branch name: ${branch}`);
    if (!folders.some((x) => x.path === p)) folders.push({ path: p, ...(branch ? { branch } : {}), ...(f.worktree ? { worktree: true } : {}) });
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
  favorites = favorites.filter((k) => k !== `env:${id}`);
  save();
}

/**
 * What a session started in this environment adds to its process: extra dirs and variables.
 * The extra dirs were fixed when the chat started (worktree paths where a folder has one).
 */
export function sessionExtras(meta) {
  const e = getEnvironment(meta?.envId);
  const dirs = Array.isArray(meta?.addDirs) ? meta.addDirs : e ? e.folders.map((f) => f.path) : [];
  const addDirs = dirs.filter((p) => p !== meta.cwd && p !== meta.project && fs.existsSync(p));
  return { addDirs, env: e ? { ...e.env } : {} };
}
