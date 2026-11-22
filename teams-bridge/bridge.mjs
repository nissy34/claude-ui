#!/usr/bin/env node
// Teams bridge for Claude UI: talk to your agents from a Microsoft Teams chat.
//
// It runs next to the server (same machine or container network) and only makes outbound calls:
// it polls one Teams chat through Microsoft Graph for what you write, and long-polls Claude UI's
// attention feed (/api/bridge/*) for what is waiting on you. Nothing needs to reach it from outside.
//
//   node teams-bridge/bridge.mjs          run (signs in with a device code the first time)
//   node teams-bridge/bridge.mjs chats    list your chats, to pick TEAMS_CHAT_ID
//
// Settings are environment variables; see teams-bridge/README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Graph } from './graph.mjs';
import { HELP, TAG, askHtml, esc, parseCommand, permissionReply, plain, postHtml, resolvedHtml } from './text.mjs';

const env = process.env;
const home = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const dataDir = home(env.CW_DATA_DIR || '~/.claude-web');
const cfg = {
  tenant: env.TEAMS_TENANT_ID || 'organizations',
  clientId: env.TEAMS_CLIENT_ID || '',
  chatId: env.TEAMS_CHAT_ID || '48:notes',
  ui: (env.CLAUDE_UI_URL || `http://127.0.0.1:${env.CW_PORT || 8787}`).replace(/\/$/, ''),
  token: env.CW_BRIDGE_TOKEN || '',
  tokenFile: home(env.CW_BRIDGE_TOKEN_FILE || path.join(dataDir, 'bridge-token')),
  dir: home(env.TEAMS_DATA_DIR || path.join(dataDir, 'teams-bridge')),
  pollMs: Math.max(Number(env.TEAMS_POLL_SECONDS) || 5, 2) * 1000,
  awayMs: (env.TEAMS_AWAY_MINUTES === undefined ? 5 : Number(env.TEAMS_AWAY_MINUTES) || 0) * 60_000,
  allowPermissions: env.TEAMS_ALLOW_PERMISSIONS !== '0',
  defaultProject: env.TEAMS_DEFAULT_PROJECT || '',
  pingUrl: env.TEAMS_PING_URL || '',
  graphUrl: env.TEAMS_GRAPH_URL,
  loginUrl: env.TEAMS_LOGIN_URL,
  auth: ['auto', 'device', 'browser'].includes(env.TEAMS_AUTH) ? env.TEAMS_AUTH : 'browser',
  redirectUri: env.TEAMS_REDIRECT_URI || 'http://localhost',
};
fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
if (!cfg.token) {
  try {
    cfg.token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
  } catch {}
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state (survives restarts) ----------
const STATE_FILE = path.join(cfg.dir, 'state.json');
let st = { sent: {}, items: {}, codes: {}, nextCode: 1, target: null, seen: [], started: false };
try {
  st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch {}
let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Keep it small: the last 300 messages and items.
    const trim = (o) => Object.fromEntries(Object.entries(o).slice(-300));
    st.sent = trim(st.sent);
    st.items = trim(st.items);
    st.seen = st.seen.slice(-500);
    fs.writeFileSync(STATE_FILE, JSON.stringify(st), { mode: 0o600 });
  }, 200);
};

