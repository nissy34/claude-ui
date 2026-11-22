#!/usr/bin/env node
// A recorded walkthrough of the Teams bridge in channel mode: the top of the channel is the
// coordinator (the Assistant), and each chat answers in its own thread. Runs Claude UI and the bridge
// against the scripted fake CLI and a fake Microsoft Graph, shows the fake channel in a small viewer
// page, and saves screenshots plus a video of it.
//
//   npm run build && node scripts/teams-demo.mjs [out-dir]
//
// Nothing here talks to Microsoft: the channel is the fake Graph's, drawn like a Teams channel.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'teams-demo'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-teams-demo-'));
const port = 19600 + Math.floor(Math.random() * 300);
const gport = port + 400;
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'web-app');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# web-app\n');
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

// What the fake CLI does for each message (the Assistant and the chats get the same rules; their
// messages never overlap).
const script = [
  // Chats started in the web UI before the walkthrough.
  { match: 'fix the flaky login test', run: ['@@writetool src/auth/session.ts export const setCookieFirst = true;', '@@say Fixed the flaky login test. The session cookie was set after the redirect, so the test sometimes ran before it existed. I moved it before the redirect, and the test passed 50 runs in a row.'] },
  { match: 'upgrade the dependencies', run: ['@@bash npm outdated', '@@sleep 900000'] },
  // The Assistant, at the top of the channel.
  { match: 'what is running', run: ['@@call assistant__overview {}', '@@say Two chats. Upgrade dependencies is still working (npm outdated). Fix flaky login test is done: it fixed a session cookie race. Nothing is waiting on you.'] },
  { match: 'login test fix go', run: ['@@call assistant__open_thread {"chat":"Fix flaky login test"}', "@@say It's done: the cookie was set after the redirect, and moving it first made the test pass 50 runs in a row. Ask it anything in its thread."] },
  // The chat, in its own thread.
  { match: 'which files did you change', run: ['@@say Only src/auth/session.ts: the cookie is now set before the redirect. The test itself needed no change.'] },
  { match: 'run the whole e2e suite', run: ['@@approve Bash {"command":"npm run test:e2e"}', '@@bash npm run test:e2e', '@@sleep 9000', '@@say All 214 e2e tests pass (3m 12s). Ready to merge.'] },
  { match: 'how far along', run: ['@@say It just finished: 214 of 214 passed, nothing flaky this time.'] },
];
fs.writeFileSync(path.join(tmp, 'script.json'), JSON.stringify(script));

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CW_BRIDGE_STATUS_MS: '1000',
  FAKE_CLAUDE_SCRIPT: path.join(tmp, 'script.json'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------- fake Graph: one channel ----------
const ME = { id: 'user-me', displayName: 'Nissan' };
const chan = [];
const reactions = {}; // message id -> Set of emoji
let n = 0;
let caption = '';
let selected = null;
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const find = (id) => chan.find((x) => x.id === id) || chan.flatMap((x) => x.replies).find((x) => x.id === id);
const graph = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/view') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(VIEW);
    }
    if (p === '/state') return json(res, 200, { chan, reactions: Object.fromEntries(Object.entries(reactions).map(([k, v]) => [k, [...v]])), caption, selected });
    if (p === '/v1.0/me') return json(res, 200, ME);
    if (p === '/v1.0/me/joinedTeams') return json(res, 200, { value: [{ id: 'T1', displayName: 'Claudia' }] });
    if (p === '/v1.0/teams/T1/channels') return json(res, 200, { value: [{ id: 'C1', displayName: 'Claudia In Bamba' }] });
    const pre = '/v1.0/teams/T1/channels/C1/messages';
    if (!p.startsWith(pre)) return json(res, 404, { error: { message: `no route ${p}` } });
    const parts = p.slice(pre.length).split('/').filter(Boolean);
    const b = data ? JSON.parse(data) : {};
    if (parts.at(-1) === 'setReaction' || parts.at(-1) === 'unsetReaction') {
      const id = parts.at(-2);
      const set = (reactions[id] ||= new Set());
      parts.at(-1) === 'setReaction' ? set.add(b.reactionType) : set.delete(b.reactionType);
      return json(res, 204, {});
    }
    if (parts.at(-1) === 'softDelete') {
      const m = find(parts.at(-2));
      if (m) m.deletedDateTime = new Date().toISOString();
      return json(res, 204, {});
    }
    if (!parts.length && req.method === 'GET') return json(res, 200, { value: [...chan].reverse() });
    const mk = () => ({ id: `c${++n}`, webUrl: `https://teams.microsoft.com/l/message/C1/c${n}`, subject: b.subject || null, messageType: 'message', createdDateTime: new Date().toISOString(), from: { user: { id: ME.id, displayName: ME.displayName } }, body: b.body, attachments: b.attachments || [], bot: true, replies: [] });
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
      if (b.body) Object.assign(m, { body: b.body, attachments: b.attachments || [], edited: true });
      return json(res, 204, {});
    }
    json(res, 404, { error: { message: `no route ${req.method} ${p}` } });
  });
});

