import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import {
  isAuthed,
  checkPassword,
  setAuthCookie,
  clearAuthCookie,
  loginAllowed,
  loginFailed,
  loginSucceeded,
} from './auth.js';
import { store, claudeProjectDir } from './sessions.js';
import { getChanges, searchFiles, readFileSafe, createWorktree } from './git.js';
import * as browser from './browser.js';
import { listArtifacts, rawHandler, rawUrl } from './artifacts.js';
import * as admin from './claude-admin.js';
import { authStatus, mcpList, pluginList, cliVersion, permissionRules, removePermissionRule } from './claude-admin.js';

if (!config.password && !config.passwordHash) {
  console.error('Refusing to start: set CW_PASSWORD or CW_PASSWORD_HASH (see README).');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

const app = express();
if (config.trustProxy) app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!loginAllowed(ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  if (!checkPassword(req.body?.password)) {
    loginFailed(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  loginSucceeded(ip);
  setAuthCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ---------- internal API for the sessions MCP server (child sessions) ----------
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  // Loopback, or this machine calling its own listen address (e.g. a Tailscale IP).
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === req.socket.localAddress;
}
app.use('/internal', (req, res, next) => {
  const t = req.headers['x-cw-token'];
  if (!isLoopback(req) || typeof t !== 'string' || t.length !== config.internalToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(config.internalToken))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

function sessionSummary(s) {
  const j = s.toJSON();
  return { id: j.id, name: j.name, cwd: j.cwd, kind: j.kind, state: j.state || j.status, parentId: j.parentId || null, worktree: j.worktree || null };
}

app.post(
  '/internal/sessions',
  wrap(async (req, res) => {
    const { parentId, prompt, name, cwd, worktree, permissionMode } = req.body || {};
    if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');
    const parent = store.get(parentId);
    let dir = cwd ? resolveDir(cwd) : parent?.meta.project || parent?.meta.cwd;
    if (!dir) throw new Error('cwd is required');
    let wt = null;
    if (worktree) {
      wt = await createWorktree(dir, name || prompt.slice(0, 30));
    }
    const s = store.create({
      cwd: wt ? wt.path : dir,
      kind: 'chat',
      name: name ? String(name).slice(0, 80) : undefined,
      permissionMode: permissionMode || parent?.meta.permissionMode,
      model: parent?.meta.model,
    });
    s.meta.parentId = parent ? parent.id : null;
    s.meta.project = dir;
    if (wt) s.meta.worktree = wt;
    if (name) s.meta.customName = true;
    s.send({ text: prompt });
    store.save();
    res.json({ session: sessionSummary(s), note: 'Started. It runs on its own; use read_session to check on it.' });
  })
);

app.post(
  '/internal/sessions/:id/send',
  wrap(async (req, res) => {
    const s = store.get(req.params.id);
    if (!s || s.meta.kind !== 'chat') throw new Error('No such chat session');
    s.send({ text: String(req.body?.message || '') });
    res.json({ ok: true, session: sessionSummary(s) });
  })
);

app.get(
  '/internal/sessions/:id',
  wrap(async (req, res) => {
    const s = store.get(req.params.id);
    if (!s || s.meta.kind !== 'chat') throw new Error('No such chat session');
    if (req.query.wait === '1') {
      const until = Date.now() + Math.min(Number(req.query.timeout) || 300, 1800) * 1000;
      while (s.state !== 'idle' && Date.now() < until && store.get(s.id)) await new Promise((r) => setTimeout(r, 1000));
    }
    res.json({
      session: sessionSummary(s),
      waitingForPermission: s.pending.size > 0,
      lastReply: s.lastReply(),
    });
  })
);

// Built-in browser, driven by Claude through mcp-browser.js.
app.get(
  '/internal/browser/:sid/screenshot',
  wrap(async (req, res) => {
    const buf = await browser.screenshot(req.params.sid, { type: 'jpeg', quality: 75, fullPage: req.query.full === '1' });
    res.type('image/jpeg').send(buf);
  })
);
app.post(
  '/internal/browser/:sid/:op',
  wrap(async (req, res) => {
    if (!store.get(req.params.sid)) throw new Error('No such session');
    res.json(await browser.run(req.params.sid, req.params.op, req.body || {}));
  })
);

app.get('/internal/sessions', (req, res) => {
  let list = [...store.sessions.values()];
  if (req.query.parentId) list = list.filter((s) => s.meta.parentId === req.query.parentId);
  res.json({ sessions: list.map(sessionSummary) });
});

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));

// Artifact files, authorised by a per-session signature in the path (no cookie: sandboxed
// HTML artifacts load their own CSS/JS from here with an opaque origin).
app.get('/raw/:sid/:sig/*', (req, res, next) => {
  try {
    rawHandler(store)(req, res);
  } catch (e) {
    next(e);
  }
});

app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// ---------- helpers ----------
function resolveDir(input) {
  if (typeof input !== 'string' || !input) throw new Error('cwd is required');
  const abs = path.resolve(config.projectsRoot, input.replace(/^~(?=$|[\\/])/, os.homedir()));
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error(`Directory does not exist: ${abs}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a directory: ${real}`);
  if (!config.allowAnyDir) {
    const root = fs.realpathSync(config.projectsRoot);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`Directory must be inside ${root} (set CW_ALLOW_ANY_DIR=1 to lift this)`);
    }
  }
  return real;
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
}

// ---------- info ----------
app.get('/api/config', (req, res) => {
  res.json({ projectsRoot: config.projectsRoot, allowAnyDir: config.allowAnyDir, hostname: process.env.HOSTNAME || '' });
});

// ---------- projects ----------
app.get(
  '/api/projects',
  wrap(async (req, res) => {
    const root = config.projectsRoot;
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const counts = {};
    for (const s of store.list()) counts[s.cwd] = (counts[s.cwd] || 0) + 1;
    const projects = [];
    const seen = new Set();
    const rootReal = fs.realpathSync(root);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(rootReal, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      seen.add(p);
      projects.push({ name: e.name, path: p, git: fs.existsSync(path.join(p, '.git')), sessions: counts[p] || 0 });
    }
    // Directories used by sessions that aren't direct children of the root.
    for (const cwd of Object.keys(counts)) {
      if (!seen.has(cwd)) {
        projects.push({ name: path.relative(rootReal, cwd) || path.basename(cwd), path: cwd, git: fs.existsSync(path.join(cwd, '.git')), sessions: counts[cwd] });
      }
    }
    projects.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
    res.json({ root: rootReal, projects });
  })
);

app.post(
  '/api/projects',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Use letters, numbers, dot, dash or underscore');
    const p = path.join(config.projectsRoot, name);
    if (fs.existsSync(p)) throw new Error('Already exists');
    fs.mkdirSync(p);
    res.json({ path: fs.realpathSync(p) });
  })
);