// ---------- Claude UI ----------
async function ui(method, p, body) {
  const res = await fetch(cfg.ui + p, { method, headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
  return j;
}

let authNoticeKey = '';
async function reportAuth(info) {
  log(`[auth] ${info.message}${info.url && info.state === 'signin-browser' ? `\n  ${info.url}\n  Paste the address the browser ends on in the web UI (Settings > Teams), or run: node teams-bridge/bridge.mjs login` : ''}`);
  // Show sign-in steps in the web UI too, so nobody has to read container logs.
  const key = `${info.state}:${info.code || ''}:${info.url || ''}:${info.state === 'signin-error' ? info.message : ''}`;
  if (key === authNoticeKey) return;
  authNoticeKey = key;
  await ui('POST', '/api/bridge/status', { state: info.state, message: info.message, code: info.code || null, url: info.url || null }).catch(() => {});
}

// ---------- Teams ----------
// Browser sign-in: you paste the address the browser ends on in the web UI (Teams bridge sign-in page),
// or in the terminal with `bridge.mjs login`. The bridge picks it up from Claude UI.
async function waitForReply() {
  try {
    const r = await ui('GET', '/api/bridge/signin-reply?wait=20');
    return r.url || null;
  } catch {
    await new Promise((res) => setTimeout(res, 3000));
    return null;
  }
}
const graph = new Graph({ tenant: cfg.tenant, clientId: cfg.clientId, tokenFile: path.join(cfg.dir, 'token.json'), graphUrl: cfg.graphUrl, loginUrl: cfg.loginUrl, auth: cfg.auth, redirectUri: cfg.redirectUri, waitForReply, onAuth: reportAuth });
let me = null;

async function post(html, meta) {
  const m = await graph.send(cfg.chatId, html);
  st.sent[m.id] = { ...meta, html };
  st.seen.push(m.id);
  save();
  return m.id;
}

async function ping(title, text) {
  if (!cfg.pingUrl) return;
  try {
    // The shape Teams Workflows' "Post to a chat when a webhook request is received" template reads:
    // a message with an Adaptive Card. Its post comes from the Workflows bot, so your phone rings.
    const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: String(text).slice(0, 500), wrap: true }] };
    await fetch(cfg.pingUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', title, text: String(text).slice(0, 500), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }) });
  } catch (e) {
    log('[ping] failed:', e.message);
  }
}

async function react(messageId) {
  try {
    await graph.call('POST', `/chats/${encodeURIComponent(cfg.chatId)}/messages/${encodeURIComponent(messageId)}/setReaction`, { reactionType: 'like' });
    return true;
  } catch {
    return false;
  }
}

const targetName = (t) => (t ? `${t.type === 'project' ? 'project ' : ''}${t.name}` : 'nobody yet');

// ---------- what is waiting on you ----------
let lastSeen = 0; // the web UI was last used at
const held = new Map(); // item id -> item, waiting until you are away from the web UI
const away = () => !cfg.awayMs || Date.now() - lastSeen > cfg.awayMs;

async function sendAsk(item) {
  if (st.items[item.id]) return;
  const code = st.nextCode++;
  st.codes[code] = item.id;
  st.items[item.id] = { code, kind: item.kind, open: true, msg: null };
  const id = await post(askHtml(item, code, cfg), { kind: 'ask', item: item.id });
  st.items[item.id].msg = id;
  save();
  await ping(`#${code} needs you`, item.question || item.questions?.[0]?.question || item.detail || item.tool || item.server || '');
}

async function onAsk(item) {
  if (st.items[item.id]) return;
  if (away()) await sendAsk(item);
  else held.set(item.id, item);
}

async function onResolved(ev) {
  held.delete(ev.id);
  const it = st.items[ev.id];
  if (!it || !it.open) return;
  it.open = false;
  save();
  const sent = it.msg && st.sent[it.msg];
  if (!sent) return;
  try {
    await graph.edit(cfg.chatId, it.msg, resolvedHtml(sent.html, ev.answer, ev.by));
  } catch (e) {
    // Editing can be refused (policy, old message). Confirm your own answers with a short line instead.
    if (ev.by === 'bridge') await post(`${TAG} ✓ #${it.code}: ${esc(ev.answer)}`, { kind: 'note' });
  }
}

async function onEvent(ev) {
  if (env.TEAMS_DEBUG) log('[event]', JSON.stringify(ev).slice(0, 300));
  if (ev.type === 'ask') return onAsk(ev.item);
  if (ev.type === 'resolved') return onResolved(ev);
  if (ev.type === 'notify' || ((ev.type === 'post' || ev.type === 'turn') && away())) {
    const target = ev.type === 'post' ? { type: 'project', id: ev.project.id, name: ev.project.name } : { type: 'chat', id: ev.session.id, name: ev.session.name };
    await post(postHtml(ev), { kind: 'target', target });
    if (ev.type !== 'turn') await ping(target.name, ev.text);
  }
}

