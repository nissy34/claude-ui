#!/usr/bin/env node
// Checks the git identity for chat commits (server/git-identity.js): with no name/email anywhere a
// commit still works under a default, the host's ~/.gitconfig is used when it has one, a name and
// email saved in Settings beat it (and apply to already running processes), a repository's own
// config still wins, other `git config --global` writes are kept, and chats inherit it.
// Run: node scripts/test-git-identity.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-git-'));
const port = 20500 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const home = path.join(tmp, 'home');
const repo = path.join(tmp, 'projects', 'demo');
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });
const log = path.join(tmp, 'fake.log');
const dataDir = path.join(tmp, 'data');
const GITCONFIG = path.join(dataDir, 'gitconfig');

const env = {
  ...process.env,
  HOME: home,
  USER: 'nissan',
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: dataDir,
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CLAUDE_CONFIG_DIR: claudeDir,
  FAKE_CLAUDE_LOG: log,
  FAKE_CLAUDE_LOG_ENV: 'GIT_CONFIG_GLOBAL',
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'XDG_CONFIG_HOME', 'EMAIL']) delete env[k];

let failures = 0;
let passes = 0;
const check = (cond, msg, extra) => {
  if (cond) {
    passes++;
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function api(p, opts = {}) {
  const res = await fetch(base + p, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: res.status, j, text };
}
async function until(fn, ms = 10_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}
// A commit the way a chat would make it: the server's environment, git pointed at our gitconfig.
const chatEnv = { ...env, GIT_CONFIG_GLOBAL: GITCONFIG };
const git = (args, cwd = repo, e = chatEnv) => execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
function commit() {
  fs.writeFileSync(path.join(repo, 'f.txt'), String(++n));
  git(['add', '.']);
  git(['commit', '-qm', `c${n}`]);
  return git(['log', '-1', '--format=%an <%ae>|%cn <%ce>']);
}

let server;
async function start() {
  server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function stop() {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
}

async function main() {
  execFileSync('git', ['init', '-q', repo], { env: chatEnv });
  // Without our gitconfig, git refuses to commit here: the bug.
  let refused = false;
  try {
    fs.writeFileSync(path.join(repo, 'x'), '1');
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['-c', 'user.useConfigOnly=true', 'commit', '-qm', 'x'], { cwd: repo, env, stdio: 'pipe' });
  } catch {
    refused = true;
  }
  check(refused, 'precondition: with no identity git refuses to commit');

  await start();
  console.log('Nothing set anywhere');
  let s = (await api('/api/git-identity')).j;
  check(s.available && s.effective.name.source === 'default' && s.effective.email.value === 'nissan@claude-ui.local', 'status reports the default identity', s);
  check(commit() === 'nissan <nissan@claude-ui.local>|nissan <nissan@claude-ui.local>', 'a commit works under the default');

  console.log('Chats inherit it');
  const { project } = (await api('/api/cprojects', { method: 'POST', body: { name: 'Demo', folders: [repo] } })).j;
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'hello' } });
  const hit = await until(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.env).pop() : null), 10_000, 'a claude process');
  check(hit.env.GIT_CONFIG_GLOBAL === GITCONFIG, 'claude processes get GIT_CONFIG_GLOBAL', hit.env);

  console.log('Saved in Settings');
  let r = await api('/api/git-identity', { method: 'PUT', body: { name: 'x', email: 'not an email' } });
  check(r.status === 400, 'a bad email is refused', r.j);
  r = await api('/api/git-identity', { method: 'PUT', body: { name: ' Nissan Test ', email: 'nissan@example.com' } });
  check(r.status === 200 && r.j.effective.name.source === 'settings' && r.j.saved.name === 'Nissan Test', 'saved and in use', r.j);
  check(commit() === 'Nissan Test <nissan@example.com>|Nissan Test <nissan@example.com>', 'the next commit uses it, without restarting anything');

  console.log("The host's ~/.gitconfig");
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Host Name\n\temail = host@example.com\n[alias]\n\tst = status\n');
  r = await api('/api/git-identity', { method: 'PUT', body: { name: '', email: '' } });
  check(r.j.effective.name.source === 'host' && r.j.effective.email.value === 'host@example.com', 'cleared: the host identity is used', r.j);
  check(commit() === 'Host Name <host@example.com>|Host Name <host@example.com>', 'commit uses the host identity');
  check(git(['config', '--global', '--includes', 'alias.st']) === 'status', "the host's other settings still apply (included)");
  r = await api('/api/git-identity', { method: 'PUT', body: { email: 'mine@example.com' } });
  check(commit() === 'Host Name <mine@example.com>|Host Name <mine@example.com>', 'a saved email beats the host one, the name still comes from the host');

  console.log('Repository config and global writes');
  git(['config', 'user.name', 'Repo Name']);
  check(commit().startsWith('Repo Name <mine@example.com>'), "a repository's own user.name still wins");
  git(['config', '--unset', 'user.name']);
  git(['config', '--global', 'safe.directory', '/somewhere']);
  await stop();
  await start();
  check(git(['config', '--global', 'safe.directory']) === '/somewhere', 'other git config --global writes survive a restart');
  s = (await api('/api/git-identity')).j;
  check(s.saved.email === 'mine@example.com' && commit() === 'Host Name <mine@example.com>|Host Name <mine@example.com>', 'the saved identity survives a restart');
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    server?.kill('SIGTERM');
    console.log(`\n${passes} passed, ${failures} failed`);
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  });