// Past Claude Code conversations for a directory (read from Claude's own transcript files).
async function summarize(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let title = '';
  let summary = '';
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 400) break;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'summary' && obj.summary) summary = obj.summary;
      if (!title && obj.type === 'user' && obj.message && !obj.isMeta) {
        const c = obj.message.content;
        let text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text || '' : '';
        text = text.trim();
        if (text && !text.startsWith('<')) title = text.slice(0, 140);
      }
      if (title && summary) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return summary || title;
}

app.get(
  '/api/history',
  wrap(async (req, res) => {
    const cwd = resolveDir(req.query.cwd);
    const dir = claudeProjectDir(cwd);
    let files = [];
    try {
      files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return res.json({ conversations: [] });
    }
    const stats = await Promise.all(
      files.map(async (f) => {
        const st = await fs.promises.stat(path.join(dir, f));
        return { id: f.slice(0, -6), file: path.join(dir, f), mtime: st.mtimeMs, size: st.size };
      })
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const top = stats.slice(0, 30);
    const conversations = [];
    for (const s of top) {
      const title = await summarize(s.file).catch(() => '');
      if (!title && s.size < 2000) continue;
      conversations.push({ id: s.id, title: title || '(untitled)', mtime: s.mtime, size: s.size });
    }
    res.json({ conversations });
  })
);

// ---------- sessions ----------
app.get('/api/sessions', (req, res) => res.json({ sessions: store.list() }));

app.post(
  '/api/sessions',
  wrap(async (req, res) => {
    const { cwd, kind, name, resume, model, permissionMode, effort, worktree, parentId } = req.body || {};
    const project = resolveDir(cwd);
    const wt = worktree ? await createWorktree(project, name || 'chat') : null;
    const dir = wt ? wt.path : project;
    if (resume && resume !== 'continue' && !/^[0-9a-f-]{36}$/i.test(resume)) throw new Error('Bad resume id');
    const s = store.create({ cwd: dir, kind, name: name ? String(name).slice(0, 80) : undefined, resume, model, permissionMode, effort, initialInput: req.body?.login && kind === 'claude' ? '/login\r' : undefined });
    if (name) s.meta.customName = true;
    s.meta.project = project;
    if (wt) s.meta.worktree = wt;
    if (parentId && store.get(parentId)) s.meta.parentId = parentId;
    store.save();
    res.json({ session: s.toJSON() });
  })
);

function getSessionById(id) {
  const s = store.get(id);
  if (!s) throw new Error('No such session');
  return s;
}

function getSession(req) {
  const s = store.get(req.params.id);
  if (!s) throw new Error('No such session');
  return s;
}

app.patch(
  '/api/sessions/:id',
  wrap(async (req, res) => {
    const s = getSession(req);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      s.meta.name = req.body.name.trim().slice(0, 80);
      s.meta.customName = true;
    }
    if (typeof req.body?.archived === 'boolean') s.meta.archived = req.body.archived;
    if (typeof req.body?.pinned === 'boolean') s.meta.pinned = req.body.pinned;
    if (req.body?.unread === true) s.meta.attention = true;
    store.save();
    store.changed?.();
    res.json({ session: s.toJSON() });
  })
);

