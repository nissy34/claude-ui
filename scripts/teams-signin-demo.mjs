#!/usr/bin/env node
// A recorded walkthrough of MCP sign-ins whose link only opens on the server (http://localhost…),
// finished from a phone through the Teams bridge: an SSO sign-in (the pasted address comes back) and
// a username/password page (encrypted on the phone with docs/seal.html). Runs Claude UI and the bridge
// against the scripted fake CLI, a fake Microsoft Graph, stand-in localhost sign-in pages and a
// stand-in SSO page, and saves screenshots of the Teams channel and of the phone.
//
//   node scripts/teams-signin-demo.mjs [out-dir]
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
const out = path.resolve(process.argv[2] || path.join(root, 'teams-signin-demo'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-signin-demo-'));
const port = 19600 + Math.floor(Math.random() * 300);
const gport = port + 400;
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'reports');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# reports\n');
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
  CW_BRIDGE_STATUS_MS: '1000',
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  CW_SEAL_URL: `http://127.0.0.1:${port + 700}/seal.html`,
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

// ---------- stand-ins: the MCP servers' localhost pages, the SSO page, the encrypt page's host ----------
const ssoPort = port + 500;
const formPort = port + 600;
const sealPort = port + 700;
const readBody = (req) => new Promise((r) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => r(d));
});
const servers = [
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/login') {
      res.writeHead(302, { 'set-cookie': 'flow=f1', location: `https://sso.example.com/authorize?client_id=jira-mcp&state=st9&redirect_uri=${encodeURIComponent(`http://localhost:${ssoPort}/callback`)}` });
      return res.end();
    }
    res.writeHead(u.searchParams.get('code') ? 200 : 400, { 'content-type': 'text/html' });
    res.end('<p>Signed in. You can close this tab.</p>');
  }),
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const page = `<form method="post" action="/login"><input type="hidden" name="csrf" value="t1"><label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" type="password" name="password"></form>`;
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      if (f.get('username') && f.get('password') === 'correct horse') {
        res.writeHead(302, { location: '/done' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<p>Wrong username or password</p>${page}`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(u.pathname === '/done' ? '<p>Signed in.</p>' : page);
  }),
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(root, 'docs', 'seal.html')));
  }),
];

// The phone: a frame with an address bar, around what the page shows.
const PHONE = (addr, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:15px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;background:#fff;color:#222}
.bar{background:#f1f1f1;border-bottom:1px solid #ddd;padding:10px 12px}.url{background:#fff;border-radius:18px;padding:7px 14px;font-size:13px;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg{padding:28px 22px}h1{font-size:21px;margin:0 0 6px}.sub{color:#666;font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 4px}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;border-radius:8px;font:inherit}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:8px;background:#2b4c7e;color:#fff;font:inherit;font-weight:600}
.err{color:#666;font-size:14px;margin-top:10px}.big{font-size:22px;font-weight:600;margin:30px 0 8px}
</style></head><body><div class="bar"><div class="url">${addr}</div></div><div class="pg">${inner}</div></body></html>`;

let server;
let bridge;
let browser;
async function main() {
  await new Promise((r) => graph.listen(gport, '127.0.0.1', r));
  await Promise.all(servers.map((s, i) => new Promise((r) => s.listen([ssoPort, formPort, sealPort][i], '127.0.0.1', r))));
  server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const api = async (p, o = {}) => {
    const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: o.body ? JSON.stringify(o.body) : undefined });
    return r.json();
  };

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
  chan.length = 0;

  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    ({ chromium } = await import('playwright-core'));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${gport}/view`);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  let shot = 0;
  const snap = async (name, pg = page) => {
    await sleep(pg === page ? 900 : 300);
    await pg.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}-${name}.png`) });
    console.log('saved', name);
  };
  const lastIn = (root) => root.replies.at(-1);
  const hrefIn = (m, re) => {
    const all = textOf(m).replace(/&amp;/g, '&');
    for (const x of all.matchAll(/"url":"([^"]+)"|href="([^"]+)"/g)) if (re.test(x[1] || x[2])) return x[1] || x[2];
    return null;
  };

  // ---------- 1. SSO ----------
  caption = 'SSO 1. A chat needs the Jira MCP, which signs in through a localhost link. Teams gets the real sign-in page';
  const { session: c1 } = await api('/api/sessions', { method: 'POST', body: { cwd: repo, kind: 'chat', name: 'Weekly Jira report', prompt: `@@elicit jira http://localhost:${ssoPort}/login Signed in to Jira. Pulled 42 tickets closed this week; the report is in reports/week-47.md.` } });
  const t1 = await until(() => chan.find((m) => m.subject === 'Weekly Jira report'), 30_000, 'thread');
  const ask1 = await until(() => t1.replies.find((m) => /jira needs you to sign in/.test(textOf(m))), 30_000, 'sso card');
  selected = t1.id;
  await snap('sso-card-in-teams');
  const ssoUrl = hrefIn(ask1, /^https:\/\/sso\.example\.com/);

  caption = 'SSO 2. On the phone, Sign in opens the company sign-in page';
  await phone.setContent(PHONE(ssoUrl.replace(/^https:\/\//, ''), `<h1>Company sign-in</h1><p class="sub">Jira MCP wants to sign you in.</p><label>Email</label><input value="nissan@company.example"><label>Password</label><input type="password" value="xxxxxxxxxx"><button>Sign in</button>`));
  await snap('sso-phone-signin', phone);
  const cb = `http://localhost:${ssoPort}/callback?code=Ab12Cd34&state=st9`;
  await phone.setContent(PHONE(cb, `<div class="big">This site can't be reached</div><p class="err">localhost refused to connect.</p><p class="err">That's expected. Copy this page's address and reply with it in Teams.</p>`));
  await snap('sso-phone-localhost-error', phone);

  caption = "SSO 3. Reply with that address. The server opens it on its own localhost, and the chat goes on";
  const r1 = say(cb.replace(/&/g, '&amp;'), t1.id);
  await until(() => reactions[r1]?.has('✅') || reactions[r1]?.size, 20_000, 'sso reaction');
  await until(() => t1.replies.some((m) => /Pulled 42 tickets/.test(textOf(m))), 30_000, 'chat goes on');
  await snap('sso-done-in-teams');

  // ---------- 2. username/password page ----------
  caption = 'Password 1. Another MCP shows a username/password page on localhost. Teams gets a link to the encrypt page';
  await api('/api/sessions', { method: 'POST', body: { cwd: repo, kind: 'chat', name: 'Check build server', prompt: `@@elicit build-server http://localhost:${formPort}/login Signed in to the build server. Last night's build passed: 1,204 tests, 0 failures.` } });
  const t2 = await until(() => chan.find((m) => m.subject === 'Check build server'), 30_000, 'thread 2');
  const ask2 = await until(() => t2.replies.find((m) => /needs your username and password/.test(textOf(m))), 30_000, 'form card');
  selected = t2.id;
  await snap('password-card-in-teams');
  const sealUrl = hrefIn(ask2, /seal\.html#/);

  caption = 'Password 2. The encrypt page opens on the phone. You type the username and password there';
  await phone.goto(sealUrl);
  await phone.fill('#f0', 'nissan');
  await phone.fill('#f1', 'correct horse');
  await snap('password-phone-form', phone);
  await phone.click('button[type=submit]');
  await phone.waitForSelector('#out:not([hidden])');
  caption = 'Password 3. It gives back a scrambled code. Copy it';
  await snap('password-phone-code', phone);
  const code = await phone.inputValue('#code');

  caption = 'Password 4. Reply with the code. The server decrypts it, signs in on localhost, and the chat goes on';
  const r2 = say(code, t2.id);
  await until(() => reactions[r2]?.size, 20_000, 'form reaction');
  await until(() => t2.replies.some((m) => /1,204 tests/.test(textOf(m))), 30_000, 'chat 2 goes on');
  await snap('password-done-in-teams');

  // ---------- 3. wrong password ----------
  caption = 'Password, wrong: the page refuses it, and you get a fresh one-time link';
  await api('/api/sessions', { method: 'POST', body: { cwd: repo, kind: 'chat', name: 'Deploy status', prompt: `@@elicit build-server http://localhost:${formPort}/login Signed in.` } });
  const t3 = await until(() => chan.find((m) => m.subject === 'Deploy status'), 30_000, 'thread 3');
  const ask3 = await until(() => t3.replies.find((m) => /needs your username and password/.test(textOf(m))), 30_000, 'form card 3');
  selected = t3.id;
  await phone.goto('about:blank');
  await phone.goto(hrefIn(ask3, /seal\.html#/));
  await phone.fill('#f0', 'nissan');
  await phone.fill('#f1', 'wrong one');
  await phone.click('button[type=submit]');
  await phone.waitForSelector('#out:not([hidden])');
  say(await phone.inputValue('#code'), t3.id);
  await until(() => t3.replies.some((m) => /didn't accept it/.test(textOf(m))), 20_000, 'retry note');
  await snap('password-wrong-in-teams');
  void c1;
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
    for (const s of servers) s.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    process.exit(process.exitCode || 0);
  });
