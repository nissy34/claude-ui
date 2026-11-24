#!/usr/bin/env node
// End-to-end: chats survive a server restart when they run in the session runner. Starts a runner
// and a server (fake CLI), restarts the server in the middle of turns, and checks the turns carry on
// in the same CLI process with nothing lost or repeated.   npm run test:runner-chats
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { RunnerClient } from '../server/runner-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rchat-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
const sock = path.join(tmp, 'runner', 'runner.sock');
const fakeLog = path.join(tmp, 'fake.log');

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CW_RUNNER: sock,
  CW_RUNNER_SOCKET: sock,
  FAKE_CLAUDE_LOG: fakeLog,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];

let failures = 0;
const check = (cond, msg, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`, !cond && extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch?.(() => null) ?? (await fn());
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let server = null;
let serverLog = '';
let cookie = '';
async function startServer() {
  server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => ((serverLog += d), process.env.VERBOSE && process.stdout.write(d)));
  server.stderr.on('data', (d) => ((serverLog += d), process.env.VERBOSE && process.stderr.write(d)));
  await until(() => fetch(base + '/api/me').then(() => true, () => false), 20_000, 'server');
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function stopServer() {
  const p = server;
  server = null;
  const done = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  await done;
}
const api = async (p, body) => {
  const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
function chat(id, send) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`, { headers: { cookie } });
    ws.once('message', (d) => {
      const snap = JSON.parse(d);
      if (snap.meta?.claudeSessionId) claudeIds.set(id, snap.meta.claudeSessionId);
      if (send) ws.send(JSON.stringify(send));
      setTimeout(() => ws.close(), send ? 300 : 0);
      resolve(snap);
    });
    ws.once('error', reject);
  });
}
// What Claude did (the user's own messages, which quote the directives, left out).
/** A terminal session: its screen snapshot after sending `input` (and waiting `wait` ms). */
function term(id, input, wait = 400) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}&cols=100&rows=30`, { headers: { cookie } });
    let screen = '';
    let session = null;
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'snapshot') {
        screen = m.d;
        session = m.session;
        if (input) ws.send(JSON.stringify({ t: 'i', d: input }));
        setTimeout(() => (ws.close(), resolve({ screen, session })), input ? wait : 50);
      } else if (m.t === 'o') screen += m.d;
    });
    ws.once('error', reject);
  });
}
const text = (snap) => JSON.stringify(snap.events.filter((e) => e.k !== 'user'));
const count = (s, needle) => s.split(needle).length - 1;
const claudeIds = new Map(); // chat id -> Claude session id
const cliStarts = (sid) =>
  fs.existsSync(fakeLog)
    ? new Set(
        fs
          .readFileSync(fakeLog, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((x) => x.argv && !x.env && x.sessionId === claudeIds.get(sid))
          .map((x) => x.pid)
      ).size
    : 0;
const fakeCalls = () =>
  fs.existsSync(fakeLog)
    ? fs
        .readFileSync(fakeLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((x) => x.call)
    : [];

const runner = spawn(process.execPath, [path.join(here, '..', 'server', 'runner.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let runnerLog = '';
runner.stdout.on('data', (d) => (runnerLog += d));
runner.stderr.on('data', (d) => (runnerLog += d));

try {
  await until(async () => fs.existsSync(sock), 5000, 'runner socket');
  await startServer();
  check(/session runner: connected/.test(serverLog), 'the server connects to the runner');

  // ---- 1. a turn running across a restart ----
  const a = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Long', prompt: '@@sleep 4000\n@@say finished-after-sleep' })).session;
  await until(async () => (await chat(a.id)).state === 'busy', 10_000, 'chat A busy');
  // ---- 2. a permission prompt open across a restart ----
  const b = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Ask', prompt: '@@ask Bash {"command":"echo hi"}' })).session;
  await until(async () => (await chat(b.id)).pending?.length === 1, 10_000, 'chat B prompt');
  // ---- 3. a turn that ends while the server is down ----
  const c = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Short', prompt: '@@sleep 1500\n@@say done-while-down' })).session;
  await until(async () => (await chat(c.id)).state === 'busy', 10_000, 'chat C busy');
  // ---- 4. an MCP call to the server while it is down ----
  const d = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Mcp', prompt: '@@sleep 1200\n@@call sessions__list_sessions {"all":true}\n@@say mcp-done' })).session;
  await until(async () => (await chat(d.id)).state === 'busy', 10_000, 'chat D busy');

  // ---- 5. a terminal across a restart ----
  const t = (await api('/api/sessions', { kind: 'shell', cwd: 'demo', name: 'Term' })).session;
  await until(async () => (await term(t.id)).session.pid, 10_000, 'terminal pid');
  await term(t.id, 'echo before-$((20+1))\r');
  const t0 = await term(t.id, 'sleep 2; echo during-$((2*21))\r', 100);

  await stopServer();
  const rc = new RunnerClient(sock);
  await rc.connect();
  const live = (await rc.request('list')).procs;
  rc.close();
  check([a.id, b.id, c.id, d.id, t.id].every((id) => live.some((p) => p.id === id)), 'the CLIs are still in the runner after the server stopped', live.map((p) => [p.id, p.alive]));
  await sleep(3500); // chat C's and D's turns run on (D's MCP call waits for the server)
  await startServer();
  check(/picked up chat "Long"/.test(serverLog), 'the new server picks the chats up');

  const sa = await until(async () => {
    const s = await chat(a.id);
    return text(s).includes('finished-after-sleep') && s.state === 'idle' && s;
  }, 15_000, 'chat A to finish');
  check(count(text(sa), 'finished-after-sleep') === 1, 'the running turn finishes once, in the same chat');
  check(cliStarts(a.id) === 1, 'in the same CLI process (not restarted)', cliStarts(a.id));
  check(!/shut down while Claude was working|Claude exited|Press Resume/.test(text(sa)), 'with no "stopped" error in the chat');

  const sb = await chat(b.id);
  check(sb.state === 'waiting' && sb.pending?.length === 1 && sb.pending[0].tool === 'Bash', 'the open permission prompt is still shown', { state: sb.state, pending: sb.pending });
  await chat(b.id, { t: 'perm', reqId: sb.pending[0].reqId, behavior: 'allow' });
  const sb2 = await until(async () => {
    const s = await chat(b.id);
    return s.state === 'idle' && text(s).includes('allow') && s;
  }, 10_000, 'chat B answered');
  check(cliStarts(b.id) === 1 && sb2.pending.length === 0, 'answering it after the restart reaches the same CLI');

  const sc = await until(async () => {
    const s = await chat(c.id);
    return s.state === 'idle' && text(s).includes('done-while-down') && s;
  }, 10_000, 'chat C');
  check(count(text(sc), 'done-while-down') === 1, 'a turn that ended while the server was down shows its reply, once');

  const sd = await until(async () => {
    const s = await chat(d.id);
    return s.state === 'idle' && text(s).includes('mcp-done') && s;
  }, 70_000, 'chat D');
  const mcp = fakeCalls().find((x) => x.call === 'sessions__list_sessions');
  check(mcp && !/Error|ECONNREFUSED/.test(mcp.result) && mcp.result.includes('Long'), 'an MCP call made while the server was down retries and succeeds', mcp);
  check(count(text(sd), 'mcp-done') === 1, 'and its turn carries on');

  const t1 = await until(async () => {
    const r = await term(t.id);
    return r.screen.includes('during-42') && r;
  }, 10_000, 'terminal output from while the server was down');
  check(t1.screen.includes('before-21') && t1.session.pid === t0.session.pid, 'a terminal keeps its process and shows what it printed while the server was down', { pid0: t0.session.pid, pid1: t1.session.pid });
  check(count(t1.screen, 'during-42') === 1, 'with nothing repeated');
  const t2 = await term(t.id, 'echo after-$((50-8))\r', 800);
  check(count(t2.screen, 'after-42') >= 1 && t2.session.status === 'running', 'and takes input again');

  // ---- 6. a new message after the restart goes to the same CLI ----
  await chat(a.id, { t: 'send', text: '@@say second-message' });
  await until(async () => text(await chat(a.id)).includes('second-message'), 10_000, 'second message');
  check(cliStarts(a.id) === 1, 'a new message after the restart uses the same CLI');

  // ---- 7. without a runner the old behavior holds: stopping the server stops the chat ----
  runner.kill('SIGTERM');
  await until(async () => /connection lost/.test(serverLog), 5000, 'server to notice the runner is gone');
  const e = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Local', prompt: '@@say local-ok' })).session;
  await until(async () => text(await chat(e.id)).includes('local-ok'), 10_000, 'local chat');
  check(true, 'with the runner gone, new chats start locally');
} catch (err) {
  console.error(err);
  failures++;
  if (!process.env.VERBOSE) console.log(serverLog.slice(-3000));
} finally {
  if (server) server.kill('SIGKILL');
  runner.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall runner chat tests passed');
process.exit(failures ? 1 : 0);
