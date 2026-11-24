#!/usr/bin/env node
// Self-update end to end, without Docker: the updater (server/updater.js) runs a stand-in
// deploy.sh in a scratch checkout. Checks Settings > Server (any branch) and chats (main only, only
// after the user approved that exact commit).   npm run test:self-update
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-upd-'));
const port = 20000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

// A remote with main and a feature branch, and the checkout the updater works in.
const origin = path.join(tmp, 'origin.git');
const seed = path.join(tmp, 'seed');
const checkout = path.join(tmp, 'checkout');
const deployLog = path.join(tmp, 'deploy.log');
fs.mkdirSync(path.join(seed, 'scripts'), { recursive: true });
sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
sh(seed, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(seed, 'scripts', 'deploy.sh'), `#!/usr/bin/env bash\necho "deploy $*" >> "${deployLog}"\necho "pretend build"\nsleep 1\n`);
sh(seed, 'add', '.');
sh(seed, 'commit', '-qm', 'first');
sh(seed, 'remote', 'add', 'origin', origin);
sh(seed, 'push', '-q', 'origin', 'main');
sh(seed, 'checkout', '-q', '-b', 'feature');
fs.writeFileSync(path.join(seed, 'f.txt'), 'x');
sh(seed, 'add', '.');
sh(seed, 'commit', '-qm', 'feature work');
sh(seed, 'push', '-q', 'origin', 'feature');
sh(seed, 'checkout', '-q', 'main');
sh(tmp, 'clone', '-q', origin, checkout);
// main moves on after the checkout was made: the server is one commit behind.
fs.writeFileSync(path.join(seed, 'new.txt'), 'y');
sh(seed, 'add', '.');
sh(seed, 'commit', '-qm', 'Fix the thing');
sh(seed, 'push', '-q', 'origin', 'main');
const mainTip = sh(seed, 'rev-parse', '--short', 'HEAD');

const updSock = path.join(tmp, 'updater', 'updater.sock');
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });
const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CW_UPDATER: updSock,
  CW_UPDATER_SOCKET: updSock,
  CW_UPDATER_REPO: checkout,
  COMPOSE_PROJECT_NAME: 'test',
  FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];