app.post(
  '/api/sessions/:id/restart',
  wrap(async (req, res) => {
    const s = getSession(req);
    if (!s.running) s.start();
    res.json({ session: s.toJSON() });
  })
);

app.get(
  '/api/sessions/:id/changes',
  wrap(async (req, res) => {
    res.json(await getChanges(getSession(req).meta.cwd));
  })
);

app.get(
  '/api/files',
  wrap(async (req, res) => {
    const s = getSessionById(req.query.session);
    res.json({ files: await searchFiles(s.meta.cwd, String(req.query.q || '')) });
  })
);

app.get(
  '/api/file',
  wrap(async (req, res) => {
    const s = getSessionById(req.query.session);
    res.json(readFileSafe(s.meta.cwd, String(req.query.path || '')));
  })
);

// ---------- built-in browser (the user's view of Claude's tab) ----------
app.get(
  '/api/sessions/:id/browser',
  wrap(async (req, res) => {
    getSession(req);
    res.json(await browser.state(req.params.id));
  })
);
app.get(
  '/api/sessions/:id/browser/frame',
  wrap(async (req, res) => {
    getSession(req);
    const buf = await browser.screenshot(req.params.id, { type: 'jpeg', quality: 70 });
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/jpeg').send(buf);
  })
);
app.post(
  '/api/sessions/:id/browser/:op',
  wrap(async (req, res) => {
    getSession(req);
    const out = await browser.run(req.params.id, req.params.op, { ...(req.body || {}), quiet: true });
    res.json({ ...(out.url ? { url: out.url, title: out.title } : out), state: await browser.state(req.params.id) });
  })
);

// ---------- artifacts ----------
app.get('/api/artifacts', (req, res) => {
  const all = store.list().map((j) => store.get(j.id)).filter(Boolean);
  const list = listArtifacts(req.query.session ? all.filter((s) => s.meta.id === req.query.session) : all);
  res.json({ artifacts: list });
});
app.get(
  '/api/artifact-url',
  wrap(async (req, res) => {
    const s = getSessionById(req.query.session);
    res.json({ url: rawUrl(s.meta.id, path.resolve(s.meta.cwd, String(req.query.path || ''))) });
  })
);

