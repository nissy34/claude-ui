import http from 'node:http';
import os from 'node:os';
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

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));

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

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

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
    const { cwd, kind, name, resume, model, permissionMode } = req.body || {};
    const dir = resolveDir(cwd);
    if (resume && resume !== 'continue' && !/^[0-9a-f-]{36}$/i.test(resume)) throw new Error('Bad resume id');
    const s = store.create({ cwd: dir, kind, name: name ? String(name).slice(0, 80) : undefined, resume, model, permissionMode });
    if (name) s.meta.customName = true;
    res.json({ session: s.toJSON() });
  })
);

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
    store.save();
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
