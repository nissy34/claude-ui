#!/usr/bin/env node
// End-to-end checks for the Teams bridge (teams-bridge/) against the scripted fake CLI and a fake
// Microsoft Graph + sign-in server. Starts Claude UI and the bridge in a temp folder, then plays
// the person in the Teams chat. Run: node scripts/test-bridge.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bridge-'));
const port = 19000 + Math.floor(Math.random() * 500);
const gport = port + 600;
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CW_PROJECT_BATCH_QUIET_MS: '300',
  CW_PROJECT_BATCH_MAX_MS: '1500',
  FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];

let failures = 0;
let passes = 0;
const check = (cond, msg, extra) => {
  if (cond) {
    passes++;
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : '');
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, label = 'condition') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------- fake Graph + login ----------
const ME = { id: 'user-me', displayName: 'Test Person' };
const chat = []; // messages, oldest first
const reactions = [];
const edits = [];
let tokenCalls = 0;
let challenge = ''; // PKCE challenge from the sign-in link the bridge made
let refreshes = 0;
let n = 0;
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const graph = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    // Device code sign-in is blocked, as in many company tenants: the bridge falls back to the browser.
    if (p.endsWith('/oauth2/v2.0/devicecode')) return json(res, 400, { error: 'invalid_request', error_description: 'AADSTS50199: device code flow is blocked by policy' });
    if (p.endsWith('/oauth2/v2.0/token')) {
      const f = new URLSearchParams(data);
      if (f.get('grant_type') === 'refresh_token') {
        refreshes++;
        return json(res, 200, { access_token: `at-r${refreshes}`, refresh_token: `rt-${refreshes}`, expires_in: 3600 });
      }
      if (f.get('grant_type') === 'authorization_code') {
        tokenCalls++;
        const ok = f.get('code') === 'good-code' && f.get('redirect_uri') === 'http://localhost' && crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === challenge;
        if (!ok) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
        return json(res, 200, { access_token: 'at-1', refresh_token: 'rt-0', expires_in: 3600 });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (!/^Bearer at-/.test(req.headers.authorization || '')) return json(res, 401, { error: { message: 'no token' } });
    if (p === '/v1.0/me') return json(res, 200, ME);
    let m;
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages$/.exec(p))) {
      if (req.method === 'GET') return json(res, 200, { value: [...chat].reverse().slice(0, Number(url.searchParams.get('$top')) || 20) });
      const b = JSON.parse(data);
      const msg = { id: `m${++n}`, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: ME.id } }, body: b.body, attachments: [], bot: true };
      chat.push(msg);
      return json(res, 201, msg);
    }
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages\/([^/]+)\/setReaction$/.exec(p))) {
      reactions.push(m[2]);
      return json(res, 204, {});
    }
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
      const msg = chat.find((x) => x.id === m[2]);
      if (!msg) return json(res, 404, { error: { message: 'gone' } });
      msg.body = JSON.parse(data).body;
      edits.push(m[2]);
      return json(res, 204, {});
    }
    json(res, 404, { error: { message: `no route ${req.method} ${p}` } });
  });
});

/** The person writes in the chat, optionally as a reply to one of the bridge's messages. */
function say(text, replyTo) {
  const id = `u${++n}`;
  chat.push({ id, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: ME.id } }, body: { contentType: 'html', content: replyTo ? `<attachment id="${replyTo}"></attachment><p>${text}</p>` : `<p>${text}</p>` }, attachments: replyTo ? [{ id: replyTo, contentType: 'messageReference' }] : [] });
  return id;
}
const botMsgs = () => chat.filter((m) => m.bot);
const findBot = (re) => botMsgs().find((m) => re.test(m.body.content));
const lastBot = () => botMsgs().at(-1);

// ---------- processes ----------
let server;
let bridge;
let cookie = '';
const bridgeLog = [];
async function api(p, opts = {}) {
  const res = await fetch(base + p, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok && !opts.allowError) throw new Error(`${p}: ${j.error || res.status}`);
  return opts.allowError ? { status: res.status, ...j } : j;
}