let failures = 0;
const check = (cond, msg, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`, !cond && extra !== undefined ? JSON.stringify(extra).slice(0, 700) : '');
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const updater = (method, p, body) =>
  new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ socketPath: updSock, path: p, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }));
    });
    req.end(data);
  });
const fakeCalls = () =>
  fs
    .readFileSync(env.FAKE_CLAUDE_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((x) => x.call);

const upd = spawn(process.execPath, [path.join(here, '..', 'server', 'updater.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let updLog = '';
upd.stdout.on('data', (d) => (updLog += d));
upd.stderr.on('data', (d) => (updLog += d));
const server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  await until(() => fetch(base + '/api/me').then(() => true, () => false), 20_000, 'server');
  await until(async () => fs.existsSync(updSock), 5000, 'updater socket');
  const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = lr.headers.get('set-cookie').split(';')[0];
  const api = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const chat = (id, send) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`, { headers: { cookie } });
      ws.once('message', (d) => {
        if (send) ws.send(JSON.stringify(send));
        setTimeout(() => ws.close(), send ? 300 : 0);
        resolve(JSON.parse(d));
      });
      ws.once('error', reject);
    });

  // ---- Settings > Server ----
  const c1 = (await api('/api/update/check?ref=main')).body;
  check(c1.behind === 1 && c1.target === mainTip && c1.commits[0]?.subject === 'Fix the thing', 'check shows main one commit ahead, with its subject', c1);
  const c2 = (await api('/api/update/check?ref=feature')).body;
  check(c2.behind === 1 && c2.commits[0]?.subject === 'feature work', 'check works for another branch', c2);
  const r1 = (await api('/api/update/run', { ref: 'feature', runner: true })).body;
  check(r1.status === 'running' && r1.source === 'settings', 'Settings starts an update of any branch', r1);
  const busy = (await api('/api/update/run', { ref: 'main' })).status;
  check(busy === 409, 'a second update while one runs is refused', busy);
  const r1d = await until(async () => {
    const r = (await api(`/api/update/runs/${r1.id}`)).body;
    return r.status !== 'running' && r;
  }, 10_000, 'run 1');
  check(r1d.status === 'ok' && r1d.output.includes('pretend build'), 'the run finishes and shows its log', r1d);
  check(fs.readFileSync(deployLog, 'utf8').includes('deploy --ref feature --runner'), 'deploy.sh got the branch and --runner', fs.readFileSync(deployLog, 'utf8'));

  // ---- the updater refuses chats anything but main, and anything not approved ----
  const bad = await updater('POST', '/deploy', { source: 'chat', ref: 'feature', expect: 'abc' });
  check(bad.status === 403 && /only update from main/.test(bad.body.error), 'the updater refuses a chat any branch but main', bad);
  const moved = await updater('POST', '/deploy', { source: 'chat', ref: 'main', expect: '0000000' });
  check(moved.status === 409 && /not the approved/.test(moved.body.error), 'and a commit that is not main\'s tip', moved);

  // ---- a chat: check, then update without approval (refused), then with ----
  const s = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Updater chat', prompt: `@@call server__check_for_update {}\n@@call server__update_server ${JSON.stringify({ to_commit: mainTip })}\n@@say first-done` })).body.session;
  await until(async () => JSON.stringify((await chat(s.id)).events.filter((e) => e.k !== 'user')).includes('first-done'), 20_000, 'first turn');
  const calls1 = fakeCalls();
  const chk = calls1.find((x) => x.call === 'server__check_for_update');
  check(chk && chk.result.includes(mainTip) && chk.result.includes('Fix the thing'), 'check_for_update tells the chat what main would bring', chk);
  const unapproved = calls1.find((x) => x.call === 'server__update_server');
  check(unapproved && /has not approved/.test(unapproved.result), 'update_server without the user\'s approval is refused', unapproved);

  const before = fs.readFileSync(deployLog, 'utf8').split('\n').filter(Boolean).length;
  await chat(s.id, { t: 'send', text: `@@approve mcp__server__update_server ${JSON.stringify({ to_commit: mainTip })}\n@@call server__update_server ${JSON.stringify({ to_commit: mainTip })}\n@@say second-done` });
  const p = await until(async () => {
    const snap = await chat(s.id);
    return snap.pending?.find((x) => x.tool === 'mcp__server__update_server');
  }, 10_000, 'permission prompt');
  check(p.input.to_commit === mainTip, 'the permission prompt shows the commit');
  await chat(s.id, { t: 'perm', reqId: p.reqId, behavior: 'allow', always: true });
  await until(async () => JSON.stringify((await chat(s.id)).events.filter((e) => e.k !== 'user')).includes('second-done'), 30_000, 'second turn');
  const approved = fakeCalls().filter((x) => x.call === 'server__update_server').pop();
  check(approved && /^Updated/.test(approved.result), 'after the user approves, update_server runs and reports', approved);
  const lines = fs.readFileSync(deployLog, 'utf8').split('\n').filter(Boolean);
  check(lines.length === before + 1 && lines.at(-1).includes(`--ref main --commit ${mainTip}`), 'deploy.sh ran once, pinned to the approved commit of main', lines);
  const again = await updater('GET', '/status');
  check(again.body.last.source === 'chat' && /Updater chat/.test(again.body.last.requestedBy), 'the run records which chat asked', again.body.last);

  // The approval was used up: the same call again is refused.
  await chat(s.id, { t: 'send', text: `@@call server__update_server ${JSON.stringify({ to_commit: mainTip })}\n@@say third-done` });
  await until(async () => JSON.stringify((await chat(s.id)).events.filter((e) => e.k !== 'user')).includes('third-done'), 20_000, 'third turn');
  const reused = fakeCalls().filter((x) => x.call === 'server__update_server').pop();
  check(/has not approved/.test(reused.result), 'an approval works once ("always allow" is ignored for updates)', reused);
} catch (e) {
  console.error(e);
  failures++;
  console.log(serverLog.slice(-2000), updLog.slice(-2000));
} finally {
  server.kill('SIGKILL');
  upd.kill('SIGKILL');
  await sleep(300);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall self-update tests passed');
process.exit(failures ? 1 : 0);