async function uiLoop() {
  let seq = null;
  for (;;) {
    try {
      if (seq === null) {
        const a = await ui('GET', '/api/bridge/attention');
        lastSeen = a.lastSeen || 0;
        const open = new Set(a.items.map((i) => i.id));
        // Anything we showed as open that was answered while we were down.
        for (const [id, it] of Object.entries(st.items)) if (it.open && !open.has(id)) await onResolved({ id, answer: 'answered', by: 'ui' });
        for (const item of a.items) await onAsk(item);
        seq = a.seq || 0;
      }
      const r = await ui('GET', `/api/bridge/events?after=${seq}&wait=25`);
      lastSeen = r.lastSeen || lastSeen;
      if (r.seq < seq) {
        seq = null; // the server restarted: start over from the open list
        continue;
      }
      for (const ev of r.events) {
        try {
          await onEvent(ev);
        } catch (e) {
          log('[event] failed:', ev.type, e.message);
        }
      }
      seq = r.seq;
    } catch (e) {
      log('[ui]', e.message);
      if (e.status === 401) log('[ui] wrong bridge token: set CW_BRIDGE_TOKEN or CW_BRIDGE_TOKEN_FILE');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Held requests go out once you have been away from the web UI for TEAMS_AWAY_MINUTES.
async function flushHeld() {
  if (!held.size || !away()) return;
  for (const [id, item] of [...held]) {
    held.delete(id);
    await sendAsk(item).catch((e) => log('[ask] failed:', e.message));
  }
}

// ---------- what you write ----------
async function answer(itemId, text, msgId) {
  const it = st.items[itemId];
  if (!it) return post(`${TAG} I don't know that request.`, { kind: 'note' });
  if (!it.open) return post(`${TAG} #${it.code} was already answered.`, { kind: 'note' });
  const body = { id: itemId, text };
  if (it.kind === 'permission' || it.kind === 'plan' || it.kind === 'signin') {
    if (!cfg.allowPermissions && it.kind !== 'signin') return post(`${TAG} Approving from Teams is turned off. Answer #${it.code} in the web UI.`, { kind: 'note' });
    const r = permissionReply(text);
    if (!r) return post(`${TAG} For #${it.code}, reply <b>yes</b>${it.kind === 'permission' ? ', <b>always</b>' : ''} or <b>no</b>.`, { kind: 'note' });
    if (it.kind === 'signin') body.behavior = r.behavior === 'deny' ? 'decline' : 'accept';
    else Object.assign(body, r);
  } else if (/^(skip|\/skip|no answer)$/i.test(text.trim()) && it.kind === 'question') {
    body.behavior = 'deny';
  }
  try {
    const r = await ui('POST', '/api/bridge/answer', body);
    if (r.already) {
      it.open = false;
      save();
      return post(`${TAG} #${it.code} was already answered.`, { kind: 'note' });
    }
    if (msgId) await react(msgId);
  } catch (e) {
    await post(`${TAG} Couldn't answer #${it.code}: ${esc(e.message)}`, { kind: 'note' });
  }
}

async function sendTo(target, text, msgId) {
  try {
    const r = target.type === 'project' ? await ui('POST', '/api/bridge/act', { action: 'project_send', project: target.id, text }) : await ui('POST', '/api/bridge/act', { action: 'send', chat: target.id, text });
    st.target = r.target || target;
    save();
    if (!(msgId && (await react(msgId)))) await post(`${TAG} Sent to ${esc(targetName(st.target))}.`, { kind: 'note' });
  } catch (e) {
    await post(`${TAG} Couldn't send to ${esc(targetName(target))}: ${esc(e.message)}`, { kind: 'note' });
  }
}

const openAsks = () => Object.entries(st.items).filter(([, it]) => it.open);

async function defaultTarget() {
  if (st.target) return st.target;
  const s = await ui('POST', '/api/bridge/act', { action: 'status' });
  const projects = (s.projects || []).filter((p) => !p.archived);
  const pick = cfg.defaultProject ? projects.find((p) => p.name.toLowerCase() === cfg.defaultProject.toLowerCase() || p.id === cfg.defaultProject) : projects.length === 1 ? projects[0] : null;
  return pick ? { type: 'project', id: pick.id, name: pick.name } : null;
}

async function handle(msg) {
  const ref = (msg.attachments || []).find((a) => a.contentType === 'messageReference');
  const text = plain(msg.body?.content || '');
  if (!text) return;
  // A reply to one of our messages answers it, or continues that conversation.
  if (ref && st.sent[ref.id]) {
    const s = st.sent[ref.id];
    if (s.kind === 'ask') return answer(s.item, text, msg.id);
    if (s.kind === 'target') return sendTo(s.target, text, msg.id);
  }
  const c = parseCommand(text);
  switch (c.cmd) {
    case 'answer': {
      const id = st.codes[c.code];
      if (!id) return post(`${TAG} There's no #${c.code}.`, { kind: 'note' });
      return answer(id, c.text, msg.id);
    }
    case 'help':
    case 'unknown':
      return post(HELP, { kind: 'note' });
    case 'new': {
      if (!c.folder || !c.text) return post(`${TAG} Write it as <b>/new folder: what to do</b>.`, { kind: 'note' });
      try {
        const r = await ui('POST', '/api/bridge/act', { action: 'new_chat', folder: c.folder, text: c.text });
        st.target = r.target;
        save();
        return post(`${TAG} Started <b>${esc(r.target.name)}</b>. I'll tell you when it finishes; plain text now goes there.`, { kind: 'target', target: r.target });
      } catch (e) {
        return post(`${TAG} Couldn't start it: ${esc(e.message)}`, { kind: 'note' });
      }
    }
    case 'project': {
      if (!c.project) return post(`${TAG} Write it as <b>/project name: message</b>.`, { kind: 'note' });
      if (!c.text) return switchTo(c.project, 'project');
      return sendTo({ type: 'project', id: c.project, name: c.project }, c.text, msg.id);
    }
    case 'to':
      return switchTo(c.name);
    case 'status': {
      const s = await ui('POST', '/api/bridge/act', { action: 'status' });
      const lines = [`${TAG} <b>Status</b> · plain text goes to ${esc(targetName(st.target))}`];
      for (const p of (s.projects || []).filter((x) => !x.archived)) lines.push(`• <b>${esc(p.name)}</b>: ${p.coordinatorWorking ? 'coordinator working, ' : ''}${Object.entries(p.byStatus || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'no threads'}${p.needsUser ? `, <b>${p.needsUser} need you</b>` : ''}`);
      for (const ch of s.busyChats || []) lines.push(`• Chat <b>${esc(ch.name)}</b>: working`);
      lines.push(`${s.waiting} request(s) waiting on you${s.waiting ? ' (/waiting)' : ''}.`);
      return post(lines.join('<br>'), { kind: 'note' });
    }
    case 'waiting': {
      const a = await ui('GET', '/api/bridge/attention');
      if (!a.items.length) return post(`${TAG} Nothing is waiting on you.`, { kind: 'note' });
      for (const item of a.items) {
        const it = st.items[item.id];
        if (!it) await sendAsk(item);
        else await post(askHtml(item, it.code, cfg), { kind: 'ask', item: item.id });
      }
      return;
    }
    case 'folders': {
      const f = await ui('POST', '/api/bridge/act', { action: 'folders' });
      return post(`${TAG} Folders:<br>${(f.projects || []).slice(0, 30).map((x) => `• ${esc(x.name)}`).join('<br>')}`, { kind: 'note' });
    }
    case 'stop': {
      const name = c.name || (st.target?.type === 'chat' ? st.target.id : '');
      if (!name) return post(`${TAG} Which chat? <b>/stop name</b>`, { kind: 'note' });
      try {
        const r = await ui('POST', '/api/bridge/act', { action: 'stop', chat: name });
        return post(`${TAG} ${esc(r.target?.name || name)}: ${esc(r.note || 'stopped')}`, { kind: 'note' });
      } catch (e) {
        return post(`${TAG} ${esc(e.message)}`, { kind: 'note' });
      }
    }
    default: {
      // A bare "yes" / "2" with exactly one open request answers it.
      const open = openAsks();
      if (open.length === 1 && (permissionReply(c.text) || /^\d+$/.test(c.text.trim()))) return answer(open[0][0], c.text, msg.id);
      const t = await defaultTarget().catch(() => null);
      if (!t) return post(`${TAG} Who should get this? Use <b>/project name: …</b>, <b>/new folder: …</b> or <b>/to name</b>.`, { kind: 'note' });
      return sendTo(t, c.text, msg.id);
    }
  }
}

async function switchTo(name, only) {
  if (!name) return post(`${TAG} Plain text goes to ${esc(targetName(st.target))}.`, { kind: 'note' });
  const s = await ui('POST', '/api/bridge/act', { action: 'status' });
  const lower = name.toLowerCase();
  const p = (s.projects || []).find((x) => x.id === name || x.name.toLowerCase() === lower) || (s.projects || []).filter((x) => x.name.toLowerCase().includes(lower))[0];
  if (p) st.target = { type: 'project', id: p.id, name: p.name };
  else if (only !== 'project') st.target = { type: 'chat', id: name, name };
  else return post(`${TAG} No project "${esc(name)}".`, { kind: 'note' });
  save();
  return post(`${TAG} Plain text now goes to ${esc(targetName(st.target))}.`, { kind: 'target', target: st.target });
}

async function teamsLoop() {
  for (;;) {
    try {
      const r = await graph.recent(cfg.chatId, 20);
      const msgs = (r.value || []).filter((m) => m.messageType === 'message' && !m.deletedDateTime).sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
      const seen = new Set(st.seen);
      if (!st.started) {
        // First run: everything already in the chat is history.
        st.seen.push(...msgs.map((m) => m.id));
        st.started = true;
        save();
        await post(`${TAG} Connected. I'll post here when something needs you.<br>${HELP.split('<br>').slice(1).join('<br>')}`, { kind: 'note' });
      } else {
        for (const m of msgs) {
          if (seen.has(m.id) || st.sent[m.id]) continue;
          st.seen.push(m.id);
          save();
          if (m.from?.user?.id && me && m.from.user.id !== me.id) continue; // only you
          try {
            await handle(m);
          } catch (e) {
            log('[teams] handling failed:', e.message);
            await post(`${TAG} Something went wrong: ${esc(e.message)}`, { kind: 'note' }).catch(() => {});
          }
        }
      }
      await flushHeld();
    } catch (e) {
      log('[teams]', e.message);
      if (e.status === 404 || e.status === 403) log(`[teams] can't read chat ${cfg.chatId}. Run "node teams-bridge/bridge.mjs chats" and set TEAMS_CHAT_ID.`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

// ---------- main ----------
async function main() {
  if (!cfg.clientId) {
    console.error('Set TEAMS_CLIENT_ID (and TEAMS_TENANT_ID) to your Entra app registration. See teams-bridge/README.md.');
    process.exit(1);
  }
  if (process.argv[2] === 'login') {
    // Sign in from a terminal: open the link anywhere, paste back the address the browser ends on.
    const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((r) => rl.question(q, r));
    for (;;) {
      console.log(`\nOpen this link in a browser where you can sign in with your work account:\n\n${graph.browserStart()}\n`);
      console.log(`After signing in, the browser tries to open ${cfg.redirectUri}/?code=… and shows an error page. That's expected.`);
      const reply = await ask('Paste that whole address here: ');
      try {
        await graph.browserFinish(reply);
        const who = await graph.me();
        console.log(`Signed in as ${who.displayName}. A running bridge picks this up within a few seconds.`);
        break;
      } catch (e) {
        console.log(`\n${e.message}`);
      }
    }
    rl.close();
    return;
  }
  if (process.argv[2] === 'chats') {
    const r = await graph.chats();
    for (const c of r.value || []) {
      const who = (c.members || []).map((m) => m.displayName).filter(Boolean).join(', ');
      console.log(`${c.id}\t${c.chatType}\t${c.topic || who || '(no name)'}`);
    }
    console.log('\nYour own "chat with yourself" is 48:notes (the default).');
    return;
  }
  if (!cfg.token) {
    console.error(`No bridge token: set CW_BRIDGE_TOKEN, or point CW_BRIDGE_TOKEN_FILE at Claude UI's ${path.join(dataDir, 'bridge-token')}.`);
    process.exit(1);
  }
  me = await graph.me();
  log(`signed in as ${me.displayName}; chat ${cfg.chatId}; Claude UI ${cfg.ui}`);
  await reportAuth({ state: 'ok', message: `Teams bridge connected as ${me.displayName}.` });
  graph.keepAlive();
  await Promise.all([uiLoop(), teamsLoop()]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