async function main() {
  await new Promise((r) => graph.listen(gport, '127.0.0.1', r));
  server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];

  console.log('Bridge API is locked');
  const tokenFile = path.join(env.CW_DATA_DIR, 'bridge-token');
  check(fs.existsSync(tokenFile), 'a bridge token is generated');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  check((await api('/api/bridge/attention', { headers: { cookie: '' }, allowError: true })).status === 401, 'no token: refused');
  check((await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}`, origin: 'http://evil' }, allowError: true })).status === 403, 'a browser page: refused');
  const empty = await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}` } });
  check(Array.isArray(empty.items) && empty.items.length === 0, 'nothing is waiting at start');

  console.log('Start the bridge: device code is blocked, so browser sign-in with a pasted address');
  bridge = spawn(process.execPath, [path.join(root, 'teams-bridge', 'bridge.mjs')], {
    env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: tokenFile, TEAMS_DATA_DIR: path.join(tmp, 'teams'), TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0', TEAMS_AUTH: 'auto' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => (bridgeLog.push(String(d)), process.env.VERBOSE && process.stdout.write(`[bridge] ${d}`)));
  bridge.stderr.on('data', (d) => (bridgeLog.push(String(d)), process.stderr.write(`[bridge] ${d}`)));
  const signin = await until(async () => {
    const r = await api('/api/bridge-status');
    return r.status?.state === 'signin-browser' && r.status;
  }, 20_000, 'browser sign-in link');
  const link = new URL(signin.url);
  challenge = link.searchParams.get('code_challenge');
  check(link.pathname.endsWith('/tenant/oauth2/v2.0/authorize') && link.searchParams.get('redirect_uri') === 'http://localhost' && link.searchParams.get('code_challenge_method') === 'S256' && /Chat\.ReadWrite/.test(link.searchParams.get('scope')), 'a PKCE sign-in link with the localhost redirect', signin.url);
  const bs = await api('/api/bridge-status');
  check(bs.enabled && bs.token === token, 'Settings > Teams gets the state and the bridge token');
  check((await api('/api/bridge-signin', { method: 'POST', body: { url: 'hello' }, allowError: true })).status === 400, 'a pasted non-address is refused');
  await api('/api/bridge-signin', { method: 'POST', body: { url: `http://localhost/?code=good-code&state=wrong` } });
  await until(async () => (await api('/api/bridge-status')).status?.state === 'signin-error', 10_000, 'state mismatch error');
  check(true, 'an address from another sign-in is rejected with a message');
  await api('/api/bridge-signin', { method: 'POST', body: { url: `http://localhost/?code=good-code&state=${link.searchParams.get('state')}&session_state=x` } });
  await until(() => findBot(/Connected/), 20_000, 'connected message');
  check(true, 'pasting the address signs in; the bridge posts "Connected" in the chat');
  const st = await api('/api/bridge-status');
  check(st.status?.state === 'ok', 'Claude UI knows the bridge state', st);
  check(fs.existsSync(path.join(tmp, 'teams', 'token.json')) && (fs.statSync(path.join(tmp, 'teams', 'token.json')).mode & 0o077) === 0, 'Microsoft tokens are stored private (600)');

  console.log('/new starts a chat; a permission prompt reaches Teams; a reply answers it');
  say('/new demo: @@ask Bash {"command":"ls -la"}');
  const perm = await until(() => findBot(/#1<\/b>[\s\S]*Bash[\s\S]*ls -la/), 15_000, 'permission message');
  check(/Reply to this message/.test(perm.body.content), 'the prompt says how to answer');
  check(findBot(/Started <b>/), 'the bridge confirms the new chat');
  const answerMsg = say('yes', perm.id);
  await until(() => /Answered: allowed/.test(chat.find((m) => m.id === perm.id).body.content), 15_000, 'prompt marked answered');
  check(true, 'the prompt is edited to show the answer');
  check(reactions.includes(answerMsg), 'your reply gets a like');
  const done = await until(() => findBot(/finished:[\s\S]*answer: allowed/), 15_000, 'turn finished message');
  check(done, 'a finished turn of a chat started from Teams is reported');
  const sessions = (await api('/api/sessions')).sessions;
  const sid = sessions.find((s) => s.cwd === fs.realpathSync(repo))?.id;
  check(sid, 'the chat runs in the demo folder', sessions.map((s) => s.cwd));

  console.log('Plain text goes to the same chat; #code answers a question');
  say('@@ask AskUserQuestion {"questions":[{"question":"Colour?","header":"Colour","multiSelect":false,"options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}]}]}');
  const q = await until(() => findBot(/#2<\/b>[\s\S]*Colour\?[\s\S]*2\. Blue/), 15_000, 'question message');
  check(q, 'the question shows numbered options');
  say('#2 2');
  await until(() => findBot(/answer: allowed \{"Colour\?":"Blue"\}/), 15_000, 'question answered with Blue');
  check(true, '"#2 2" answers Blue');

  console.log('A bare "no" with one open request denies it, with the reason');
  say('@@ask Write {"file_path":"/tmp/x","content":"hi"}');
  await until(() => findBot(/#3<\/b>[\s\S]*Write/), 15_000, 'write prompt');
  await sleep(2500); // let the bridge see #3 as open
  say('no not now');
  await until(() => findBot(/answer: denied: The user denied this from Teams: not now/), 15_000, 'denied with reason');
  check(true, 'denied, and Claude gets the reason');

  console.log('Answered in the web UI: the Teams message says so');
  say('@@ask Bash {"command":"rm -rf build"}');
  const p4 = await until(() => findBot(/#4<\/b>[\s\S]*rm -rf build/), 15_000, 'prompt 4');
  const ui = await api(`/api/bridge/attention`, { headers: { authorization: `Bearer ${token}` } });
  const item = ui.items.find((i) => i.id.startsWith('perm:'));
  check(item?.kind === 'permission' && item.tool === 'Bash' && item.detail === 'rm -rf build', 'the attention list has the prompt', ui.items);
  // The web UI answers over the chat socket; stopping the chat denies it the same way (not through the bridge).
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${sid}`, { headers: { cookie, origin: base } });
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  ws.send(JSON.stringify({ t: 'perm', reqId: item.id.split(':')[2], behavior: 'deny' }));
  await until(() => /Answered in the web UI: denied/.test(chat.find((m) => m.id === p4.id).body.content), 15_000, 'UI answer shown');
  check(true, 'the Teams prompt shows "Answered in the web UI"');
  ws.close();
  say('#4 yes');
  await until(() => findBot(/#4 was already answered/), 10_000, 'already answered note');
  check(true, 'a late reply is told it was already answered');

  console.log('notify_user reaches Teams');
  say('@@call ui__notify_user {"text":"Build finished, 2 tests fail"}');
  await until(() => findBot(/Build finished, 2 tests fail/), 15_000, 'notify message');
  check(true, 'notify_user posts to Teams');

  console.log('Projects: a message goes to the coordinator, its reply comes back; decisions');
  const { project } = await api('/api/cprojects', { method: 'POST', body: { name: 'Demo', goal: 'Test', folders: [repo] } });
  say('/project demo: hello coordinator');
  await until(() => findBot(/<b>Demo<\/b>:<br>/), 20_000, 'coordinator reply');
  check(true, 'the coordinator reply is posted');
  const call = (tool, input) => `@@call project__${tool} ${JSON.stringify(input)}`;
  await api(`/api/cprojects/${project.id}/threads`, { method: 'POST', body: { title: 'Thread C', brief: call('request_decision', { question: 'Pick a colour', options: [{ label: 'Red' }, { label: 'Blue' }], recommended: 1 }) } });
  const dec = await until(() => findBot(/needs a decision[\s\S]*Pick a colour[\s\S]*2\. <b>Blue<\/b> \(recommended\)/), 20_000, 'decision message');
  check(dec, 'the decision shows its options and the recommendation');
  const code = /#(\d+)<\/b>/.exec(dec.body.content)[1];
  say('2', dec.id);
  const d = await until(async () => (await api(`/api/cprojects/${project.id}`)).project.decisions.find((x) => x.answer), 15_000, 'decision answered');
  check(d.answer.choice === 1 && d.answer.by?.kind === 'user', 'the decision is answered as you', d.answer);
  await until(() => /Answered: Blue/.test(chat.find((m) => m.id === dec.id).body.content), 10_000, 'decision marked');
  check(true, `decision #${code} is marked answered`);

  console.log('Commands');
  say('/status');
  await until(() => findBot(/<b>Status<\/b>/), 10_000, 'status');
  check(/Demo/.test(findBot(/<b>Status<\/b>/).body.content), '/status lists projects');
  say('/whatever');
  await until(() => findBot(/Here's what I understand/), 10_000, 'help');
  check(true, 'an unknown command shows help');

  console.log('Someone else in the chat is ignored');
  const before = botMsgs().length;
  chat.push({ id: `x${++n}`, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: 'someone-else' } }, body: { content: '/status' }, attachments: [] });
  await sleep(5000);
  check(botMsgs().length === before, 'messages from other people do nothing');

  console.log('Restart keeps state: no second "Connected", old prompts not re-sent');
  bridge.kill();
  await new Promise((r) => bridge.once('exit', r));
  const count = botMsgs().length;
  bridge = spawn(process.execPath, [path.join(root, 'teams-bridge', 'bridge.mjs')], {
    env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: tokenFile, TEAMS_DATA_DIR: path.join(tmp, 'teams'), TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  await sleep(6000);
  check(botMsgs().length === count, 'nothing is re-posted after a restart', botMsgs().slice(count).map((m) => m.body.content));
  check(tokenCalls === 1, 'no new sign-in after a restart (the saved token is reused)', tokenCalls);
}

main()
  .catch((e) => {
    failures++;
    console.error('ERROR', e);
    console.error(bridgeLog.join('').slice(-3000));
    console.error('chat:', JSON.stringify(chat.map((m) => [m.id, m.body.content.slice(0, 160)]), null, 1));
  })
  .finally(async () => {
    // Wait for both to exit before removing their folders (the server writes logs on the way out).
    const gone = (p) => (p && p.exitCode === null && p.signalCode === null ? new Promise((r) => p.once('exit', r)) : null);
    const waits = [gone(bridge), gone(server)];
    bridge?.kill();
    server?.kill('SIGTERM');
    await Promise.race([Promise.all(waits), sleep(5000)]);
    graph.close();
    console.log(`\n${passes} passed, ${failures} failed`);
    if (!failures) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }
    process.exit(failures ? 1 : 0);
  });