// ---------- settings ----------
app.get('/api/claude/status', wrap(async (req, res) => res.json({ auth: await authStatus(), version: await cliVersion(), dataDir: config.dataDir, projectsRoot: config.projectsRoot, node: process.version, platform: process.platform })));
app.get('/api/claude/mcp', wrap(async (req, res) => res.json(await mcpList(req.query.cwd ? resolveDir(req.query.cwd) : config.projectsRoot))));
app.get('/api/claude/plugins', wrap(async (req, res) => res.json(await pluginList())));
app.get('/api/claude/permissions', wrap(async (req, res) => res.json({ rules: permissionRules(req.query.cwd ? resolveDir(req.query.cwd) : null) })));
app.post(
  '/api/claude/permissions/remove',
  wrap(async (req, res) => {
    removePermissionRule(req.body?.cwd ? resolveDir(req.body.cwd) : null, req.body || {});
    res.json({ ok: true });
  })
);

// Structured management of MCP servers, plugins and skills.
const optCwd = (v) => (v ? resolveDir(v) : null);
app.get('/api/claude/mcp-servers', wrap(async (req, res) => res.json(await admin.mcpServers(optCwd(req.query.cwd)))));
app.post(
  '/api/claude/mcp-servers/:action',
  wrap(async (req, res) => {
    const b = req.body || {};
    const cwd = optCwd(b.cwd);
    const fn = { add: admin.mcpAdd, remove: admin.mcpRemove, toggle: admin.mcpToggle }[req.params.action];
    if (!fn) throw new Error('Unknown action');
    res.json(await fn(cwd || config.projectsRoot, b));
  })
);
app.get('/api/claude/plugins-full', wrap(async (req, res) => res.json(await admin.plugins())));
app.post('/api/claude/plugins/action', wrap(async (req, res) => res.json(await admin.pluginAction(req.body || {}))));
app.post('/api/claude/marketplaces/action', wrap(async (req, res) => res.json(await admin.marketplaceAction(req.body || {}))));
app.get('/api/claude/skills', wrap(async (req, res) => res.json({ skills: admin.skills(optCwd(req.query.cwd)) })));
app.post(
  '/api/claude/skills/:action',
  wrap(async (req, res) => {
    const b = req.body || {};
    const fn = { get: admin.skillGet, save: admin.skillSave, toggle: admin.skillToggle, delete: admin.skillDelete }[req.params.action];
    if (!fn) throw new Error('Unknown action');
    res.json(fn(optCwd(b.cwd), b));
  })
);

