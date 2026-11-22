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
import { Graph } from '../teams-bridge/graph.mjs';

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
const flowMsgs = []; // the chat with the Workflows bot
const chan = []; // channel threads: { ...message, replies: [] }
const flowCards = []; // cards posted to the workflow's webhook
const pings = []; // phone pings
const reactions = [];
const edits = [];
let tokenCalls = 0;
let challenge = '';
let refuseCards = false; // a tenant that doesn't let users post cards // PKCE challenge from the sign-in link the bridge made
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
    if (p === '/ping') {
      pings.push(JSON.parse(data).attachments[0].content);
      return json(res, 202, {});
    }
    if (p === '/flow') {
      flowCards.push(JSON.parse(data).attachments[0].content);
      return json(res, 202, {});
    }
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
    if (p === '/v1.0/me/joinedTeams') return json(res, 200, { value: [{ id: 'T1', displayName: 'Eng' }] });
    if (p === '/v1.0/teams/T1/channels') return json(res, 200, { value: [{ id: 'C1', displayName: 'General' }, { id: 'C2', displayName: 'Claude' }] });
    if (p.startsWith('/v1.0/teams/T1/channels/C2/messages')) {
      const parts = p.slice('/v1.0/teams/T1/channels/C2/messages'.length).split('/').filter(Boolean);
      if (parts.at(-1) === 'setReaction') return json(res, 204, {});
      if (!parts.length && req.method === 'GET') return json(res, 200, { value: [...chan].reverse() });
      const b = data ? JSON.parse(data) : {};
      const mk = () => ({ id: `c${++n}`, webUrl: `https://teams.microsoft.com/l/message/C2/c${n + 1}`, subject: b.subject || null, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: ME.id } }, body: b.body, attachments: b.attachments || [], bot: true, replies: [] });
      if (!parts.length && req.method === 'POST') {
        const m = mk();
        chan.push(m);
        return json(res, 201, m);
      }
      const top = chan.find((x) => x.id === parts[0]);
      if (!top) return json(res, 404, { error: { message: 'no thread' } });
      if (parts[1] === 'replies' && parts.length === 2 && req.method === 'POST') {
        const m = mk();
        delete m.replies;
        top.replies.push(m);
        return json(res, 201, m);
      }
      if (req.method === 'PATCH') {
        const m = parts[2] ? top.replies.find((x) => x.id === parts[2]) : top;
        if (b.subject !== undefined) m.subject = b.subject;
        if (b.body) Object.assign(m, { body: b.body, attachments: b.attachments || [] });
        return json(res, 204, {});
      }
    }
    let m;
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages$/.exec(p))) {
      if (req.method === 'GET' && m[1] === 'flow-chat') return json(res, 200, { value: [...flowMsgs].reverse() });
      if (req.method === 'GET') return json(res, 200, { value: [...chat].reverse().slice(0, Number(url.searchParams.get('$top')) || 20) });
      const b = JSON.parse(data);
      if (refuseCards && b.attachments?.length) return json(res, 403, { error: { message: 'cards not allowed' } });
      const msg = { id: `m${++n}`, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: ME.id } }, body: b.body, attachments: b.attachments || [], bot: true };
      chat.push(msg);
      return json(res, 201, msg);
    }
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages\/([^/]+)\/(setReaction|unsetReaction)$/.exec(p))) {
      const emoji = JSON.parse(data).reactionType;
      if (m[3] === 'setReaction') reactions.push(m[2], `${m[2]}:${emoji}`);
      else reactions.push(`${m[2]}:-${emoji}`);
      return json(res, 204, {});
    }
    if ((m = /^\/v1\.0\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
      const msg = chat.find((x) => x.id === m[2]);
      if (!msg) return json(res, 404, { error: { message: 'gone' } });
      const up = JSON.parse(data);
      msg.body = up.body;
      msg.attachments = up.attachments || [];
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
const textOf = (m) => m.body.content + (m.attachments || []).map((a) => (a.contentType === 'application/vnd.microsoft.card.adaptive' ? a.content : '')).join('');
const findBot = (re) => botMsgs().find((m) => re.test(textOf(m)));
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

  console.log('Graph defaults');
  {
    const g = new Graph({ tenant: 't', clientId: 'c', tokenFile: path.join(tmp, 'none.json'), graphUrl: undefined, loginUrl: undefined });
    check(g.o.loginUrl === 'https://login.microsoftonline.com' && g.o.graphUrl === 'https://graph.microsoft.com/v1.0' && g.browserStart().startsWith('https://login.microsoftonline.com/t/'), 'unset URLs keep the Microsoft defaults (no undefined/ links)');
  }
  console.log('Bridge API is locked');
  const tokenFile = path.join(env.CW_DATA_DIR, 'bridge-token');
  check(fs.existsSync(tokenFile), 'a bridge token is generated');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  check((await api('/api/bridge/attention', { headers: { cookie: '' }, allowError: true })).status === 401, 'no token: refused');
  check((await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}`, origin: 'http://evil' }, allowError: true })).status === 403, 'a browser page: refused');
  const first = (await api('/api/sessions')).sessions.find((x) => x.name === 'Assistant');
  check(first?.pinned, 'the Assistant chat exists and is pinned from the start', first);
  check(first?.permissionMode === 'auto', 'the Assistant starts in Auto mode', first);
  const empty = await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}` } });
  check(Array.isArray(empty.items) && empty.items.length === 0, 'nothing is waiting at start');

  console.log('Start the bridge: device code is blocked, so browser sign-in with a pasted address');
  bridge = spawn(process.execPath, [path.join(root, 'teams-bridge', 'bridge.mjs')], {
    env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: tokenFile, TEAMS_DATA_DIR: path.join(tmp, 'teams'), TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0', TEAMS_AUTH: 'auto', TEAMS_ASSISTANT: '0', TEAMS_CARDS: '0' },
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
  const perm = await until(() => findBot(/Bash[\s\S]*ls -la[\s\S]*Reply to this message/), 15_000, 'permission message');
  check(/Reply to this message/.test(perm.body.content), 'the prompt says how to answer');
  check(findBot(/Started <b>/), 'the bridge confirms the new chat');
  const answerMsg = say('yes', perm.id);
  await until(() => /Answered: allowed/.test(chat.find((m) => m.id === perm.id).body.content), 15_000, 'prompt marked answered');
  check(true, 'the prompt is edited to show the answer');
  check(reactions.includes(`${answerMsg}:✅`), 'your answer gets a ✅');
  const done = await until(() => findBot(/finished:[\s\S]*answer: allowed/), 15_000, 'turn finished message');
  check(done, 'a finished turn of a chat started from Teams is reported');
  const sessions = (await api('/api/sessions')).sessions;
  const sid = sessions.find((s) => s.cwd === fs.realpathSync(repo))?.id;
  check(sid, 'the chat runs in the demo folder', sessions.map((s) => s.cwd));

  console.log('Plain text goes to the same chat; #code answers a question');
  say('@@ask AskUserQuestion {"questions":[{"question":"Colour?","header":"Colour","multiSelect":false,"options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}]}]}');
  const q = await until(() => findBot(/Colour\?[\s\S]*2\. Blue[\s\S]*Reply to this message/), 15_000, 'question message');
  check(q, 'the question shows numbered options');
  say('#2 2');
  await until(() => findBot(/answer: allowed \{"Colour\?":"Blue"\}/), 15_000, 'question answered with Blue');
  check(true, '"#2 2" answers Blue');

  console.log('A bare "no" with one open request denies it, with the reason');
  say('@@ask Write {"file_path":"/tmp/x","content":"hi"}');
  await until(() => findBot(/Write[\s\S]*Reply to this message/), 15_000, 'write prompt');
  await sleep(2500); // let the bridge see #3 as open
  say('no not now');
  await until(() => findBot(/answer: denied: The user denied this from Teams: not now/), 15_000, 'denied with reason');
  check(true, 'denied, and Claude gets the reason');

  console.log('Answered in the web UI: the Teams message says so');
  say('@@ask Bash {"command":"rm -rf build"}');
  const p4 = await until(() => findBot(/rm -rf build[\s\S]*Reply to this message/), 15_000, 'prompt 4');
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
  await until(() => findBot(/That one was already answered/), 10_000, 'already answered note');
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
  say('2', dec.id);
  const d = await until(async () => (await api(`/api/cprojects/${project.id}`)).project.decisions.find((x) => x.answer), 15_000, 'decision answered');
  check(d.answer.choice === 1 && d.answer.by?.kind === 'user', 'the decision is answered as you', d.answer);
  await until(() => /Answered: Blue/.test(chat.find((m) => m.id === dec.id).body.content), 10_000, 'decision marked');
  check(true, 'the decision is marked answered');

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
    env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: tokenFile, TEAMS_DATA_DIR: path.join(tmp, 'teams'), TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0', TEAMS_UI_LINK: 'http://bamba:8787', TEAMS_FLOW_URL: `http://127.0.0.1:${gport}/flow`, TEAMS_FLOW_CHAT_ID: 'flow-chat' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  await sleep(6000);
  check(botMsgs().length === count, 'nothing is re-posted after a restart', botMsgs().slice(count).map((m) => m.body.content));
  check(tokenCalls === 1, 'no new sign-in after a restart (the saved token is reused)', tokenCalls);

  console.log('The Assistant (bridge restarted with it on, the default)');
  say('/new demo: @@ask Bash {"command":"npm test"}');
  const p6 = await until(() => findBot(/Wants to use Bash[\s\S]*npm test/), 15_000, 'npm test card');
  const card6 = JSON.parse(p6.attachments[0].content);
  check(p6.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' && card6.type === 'AdaptiveCard', 'requests are posted as Adaptive Cards');
  check(card6.actions?.[0]?.url?.startsWith('http://bamba:8787/#s='), 'the card links to the chat in the web UI', card6.actions);
  const open6 = (await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}` } })).items.find((i) => i.detail === 'npm test');
  check(open6, 'the prompt is in the attention list');
  say(`what is waiting?<br>@@call assistant__overview {}<br>@@say One thing waits: npm test.`);
  const askMsg = chat.at(-1).id;
  await until(() => findBot(/Claude<\/b> › One thing waits: npm test\./), 20_000, 'assistant reply');
  await until(() => reactions.includes(`${askMsg}:✅`), 5000, 'done reaction');
  check(reactions.indexOf(`${askMsg}:👀`) < reactions.indexOf(`${askMsg}:-👀`) && reactions.indexOf(`${askMsg}:-👀`) < reactions.indexOf(`${askMsg}:✅`), 'your message gets 👀 until the Assistant answers, then ✅', reactions.filter((x) => x.startsWith(askMsg)));
  check(true, 'plain text goes to the Assistant and its reply comes back to Teams');
  const sessions2 = (await api('/api/sessions')).sessions;
  const asst = sessions2.find((x) => x.name === 'Assistant');
  check(asst && asst.model === 'haiku', 'the Assistant is a chat in the web UI, on Haiku', asst);
  const log = fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const overview = log.find((x) => x.call === 'assistant__overview');
  check(overview && /npm test/.test(overview.result), 'its overview tool sees the waiting prompt', overview?.result);
  const argv = log.find((x) => x.argv?.includes('--allowedTools') && x.argv.includes('mcp__assistant__*'))?.argv || [];
  check(argv[argv.indexOf('--tools') + 1] === '', 'the Assistant has no file or shell tools');
  say(`yes run the tests<br>@@call assistant__answer_request {"id":"${open6.id}","quote":"yes run the tests","behavior":"allow"}<br>@@say Done, npm test is running.`);
  await until(() => /Answered: allowed/.test(textOf(chat.find((m) => m.id === p6.id))), 20_000, 'prompt answered by the Assistant');
  check(!JSON.parse(chat.find((m) => m.id === p6.id).attachments[0].content).actions, 'the answered card shows the answer and drops its link');
  check(true, 'the Assistant answers a request when the user clearly said so');
  await until(() => findBot(/Done, npm test is running\./), 10_000, 'assistant confirmation');
  check(true, 'and confirms in Teams');

  console.log('Buttons through a Teams workflow');
  const flowSay = (d) => flowMsgs.push({ id: `f${++n}`, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { application: { displayName: 'Workflows' } }, body: { contentType: 'html', content: `<p>cw:${JSON.stringify(d).replace(/"/g, '&quot;')}</p>` } });
  say('/new demo: @@ask Bash {"command":"npm run build"}');
  const fc = await until(() => flowCards.find((c) => JSON.stringify(c).includes('npm run build')), 15_000, 'workflow card');
  const yes = fc.actions.find((a) => a.title === 'Yes');
  check(yes?.type === 'Action.Submit' && fc.actions.some((a) => a.title === 'No') && fc.body.some((b) => b.type === 'Input.Text'), 'the workflow card has Yes / No buttons and a reason box', fc.actions);
  flowSay({ cw: 'forged', a: 'yes' });
  await sleep(3000);
  check(!findBot(/finished:[\s\S]*npm run build|answer: allowed \{\}[\s\S]*build/), 'an answer without the card secret is ignored');
  const open8 = (await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}` } })).items.find((i) => i.detail === 'npm run build');
  check(open8, 'so the request is still open');
  flowSay({ ...yes.data, text: '' });
  await until(async () => !(await api('/api/bridge/attention', { headers: { authorization: `Bearer ${token}` } })).items.some((i) => i.detail === 'npm run build'), 15_000, 'answered by the button');
  check(true, 'tapping Yes in the workflow card allows it');
  say(`/new demo: @@ask AskUserQuestion {"questions":[{"question":"Size?","options":[{"label":"S"},{"label":"M"},{"label":"L"}]}]}`);
  const qc = await until(() => flowCards.find((c) => JSON.stringify(c).includes('Size?')), 15_000, 'question workflow card');
  check(qc.body.some((b) => b.type === 'Input.ChoiceSet' && b.choices.length === 3), 'a question becomes a choice list');
  flowSay({ ...qc.actions[0].data, q0: '3', o0: '' });
  await until(() => findBot(/answer: allowed \{\\*"Size\?\\*":\\*"L\\*"\}/), 15_000, 'question answered L');
  check(true, 'picking an option and Send answers the question');

  console.log('A tenant that refuses cards gets formatted text');
  refuseCards = true;
  say('/new demo: @@ask Bash {"command":"make lint"}');
  const p7 = await until(() => findBot(/wants to use <b>Bash<\/b>:<br><code>make lint<\/code>/), 15_000, 'text fallback');
  check(!p7.attachments.length, 'the request falls back to a text message');
  refuseCards = false;

  console.log('Channel mode: one thread per chat');
  {
    const gone = new Promise((r) => bridge.once('exit', r));
    bridge.kill();
    await gone;
    const dir2 = path.join(tmp, 'teams'); // the same state as in chat mode: switching must start fresh
    bridge = spawn(process.execPath, [path.join(root, 'teams-bridge', 'bridge.mjs')], {
      env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: tokenFile, TEAMS_DATA_DIR: dir2, TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0', TEAMS_CHANNEL: 'Eng / Claude', TEAMS_PING_URL: `http://127.0.0.1:${gport}/ping` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bridge.stdout.on('data', (d) => bridgeLog.push(String(d)));
    bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
    const txt = (m) => m.body.content + (m.attachments || []).map((a) => a.content || '').join('');
    await until(() => chan.find((m) => /Connected\. Each project and chat gets its own thread/.test(m.body.content)), 15_000, 'channel connected');
    check(true, 'switching from a chat to a channel: the bridge finds it by name and says hello there');
    const chanSay = (text, rootId) => {
      const m = { id: `u${++n}`, messageType: 'message', createdDateTime: new Date(Date.now() + n).toISOString(), from: { user: { id: ME.id } }, body: { contentType: 'html', content: `<p>${text}</p>` }, attachments: [], replies: [] };
      if (rootId) chan.find((x) => x.id === rootId).replies.push(m);
      else chan.push(m);
      return m.id;
    };
    const t1 = chanSay('/new demo: @@ask Bash {"command":"make docs"}');
    const thread = () => chan.find((x) => x.id === t1);
    await until(() => thread().replies.some((m) => /make docs/.test(txt(m)) && /Wants to use Bash/.test(txt(m))), 15_000, 'request in the thread');
    check(thread().replies.some((m) => /Started/.test(txt(m))), 'the new chat is confirmed in the same thread');
    check(true, "the chat's request is posted in its thread");
    const pg = await until(() => pings.find((c) => JSON.stringify(c).includes('make docs')), 10_000, 'ping');
    const req = thread().replies.find((m) => /Wants to use Bash/.test(txt(m)));
    check(pg.actions?.[0]?.url === req.webUrl, 'the phone ping links to the request in Teams', pg.actions);
    chanSay('yes', t1);
    await until(() => thread().replies.some((m) => /finished/.test(txt(m)) && /answer: allowed/.test(txt(m))), 15_000, 'finished in thread');
    check(true, 'yes in the thread answers it, and the result comes back in the same thread');
    chanSay('now the readme<br>@@say continued in the thread', t1);
    await until(() => thread().replies.some((m) => /continued in the thread/.test(txt(m))), 15_000, 'follow-up in thread');
    check(true, 'other text in the thread goes to that chat');
    const t2 = chanSay('what is going on?<br>@@say Nothing waits on you.');
    await until(() => chan.find((x) => x.id === t2).replies.some((m) => /Nothing waits on you\./.test(txt(m))), 20_000, 'assistant reply in thread');
    check(true, "a new post goes to the Assistant, and its answer is a reply under that post");
    const docsChat = (await api('/api/sessions')).sessions.find((x) => /make docs/.test(x.name));
    const t3 = chanSay(`ask the docs chat<br>@@call assistant__message_chat {"chat":"${docsChat.id}","text":"@@say relayed answer here"}<br>@@say I asked it.`);
    await until(() => chan.find((x) => x.id === t3).replies.some((m) => /relayed answer here/.test(txt(m))), 20_000, 'relayed answer in the asking thread');
    check(true, 'a chat the Assistant asked answers in the thread where you asked');
    check(thread().subject && /make docs|ask Bash/.test(thread().subject), "the chat's thread is named after the chat", thread().subject);
    chanSay('/project demo: hello from the channel');
    const pt = await until(() => chan.find((m) => m.bot && m.subject === 'Demo'), 20_000, 'project thread');
    check(/<b>Demo<\/b>/.test(pt.body.content) || pt.attachments.length, "the coordinator's reply starts a thread named after the project");
  }

}

main()
  .catch((e) => {
    failures++;
    console.error('ERROR', e);
    console.error(bridgeLog.join('').slice(-3000));
    console.error("chat:", JSON.stringify(chat.slice(-8).map((m) => [m.id, m.body.content.slice(0, 200)]), null, 1));
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
