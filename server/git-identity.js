// Git name and email for commits made in chats, terminals and by the server itself.
//
// Settings > Account > Git identity saves { name, email } in <data>/git-identity.json. The server
// points GIT_CONFIG_GLOBAL at its own <data>/gitconfig, which first includes the user's real
// global config (~/.gitconfig, ~/.config/git/config, or the GIT_CONFIG_GLOBAL it was started
// with) and then sets [user]. So:
//   - a repository's own user.name/user.email still wins (it is more specific than global);
//   - a name/email saved in Settings beats the host's global one;
//   - with nothing saved and nothing in the host's config, a default is used, so commits never
//     fail with "Please tell me who you are".
// Every process the server starts inherits GIT_CONFIG_GLOBAL, and git reads the file on each run,
// so a change applies at once, even in chats that are already open. Other `git config --global`
// writes made from a chat land in this file and are kept (only [user] is managed here).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'git-identity.json');
const GITCONFIG = path.join(config.dataDir, 'gitconfig');
// The global config the server was started with, before we point git at our own file.
const ORIGINAL_GLOBAL = process.env.GIT_CONFIG_GLOBAL && path.resolve(process.env.GIT_CONFIG_GLOBAL) !== GITCONFIG ? process.env.GIT_CONFIG_GLOBAL : '';

let gitOk = null;
function git(args, env) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, timeout: 5000 }).trim();
}
function hasGit() {
  if (gitOk === null) {
    try {
      git(['--version'], process.env);
      gitOk = true;
    } catch {
      gitOk = false;
    }
  }
  return gitOk;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { name: typeof j.name === 'string' ? j.name : '', email: typeof j.email === 'string' ? j.email : '' };
  } catch {
    return { name: '', email: '' };
  }
}

/** The host's own global identity (what git would use without us). */
function hostIdentity() {
  const env = { ...process.env };
  if (ORIGINAL_GLOBAL) env.GIT_CONFIG_GLOBAL = ORIGINAL_GLOBAL;
  else delete env.GIT_CONFIG_GLOBAL;
  const get = (k) => {
    try {
      return git(['config', '--global', '--get', k], env);
    } catch {
      return '';
    }
  };
  return { name: get('user.name'), email: get('user.email') };
}

export function defaultIdentity() {
  let user = process.env.USER || '';
  try {
    user = user || os.userInfo().username;
  } catch {}
  user = user || 'claude';
  return { name: user, email: `${user.replace(/[^\w.-]/g, '') || 'claude'}@claude-ui.local` };
}

/** Writes <data>/gitconfig and points GIT_CONFIG_GLOBAL at it. Safe to call often. */
export function applyGitIdentity() {
  if (!hasGit()) return null;
  const saved = load();
  const host = hostIdentity();
  const def = defaultIdentity();
  // Only [user] values we must set: what Settings saved, else a default where the host has none.
  const want = { name: saved.name || (host.name ? '' : def.name), email: saved.email || (host.email ? '' : def.email) };

  const includes = ORIGINAL_GLOBAL ? [ORIGINAL_GLOBAL] : [path.join(os.homedir(), '.config', 'git', 'config'), path.join(os.homedir(), '.gitconfig')];
  if (!fs.existsSync(GITCONFIG)) {
    // [include] first so the [user] section after it wins over the host's values.
    const body = '# Made by Claude UI (Settings > Account > Git identity). [user] is managed there.\n[include]\n' + includes.map((p) => `\tpath = ${p.replace(/\\/g, '/')}\n`).join('');
    fs.writeFileSync(GITCONFIG, body, { mode: 0o600 });
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: GITCONFIG };
  for (const k of ['name', 'email']) {
    try {
      if (want[k]) git(['config', '--file', GITCONFIG, `user.${k}`, want[k]], env);
      else git(['config', '--file', GITCONFIG, '--unset-all', `user.${k}`], env);
    } catch {
      // --unset-all exits 5 when the key is not there: nothing to do.
    }
  }
  process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
  return gitIdentityStatus();
}

export function gitIdentityStatus() {
  const saved = load();
  if (!hasGit()) return { available: false, saved };
  const host = hostIdentity();
  const def = defaultIdentity();
  const pick = (k) => (saved[k] ? { value: saved[k], source: 'settings' } : host[k] ? { value: host[k], source: 'host' } : { value: def[k], source: 'default' });
  return {
    available: true,
    saved,
    host,
    default: def,
    effective: { name: pick('name'), email: pick('email') },
    hostPath: ORIGINAL_GLOBAL || '~/.gitconfig',
  };
}

export function setGitIdentity({ name, email }) {
  const clean = (v, max) => String(v ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
  const next = { name: clean(name, 200), email: clean(email, 254) };
  if (next.email && !/^[^\s@<>]+@[^\s@<>]+$/.test(next.email)) {
    const e = new Error('That does not look like an email address.');
    e.status = 400;
    throw e;
  }
  if (next.name && /[<>]/.test(next.name)) {
    const e = new Error('The name cannot contain < or >.');
    e.status = 400;
    throw e;
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return applyGitIdentity() || gitIdentityStatus();
}