// Attachments: stored outside the project and exposed to Claude with --add-dir.
app.post(
  '/api/sessions/:id/upload',
  express.raw({ type: () => true, limit: '50mb' }),
  wrap(async (req, res) => {
    const s = getSession(req);
    let raw = String(req.headers['x-filename'] || 'file');
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    const name = path.basename(raw).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'file';
    const dir = path.join(config.dataDir, 'uploads', s.id);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, name);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${i}-${name}`);
    fs.writeFileSync(target, req.body);
    res.json({ path: target, name: path.basename(target), size: req.body.length });
  })
);

// Open a chat's conversation in Claude's own terminal UI (resumed with the same session id),
// and come back to the chat afterwards.
app.post(
  '/api/sessions/:id/terminal',
  wrap(async (req, res) => {
    const s = getSession(req);
    if (s.meta.kind !== 'chat') throw new Error('Not a chat');
    const existing = s.meta.tuiId && store.get(s.meta.tuiId);
    if (existing && existing.running) return res.json({ session: existing.toJSON() });
    if (s.turns > 0) throw new Error('Wait for Claude to finish (or stop it) first');
    await s.stopAndWait();
    const t = store.create({ cwd: s.meta.cwd, kind: 'claude', name: `${s.meta.name} · terminal`, resume: s.meta.claudeSessionId && fs.existsSync(path.join(claudeProjectDir(s.meta.cwd), `${s.meta.claudeSessionId}.jsonl`)) ? s.meta.claudeSessionId : undefined });
    t.meta.customName = true;
    t.meta.parentId = s.id;
    t.meta.tuiFor = s.id;
    t.meta.project = s.meta.project;
    s.meta.tuiId = t.id;
    store.save();
    res.json({ session: t.toJSON() });
  })
);
app.post(
  '/api/sessions/:id/back-to-chat',
  wrap(async (req, res) => {
    const t = getSession(req);
    const chat = t.meta.tuiFor && store.get(t.meta.tuiFor);
    if (!chat) throw new Error('This terminal is not linked to a chat');
    if (!chat.meta.claudeSessionId && t.meta.claudeSessionId) chat.meta.claudeSessionId = t.meta.claudeSessionId;
    store.remove(t.id);
    chat.meta.tuiId = null;
    await new Promise((r) => setTimeout(r, 300));
    chat.resync();
    store.save();
    res.json({ session: chat.toJSON() });
  })
);

app.post(
  '/api/sessions/:id/kill',
  wrap(async (req, res) => {
    getSession(req).kill();
    res.json({ ok: true });
  })
);

app.delete(
  '/api/sessions/:id',
  wrap(async (req, res) => {
    store.remove(req.params.id);
    browser.closeTab(req.params.id);
    res.json({ ok: true });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- static UI ----------
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('UI not built. Run <code>npm run build</code>.'));
}

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 }); // room for pasted images

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!['/ws', '/ws/events'].includes(url.pathname) || !isAuthed(req) || !originOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/events') return handleEvents(ws);
    handleTerminal(ws, url.searchParams.get('id'), +url.searchParams.get('cols'), +url.searchParams.get('rows'));
  });
});

// Pushes the session list whenever it changes, so every open UI stays in sync.
function handleEvents(ws) {
  let timer = null;
  const push = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'sessions', sessions: store.list() }));
    }, 150);
  };
  store.listeners.add(push);
  push();
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
  ws.on('close', () => {
    store.listeners.delete(push);
    clearInterval(ping);
    clearTimeout(timer);
  });
}

function handleTerminal(ws, id, cols, rows) {
  const s = store.get(id);
  if (!s) return ws.close(4004, 'no such session');
  if (s.meta.kind === 'chat') return handleChat(ws, s);
  // The newly attached device takes over the size, so the snapshot fits its screen.
  if (cols > 0 && rows > 0) s.resize(cols, rows);
  s.clients.add(ws);
  store.changed();
  ws.send(JSON.stringify({ t: 'snapshot', d: s.snapshot(), cols: s.cols, rows: s.rows, session: s.toJSON() }));

  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      s.write(msg.d);
    } else if (msg.t === 'resize') {
      // Most recently active client decides the pty size.
      s.resize(msg.cols, msg.rows);
    }
  });
  ws.on('close', () => {
    clearInterval(ping);
    s.clients.delete(ws);
    store.changed();
  });
}

function handleChat(ws, s) {
  s.clients.add(ws);
  if (s.meta.attention) {
    s.meta.attention = false;
  }
  store.changed();
  ws.send(JSON.stringify(s.snapshot()));
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.t === 'send') s.send(msg);
      else if (msg.t === 'perm') s.answerPermission(msg);
      else if (msg.t === 'interrupt') await s.interrupt();
      else if (msg.t === 'mode') await s.setMode(msg.mode);
      else if (msg.t === 'model') await s.setModel(msg.model);
      else if (msg.t === 'stop') s.stop();
      else if (msg.t === 'effort') await s.setEffort(msg.effort);
      else if (msg.t === 'edit') await s.editMessage(msg);
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', error: e.message }));
    }
  });
  ws.on('close', () => {
    clearInterval(ping);
    s.clients.delete(ws);
    store.changed();
  });
}

// ---------- lifecycle ----------
server.listen(config.port, config.host, () => {
  const h = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  config.internalUrl = `http://${h}:${config.port}`;
  console.log(`claude-web listening on http://${config.host}:${config.port}`);
  console.log(`projects root: ${config.projectsRoot}`);
  console.log(`data dir:      ${config.dataDir}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: saving sessions and shutting down`);
  store.shutdown();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