/** You write in the channel: a new post, or a reply in a thread. */
function say(text, rootId) {
  const m = { id: `u${++n}`, messageType: 'message', createdDateTime: new Date().toISOString(), from: { user: { id: ME.id, displayName: ME.displayName } }, body: { contentType: 'html', content: `<p>${text}</p>` }, attachments: [], replies: [] };
  if (rootId) chan.find((x) => x.id === rootId).replies.push(m);
  else chan.push(m);
  return m.id;
}
const textOf = (m) => m.body.content + (m.attachments || []).map((a) => a.content || '').join('');

// ---------- the viewer: the fake channel drawn like a Teams channel ----------
const VIEW = `<!doctype html><html><head><meta charset="utf-8"><title>Channel</title><style>
:root{--bg:#f5f5f5;--card:#fff;--line:#e0e0e0;--ink:#242424;--sub:#616161;--accent:#5b5fc7;--soft:#ebebf7}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg);height:100vh;display:flex;flex-direction:column}
header{background:#fff;border-bottom:1px solid var(--line);padding:10px 18px;display:flex;align-items:center;gap:12px}
header .av{width:32px;height:32px;border-radius:6px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700}
header b{font-size:16px}header span{color:var(--sub)}
.cap{background:#1f1f3a;color:#fff;padding:9px 18px;font-size:15px;font-weight:600;min-height:40px}
main{flex:1;display:flex;min-height:0}
.feed{flex:1.15;overflow:auto;padding:16px 22px;display:flex;flex-direction:column;gap:14px}
.pane{flex:1;border-left:1px solid var(--line);background:#fff;display:flex;flex-direction:column;min-width:0}
.pane h3{margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-size:15px}
.pane .list{flex:1;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.post{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.post.sel{outline:2px solid var(--accent)}
.msg{display:flex;gap:10px;padding:10px 14px}
.msg .av{flex:none;width:30px;height:30px;border-radius:50%;background:#c8c6f0;color:#2b2a6b;display:grid;place-items:center;font-weight:700;font-size:12px}
.who{font-size:12px;color:var(--sub)}.who b{color:var(--ink);font-weight:600;margin-right:6px}
.subj{font-weight:700;font-size:15px;margin:2px 0}
.body{word-wrap:break-word}.body p{margin:0}.body code{background:#f0f0f0;padding:0 3px;border-radius:3px}
.reps{border-top:1px solid var(--line);background:#fafafa}
.reps .msg{padding:8px 14px 8px 54px}
.more{padding:6px 14px 6px 54px;color:var(--accent);font-size:13px;border-top:1px solid var(--line)}
.rx{display:inline-flex;gap:4px;margin-top:4px}.rx span{background:var(--soft);border-radius:10px;padding:0 6px;font-size:12px}
.card{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-top:2px;background:#fff;max-width:520px}
.card .tb{margin:2px 0}.card .sm{font-size:12px}.card .sub{color:var(--sub)}.card .b{font-weight:600}.card .md{font-size:15px}
.card .warn{color:#bc4b09}.card .good{color:#0e7a0b}.card .attn{color:#c4314b}
.card .code{background:#f3f3f3;border-radius:4px;padding:6px 8px;font-family:Consolas,monospace;font-size:12px;margin:4px 0}
.card .btn{display:inline-block;margin-top:8px;border:1px solid var(--line);border-radius:4px;padding:3px 10px;font-size:13px}
.del{color:var(--sub);font-style:italic}
.edited{color:var(--sub);font-size:11px;margin-left:6px}
</style></head><body>
<header><div class="av">C</div><div><b>Claudia In Bamba</b><br><span>Claudia · Posts</span></div></header>
<div class="cap" id="cap"></div>
<main><div class="feed" id="feed"></div><div class="pane" id="pane" style="display:none"><h3 id="ph"></h3><div class="list" id="pl"></div></div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function el(e){switch(e.type){
case 'TextBlock':{const c=['tb'];if(e.size==='Small')c.push('sm');if(e.size==='Medium')c.push('md');if(e.isSubtle)c.push('sub');if(e.weight==='Bolder')c.push('b');if(e.color==='Warning')c.push('warn');if(e.color==='Good')c.push('good');if(e.color==='Attention')c.push('attn');if(e.fontType==='Monospace')return '<div class="code">'+esc(e.text)+'</div>';return '<div class="'+c.join(' ')+'">'+esc(e.text).replace(/\\n/g,'<br>')+'</div>'}
case 'Container':return (e.items||[]).map(el).join('');
case 'FactSet':return (e.facts||[]).map(f=>'<div class="tb sm"><b>'+esc(f.title)+'</b> '+esc(f.value)+'</div>').join('');
default:return ''}}
function card(c){try{c=typeof c==='string'?JSON.parse(c):c}catch{return ''}return '<div class="card">'+(c.body||[]).map(el).join('')+(c.actions||[]).map(a=>'<span class="btn">'+esc(a.title)+'</span>').join(' ')+'</div>'}
function body(m){if(m.deletedDateTime)return '<span class="del">This message has been deleted.</span>';const cards=(m.attachments||[]).filter(a=>a.contentType==='application/vnd.microsoft.card.adaptive');let h=m.body.content.replace(/<attachment[^>]*><\\/attachment>/g,'');const q=(m.attachments||[]).find(a=>a.contentType==='messageReference');if(q){try{const j=JSON.parse(q.content);h='<div style="border-left:3px solid #c8c6f0;padding-left:8px;color:#616161;font-size:12px;margin-bottom:4px">'+esc(j.messagePreview)+'</div>'+h}catch{}}return h+cards.map(a=>card(a.content)).join('')}
function msg(m,rx){const r=(rx[m.id]||[]);return '<div class="msg"><div class="av">N</div><div style="min-width:0;flex:1"><div class="who"><b>Nissan</b>'+new Date(m.createdDateTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+(m.edited?'<span class="edited">Edited</span>':'')+'</div>'+(m.subject&&!m.deletedDateTime?'<div class="subj">'+esc(m.subject)+'</div>':'')+'<div class="body">'+body(m)+'</div>'+(r.length?'<div class="rx">'+r.map(x=>'<span>'+x+'</span>').join('')+'</div>':'')+'</div></div>'}
async function tick(){const s=await (await fetch('/state')).json();document.getElementById('cap').textContent=s.caption;
const feed=document.getElementById('feed');feed.innerHTML=s.chan.map(t=>{const reps=t.deletedDateTime?[]:t.replies;const shown=reps.slice(-2);return '<div class="post'+(t.id===s.selected?' sel':'')+'">'+msg(t,s.reactions)+(reps.length?'<div class="reps">'+(reps.length>2?'<div class="more">'+(reps.length-2)+' more replies</div>':'')+shown.map(m=>msg(m,s.reactions)).join('')+'</div>':'')+'</div>'}).join('');feed.scrollTop=feed.scrollHeight;
const pane=document.getElementById('pane');const t=s.chan.find(x=>x.id===s.selected);if(!t){pane.style.display='none';return}pane.style.display='flex';document.getElementById('ph').textContent=t.deletedDateTime?'(deleted)':(t.subject||'Thread');const pl=document.getElementById('pl');pl.innerHTML=msg(t,s.reactions)+'<div style="border-top:1px solid #e0e0e0"></div>'+(t.deletedDateTime?'':t.replies.map(m=>msg(m,s.reactions)).join(''));pl.scrollTop=pl.scrollHeight}
setInterval(tick,400);tick();
</script></body></html>`;

// ---------- run ----------
let server;
let bridge;
let browser;
async function main() {
  await new Promise((r) => graph.listen(gport, '127.0.0.1', r));
  server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const api = async (p, o = {}) => {
    const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: o.body ? JSON.stringify(o.body) : undefined });
    return r.json();
  };

  // Two chats started in the web UI earlier: no Teams threads.
  const { session: login1 } = await api('/api/sessions', { method: 'POST', body: { cwd: repo, kind: 'chat', name: 'Fix flaky login test', prompt: 'fix the flaky login test in e2e/login.spec.ts' } });
  await api('/api/sessions', { method: 'POST', body: { cwd: repo, kind: 'chat', name: 'Upgrade dependencies', prompt: 'upgrade the dependencies to their latest minor versions' } });
  await sleep(2500);

  // The bridge, already signed in, in channel mode.
  const dir = path.join(tmp, 'teams');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ access: 'at-demo', refresh: 'rt-demo', expires: Date.now() + 36e6, savedAt: Date.now() }));
  bridge = spawn(process.execPath, [path.join(root, 'teams-bridge', 'bridge.mjs')], {
    env: { ...env, CLAUDE_UI_URL: base, CW_BRIDGE_TOKEN_FILE: path.join(env.CW_DATA_DIR, 'bridge-token'), TEAMS_DATA_DIR: dir, TEAMS_CLIENT_ID: 'client', TEAMS_TENANT_ID: 'tenant', TEAMS_GRAPH_URL: `http://127.0.0.1:${gport}/v1.0`, TEAMS_LOGIN_URL: `http://127.0.0.1:${gport}`, TEAMS_POLL_SECONDS: '2', TEAMS_AWAY_MINUTES: '0', TEAMS_CHANNEL: 'Claudia / Claudia In Bamba', TEAMS_UI_LINK: 'http://bamba:8787' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[bridge] ${d}`));
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  await until(() => chan.find((m) => /Connected\./.test(m.body.content)), 20_000, 'connected');
  chan.length = 0; // start the walkthrough on a clean channel

  // The full Playwright (it records video) if it is installed globally, else the project's playwright-core.
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    ({ chromium } = await import('playwright-core'));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${gport}/view`);
  let shot = 0;
  const snap = async (name) => {
    await sleep(900);
    await page.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}-${name}.png`) });
    console.log('saved', name);
  };

  caption = '1. Ask at the top of the channel: the Assistant answers with a short summary';
  await sleep(1200);
  const q1 = say('what is running right now?');
  await until(() => chan.find((x) => x.id === q1).replies.some((m) => /Two chats/.test(textOf(m))), 30_000, 'summary');
  await snap('top-level-summary');

  caption = "2. Ask about one chat: it gets its own thread, with a live status card, linked under the answer";
  const q2 = say('how did the login test fix go?');
  const tRoot = await until(() => chan.find((m) => m.subject === 'Fix flaky login test'), 30_000, 'thread');
  await until(() => chan.find((x) => x.id === q2).replies.some((m) => /in its thread/.test(textOf(m))), 30_000, 'answer with link');
  await snap('thread-opened');

  caption = '3. Reply in that thread: the chat itself answers, nothing global';
  selected = tRoot.id;
  await sleep(800);
  say('which files did you change?', tRoot.id);
  await until(() => tRoot.replies.some((m) => /Only src\/auth\/session\.ts/.test(textOf(m))), 30_000, 'chat answer');
  await snap('chat-answers-in-thread');

  caption = '4. It needs an approval: the request lands in its thread and the card says "Needs you"';
  say('run the whole e2e suite before I merge', tRoot.id);
  await until(() => tRoot.replies.some((m) => /npm run test:e2e/.test(textOf(m)) && /Wants to use Bash/.test(textOf(m))), 30_000, 'approval');
  await until(() => /Needs you/.test(tRoot.body.content), 10_000, 'card needs you');
  await snap('approval-in-thread');

  caption = '5. Reply "yes": the card follows the tool it runs. A question while it is busy gets a status line at once';
  say('yes', tRoot.id);
  await until(() => /Working<\/b>: Bash: npm run test:e2e/.test(tRoot.body.content), 20_000, 'card working on bash');
  await sleep(600);
  say('how far along is it?', tRoot.id);
  await until(() => tRoot.replies.some((m) => /is busy/.test(textOf(m))), 20_000, 'busy note');
  await snap('busy-chat-status');

  caption = '6. Done: the result and the queued answer arrive in the thread, and the card at the top says Done';
  await until(() => tRoot.replies.some((m) => /214 of 214/.test(textOf(m))), 40_000, 'queued answer');
  await until(() => /✅ <b>Done/.test(tRoot.body.content), 20_000, 'card done');
  await snap('done');

  // The same conversation in the web UI: the Teams messages are ordinary messages of that chat.
  const ui = await ctx.newPage();
  await ui.setViewportSize({ width: 1440, height: 900 });
  await ui.goto(base);
  await ui.fill('input[type=password]', 'pw').catch(() => {});
  await ui.keyboard.press('Enter').catch(() => {});
  await sleep(1500);
  await ui.goto(`${base}/#s=${login1.id}`);
  await sleep(2500);
  await ui.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}-same-chat-in-web-ui.png`) });
  console.log('saved web UI');
  await ui.close();

  caption = '7. Archive the chat in Claude UI: its thread is deleted from the channel';
  selected = null;
  await api(`/api/sessions/${login1.id}`, { method: 'PATCH', body: { archived: true } });
  await until(() => tRoot.deletedDateTime, 20_000, 'deleted');
  await snap('archived');
  await sleep(1500);
  await ctx.close(); // writes the video
  const vids = fs.readdirSync(out).filter((f) => f.endsWith('.webm'));
  for (const v of vids) fs.renameSync(path.join(out, v), path.join(out, 'walkthrough.webm'));
}

main()
  .catch((e) => {
    console.error('ERROR', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    bridge?.kill();
    server?.kill('SIGTERM');
    await sleep(1000);
    graph.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    process.exit(process.exitCode || 0);
  });
