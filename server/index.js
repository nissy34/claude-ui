import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, rootCaseWarning } from './config.js';
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
import { browserAvailable } from './browser.js';
import { listArtifacts, rawHandler, rawUrl } from './artifacts.js';
import * as admin from './claude-admin.js';
import { McpAdmin, onSignedIn, stopAllAdmins } from './mcp-admin.js';
import { getModels } from './models.js';
import { sideChat } from './side-chat.js';
import { prStatus, mergeWhenReady } from './pr-status.js';
import * as schedules from './schedules.js';
import * as notes from './notes.js';
import { controlSession } from './session-control.js';
import { createDesktopMcp, getToken as getMcpToken, rotateToken as rotateMcpToken } from './desktop-mcp.js';
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
  return { id: j.id, name: j.name, cwd: j.cwd, kind: j.kind, state: j.state || j.status, parentId: j.parentId || null, worktree: j.worktree || null, model: j.model || 'default', effort: j.effort || 'default', permissionMode: j.permissionMode || 'default' };
}

app.post(
  '/internal/sessions',
  wrap(async (req, res) => {
    const { parentId, prompt, name, cwd, worktree, permissionMode, model, effort } = req.body || {};
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
      model: model && model !== 'default' ? model : model === 'default' ? undefined : parent?.meta.model,
      effort: effort || parent?.meta.effort,
    });
    s.meta.parentId = parent ? parent.id : null;
    s.meta.project = dir;
    if (wt) s.meta.worktree = wt;
    if (name) s.meta.customName = true;
    s.send({ text: prompt });
    store.save();
    res.json({ session: sessionSummary(s), note: 'Started. It runs on its own and sends you updates, questions and its result as messages; no need to poll.' });
  })
);

// One messaging tool for every direction. The sender is the calling session (x-cw-session), so
// the other side sees who wrote and can reply the same way. "parent" names the caller's parent.
app.post(
  '/internal/sessions/:id/send',
  wrap(async (req, res) => {
    const sender = store.get(req.headers['x-cw-session']);
    let id = String(req.params.id).trim();
    const parentId = sender?.meta.parentId;
    if (/^parent$/i.test(id) || (parentId && id === store.get(parentId)?.meta.name)) {
      id = parentId;
      if (!id) throw new Error('This session has no parent chat. Ask the user in your reply instead.');
    }
    const s = store.get(id);
    if (!s || s.meta.kind !== 'chat') {
      throw new Error(`No chat session with id "${id}".${parentId ? ' To reach the chat that started this one, use id "parent".' : ''} list_sessions shows the ids of your child sessions.`);
    }
    if (s === sender) throw new Error('That is this session. To reach the chat that started this one, use id "parent".');
    const text = String(req.body?.message || '');
    if (!text.trim()) throw new Error('message is required');
    const wait = !!req.body?.wait_for_reply;
    if (await s.runLocalCommand(text)) return res.json({ ok: true, ranCommand: true, session: sessionSummary(s) });
    if (!sender) {
      s.send({ text });
      return res.json({ ok: true, session: sessionSummary(s) });
    }
    // How the recipient sees the sender.
    const role = sender.meta.parentId === s.id ? 'child' : s.meta.parentId === sender.id ? 'parent' : 'other';
    const from = { id: sender.id, name: sender.meta.name, role };

    // The recipient is blocked waiting for this sender: this message is its answer, and its
    // tool call returns it right away (no new turn, no queue).
    const replied = s.takeReply(sender.id, text, wait);
    if (replied) {
      s.record({ k: 'user', text, images: 0, from: { ...from, kind: 'reply' } });
      // Answered before the question reached this chat's turn (e.g. it saw it via read_session): drop it from the queue.
      if (sender.inbox.some((b) => b.from?.id === s.id && b.from?.kind === 'question')) {
        sender.meta.inbox = sender.inbox.filter((b) => !(b.from?.id === s.id && b.from?.kind === 'question'));
        sender.store.save();
        sender.broadcastState();
      }
      if (!wait) return res.json({ ok: true, note: `Delivered to "${s.meta.name}" as the reply it was waiting for; it carries on now.`, session: sessionSummary(s) });
    }

    const r = replied ? { queued: 0 } : s.deliver({ text, from: { ...from, kind: wait ? 'question' : undefined } });
    const where = r.held
      ? `Held for "${s.meta.name}" (it can't take messages right now); delivered when it can.`
      : r.queued
        ? `Queued for "${s.meta.name}": it is busy, ${r.queued} message(s) waiting, delivered in order when its current turn ends.`
        : `Delivered to "${s.meta.name}".`;
    if (!wait) return res.json({ ok: true, queued: r.queued, note: `${where} Keep working.`, session: sessionSummary(s) });

    const minutes = Math.min(Math.max(Number(req.body?.timeout_minutes) || 60, 1), 24 * 60);
    let done = false;
    res.on('close', () => {
      if (!done) sender.cancelWait('the tool call was cancelled');
    });
    const out = await sender.waitForReply(s.id, minutes * 60_000);
    done = true;
    if (res.destroyed) return;
    if (out.answered) return res.json({ answered: true, from: s.meta.name, session_id: s.id, reply: out.reply, ...(out.expectsReply ? { note: 'They are now blocked waiting for your reply: answer with send_to_session.' } : {}) });
    res.json({
      answered: false,
      note:
        out.reason === 'timeout'
          ? `No reply from "${s.meta.name}" after ${minutes} minutes. Carry on with your best judgment or ask again; a reply that comes later arrives as a new message.`
          : `Stopped waiting (${out.reason}). A reply that comes later arrives as a new message.`,
    });
  })
);

app.post(
  '/internal/sessions/:id/options',
  wrap(async (req, res) => {
    const s = store.get(req.params.id);
    if (!s || s.meta.kind !== 'chat') throw new Error('No such chat session');
    const { model, effort, permissionMode } = req.body || {};
    if (model == null && effort == null && permissionMode == null) throw new Error('Give model, effort or permission_mode');
    const done = await s.setOptions({ model, effort, permissionMode });
    s.record({ k: 'notice', text: `Set ${done.join(', ')} (by the parent chat)` });
    res.json({ ok: true, changed: done, session: sessionSummary(s) });
  })
);

app.post(
  '/internal/sessions/:id/control/:action',
  wrap(async (req, res) => {
    const s = store.get(req.params.id);
    if (!s) throw new Error('No such session. list_sessions shows the ids.');
    const caller = store.get(req.headers['x-cw-session']);
    if (s === caller && req.params.action === 'stop') throw new Error('That is this session.');
    res.json({ ...(await controlSession(store, s, req.params.action, req.body || {}, caller ? `chat "${caller.meta.name}"` : 'another chat')), session: sessionSummary(s) });
  })
);

app.get(
  '/internal/sessions/:id',
  wrap(async (req, res) => {
    const s = store.get(req.params.id);
    if (!s || s.meta.kind !== 'chat') throw new Error('No such chat session');
    if (req.query.wait === '1') {
      const until = Date.now() + Math.min(Number(req.query.timeout) || 300, 1800) * 1000;
      // Stop early when the session is blocked on a question to the caller: nobody else will answer it.
      const caller = req.headers['x-cw-session'];
      while (s.state !== 'idle' && Date.now() < until && store.get(s.id) && !(s.waiting && s.waiting.to === caller)) await new Promise((r) => setTimeout(r, 1000));
    }
    const w = s.waitingSummary();
    res.json({
      session: sessionSummary(s),
      waitingForPermission: s.pending.size > 0,
      waitingForReplyFrom: w ? { session_id: w.id, name: w.name, ...(w.id === req.headers['x-cw-session'] ? { note: 'It is blocked on a question to you (in your messages). Answer with send_to_session.' } : {}) } : null,
      queuedMessages: s.inbox.length,
      lastReply: s.lastReply(),
    });
  })
);

// Sign-in pages: the URL opener (opener.js) and Sign in buttons open them in the sign-in browser on
// this machine, so their redirect to http://127.0.0.1:<port> reaches the waiting process. When the
// saved browser sign-in finishes it by itself, nothing pops up; otherwise every open UI pops up the
// sign-in window and notifies.
const SIGNIN_QUIET_MS = 3000;
const signinRepeats = new Map(); // `${sid} ${host}` -> recent sign-in times
function openSigninPage(url, { sid, server } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only http(s) pages can be opened');
  if (!browserAvailable()) throw new Error('The built-in browser is not available on this server');
  const from = sid ? store.get(sid) : null;
  let host = '';
  try {
    host = new URL(url).host;
  } catch {}
  const notice = (text) => from?.meta.kind === 'chat' && from.record({ k: 'notice', text });
  browser
    .openSignin(url)
    .then(async (id) => {
      const finished = await browser.signinSettled(id, SIGNIN_QUIET_MS);
      if (finished) {
        // A server that signs in again on every call isn't keeping its login: say so once in a while.
        const key = `${sid || ''} ${host}`;
        const now = Date.now();
        const times = (signinRepeats.get(key) || []).filter((t) => now - t < 5 * 60_000).concat(now);
        signinRepeats.set(key, times);
        if (times.length === 3 || times.length % 10 === 0)
          return notice(`${host} has signed in ${times.length} times in a few minutes. The MCP server that opens it isn't keeping its login, so each call signs in again.`);
        return times.length < 3 && notice(`Signed in to ${host} with the saved browser sign-in`);
      }
      notice(`Sign-in page opened in the sign-in window: ${host}`);
      emitUi({ t: 'signin-page', id, url, host, server: server || null, from: from ? { id: from.id, name: from.meta.name } : null });
    })
    .catch((e) => emitUi({ t: 'error', error: `Could not open the sign-in page: ${e.message}` }));
}
browser.onSigninChange((pages) => emitUi({ t: 'signin-pages', pages }));

app.post('/internal/open-url', (req, res) => {
  try {
    openSigninPage(req.body?.url, { sid: req.body?.sid });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

// Scheduled tasks, created by Claude through mcp-schedule.js.
app.get('/internal/schedules', (req, res) => res.json({ tasks: schedules.listTasks().map(scheduleSummary) }));
app.post(
  '/internal/schedules',
  wrap(async (req, res) => {
    const b = req.body || {};
    const from = store.get(b.sessionId);
    const cwd = resolveDir(b.cwd || from?.meta.project || from?.meta.cwd);
    const t = schedules.createTask({ ...b, cwd, permissionMode: b.permissionMode || from?.meta.permissionMode || 'default' });
    res.json({ task: scheduleSummary(t), note: 'Created. It shows on the Scheduled page, where the user can edit, pause or delete it.' });
  })
);
app.post(
  '/internal/schedules/:id/:action',
  wrap(async (req, res) => {
    const { id, action } = req.params;
    if (action === 'delete') schedules.deleteTask(id);
    else if (action === 'run') return res.json(await schedules.runTask(id));
    else if (action === 'update') return res.json({ task: scheduleSummary(schedules.updateTask(id, req.body || {})) });
    else throw new Error('Unknown action');
    res.json({ ok: true });
  })
);
function scheduleSummary(t) {
  return { id: t.id, name: t.name, preset: t.preset, cron: t.cronExpr, enabled: t.enabled, cwd: t.cwd, nextRun: t.nextRun ? new Date(t.nextRun).toString() : null, lastRun: t.lastRun ? new Date(t.lastRun).toString() : null };
}

// Shared notes, used by chats through mcp-notes.js (and by Claude Desktop through /mcp).
app.post(
  '/internal/notes/:op',
  wrap(async (req, res) => {
    const b = req.body || {};
    const from = store.get(req.headers['x-cw-session']);
    // Project notes default to the calling chat's project.
    const projectDir = b.project ? resolveDir(String(b.project)) : from?.meta.project || from?.meta.cwd;
    res.json(notes.notesOp(req.params.op, b, { projectDir, source: from ? `chat "${from.meta.name}"` : 'chat' }));
  })
);

app.get('/internal/sessions', (req, res) => {
  let list = [...store.sessions.values()];
  if (req.query.parentId) list = list.filter((s) => s.meta.parentId === req.query.parentId);
  res.json({ sessions: list.map(sessionSummary) });
});

// ---------- scheduled tasks ----------
app.get('/api/schedules', (req, res) => res.json({ tasks: schedules.listTasks(), now: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));
app.post(
  '/api/schedules',
  wrap(async (req, res) => res.json({ task: schedules.createTask({ ...req.body, cwd: resolveDir(req.body?.cwd) }) }))
);
app.patch(
  '/api/schedules/:id',
  wrap(async (req, res) => res.json({ task: schedules.updateTask(req.params.id, req.body?.cwd ? { ...req.body, cwd: resolveDir(req.body.cwd) } : req.body || {}) }))
);
app.delete(
  '/api/schedules/:id',
  wrap(async (req, res) => {
    schedules.deleteTask(req.params.id);
    res.json({ ok: true });
  })
);
app.post(
  '/api/schedules/:id/run',
  wrap(async (req, res) => res.json({ run: await schedules.runTask(req.params.id) }))
);

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));

// Handoff MCP for Claude Desktop (bearer token, not the login cookie).
if (config.desktopMcp) {
  createDesktopMcp({ store, resolveDir, createWorktree, getChanges, listProjects }).mount(app);
}

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
  if (!config.allowAnyDir && !isScratch(real)) {
    const root = fs.realpathSync(config.projectsRoot);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`Directory must be inside ${root} (set CW_ALLOW_ANY_DIR=1 to lift this)`);
    }
  }
  return real;
}

function isScratch(dir) {
  let root;
  try {
    root = fs.realpathSync(config.scratchDir);
  } catch {
    return false;
  }
  return dir === root || dir.startsWith(root + path.sep);
}

function parseCallbackUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Paste the whole address from the browser bar, starting with http://localhost');
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) throw new Error('That address is not a localhost callback (it should start with http://localhost or http://127.0.0.1)');
  if (!url.searchParams.get('code') && !url.searchParams.get('error')) throw new Error('That address has no ?code=… in it. Copy it after you approve access, from the page that failed to load.');
  return url;
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// GET the callback on this machine, as the browser would have. Only loopback, only http.
function replayLoopback(url) {
  const hosts = url.hostname === '127.0.0.1' ? ['127.0.0.1'] : url.hostname === '[::1]' ? ['::1'] : ['127.0.0.1', '::1'];
  const port = Number(url.port || 80);
  let firstErr;
  const tryHost = (i) =>
    new Promise((resolve, reject) => {
      const rq = http.get({ host: hosts[i], port, path: url.pathname + url.search, headers: { host: url.host }, timeout: 15_000 }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (d) => body.length < 4000 && (body += d));
        r.on('end', () => resolve({ status: r.statusCode, body: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) }));
      });
      rq.on('timeout', () => rq.destroy(new Error('timed out')));
      rq.on('error', (e) => {
        firstErr ||= e;
        if (i + 1 < hosts.length && e.message !== 'timed out') tryHost(i + 1).then(resolve, reject);
        else reject(firstErr);
      });
    });
  return tryHost(0).catch((e) => {
    throw new Error(e.code === 'ECONNREFUSED' ? `Nothing is waiting on port ${port} any more. The sign-in may have timed out or the app that started it stopped. Start the sign-in again.` : `Could not deliver it: ${e.message}`);
  });
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
  res.json({ projectsRoot: config.projectsRoot, scratchDir: config.scratchDir, allowAnyDir: config.allowAnyDir, hostname: process.env.HOSTNAME || '', browser: browserAvailable() });
});

// ---------- Claude Desktop handoff MCP + shared notes ----------
app.get('/api/desktop-mcp', (req, res) => {
  if (!config.desktopMcp) return res.json({ enabled: false });
  res.json({ enabled: true, token: getMcpToken(), fromEnv: !!process.env.CW_MCP_TOKEN, host: config.host, port: config.port, hostname: config.inDocker ? '' : os.hostname(), publicUrl: config.publicUrl, inDocker: config.inDocker });
});
app.post(
  '/api/desktop-mcp/token',
  wrap(async (req, res) => res.json({ token: rotateMcpToken() }))
);
const notesProject = (p) => (p && p !== 'global' ? resolveDir(String(p)) : null);
app.get(
  '/api/notes',
  wrap(async (req, res) => res.json(notes.notesOp('list', { query: req.query.q, limit: 200, scope: req.query.project ? undefined : 'global' }, { projectDir: notesProject(req.query.project) })))
);
app.get(
  '/api/notes/:id',
  wrap(async (req, res) => res.json(notes.notesOp('read', { id: req.params.id, scope: req.query.project ? 'project' : 'global' }, { projectDir: notesProject(req.query.project) })))
);
app.post(
  '/api/notes',
  wrap(async (req, res) => res.json(notes.notesOp('write', { ...req.body, append: false, scope: req.body?.project ? 'project' : 'global' }, { projectDir: notesProject(req.body?.project), source: 'you (Settings)' })))
);
app.delete(
  '/api/notes/:id',
  wrap(async (req, res) => res.json(notes.notesOp('delete', { id: req.params.id, scope: req.query.project ? 'project' : 'global' }, { projectDir: notesProject(req.query.project) })))
);

// ---------- projects ----------
async function listProjects() {
  const root = config.projectsRoot;
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  // Sessions and last use per folder. Worktree chats count for the folder they came from.
  const counts = {};
  const lastUsed = {};
  for (const s of store.list()) {
    const p = s.project || s.cwd;
    if (!p || isScratch(p)) continue;
    counts[p] = (counts[p] || 0) + 1;
    lastUsed[p] = Math.max(lastUsed[p] || 0, s.lastActivity || s.createdAt || 0);
  }
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
    projects.push({ name: e.name, path: p, git: fs.existsSync(path.join(p, '.git')), sessions: counts[p] || 0, lastUsed: lastUsed[p] || 0 });
  }
  // Directories used by sessions that aren't direct children of the root.
  for (const cwd of Object.keys(counts)) {
    if (!seen.has(cwd) && fs.existsSync(cwd)) {
      projects.push({ name: path.relative(rootReal, cwd) || path.basename(cwd), path: cwd, git: fs.existsSync(path.join(cwd, '.git')), sessions: counts[cwd], lastUsed: lastUsed[cwd] || 0 });
    }
  }
  // Most recently used first, then the rest by name.
  projects.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
  return { root: rootReal, scratch: config.scratchDir, rootCaseHint: rootCaseWarning(), projects };
}

app.get(
  '/api/projects',
  wrap(async (req, res) => res.json(await listProjects()))
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
    const { cwd, kind, name, resume, model, permissionMode, effort, worktree, parentId, noFolder } = req.body || {};
    const project = noFolder ? fs.realpathSync(config.scratchDir) : resolveDir(cwd);
    const wt = worktree && !noFolder ? await createWorktree(project, name || 'chat') : null;
    const dir = wt ? wt.path : project;
    if (resume && resume !== 'continue' && !/^[0-9a-f-]{36}$/i.test(resume)) throw new Error('Bad resume id');
    const s = store.create({ cwd: dir, kind, name: name ? String(name).slice(0, 80) : isScratch(project) ? 'New chat' : undefined, resume, model, permissionMode, effort, initialInput: req.body?.login && kind === 'claude' ? '/login\r' : undefined });
    if (name) s.meta.customName = true;
    s.meta.project = project;
    if (isScratch(project)) s.meta.noFolder = true;
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
  '/api/sessions/:id/fork',
  wrap(async (req, res) => {
    const src = getSession(req);
    if (src.meta.kind !== 'chat') throw new Error('Only chats can be forked');
    const m = src.meta;
    const t = store.create({ cwd: m.cwd, kind: 'chat', name: `${m.name} (fork)`.slice(0, 80), model: m.model, permissionMode: m.permissionMode, effort: m.effort });
    t.meta.project = m.project || m.cwd;
    if (m.worktree) t.meta.worktree = m.worktree;
    t.meta.customName = true;
    src.forkInto(t, Number.isInteger(req.body?.index) ? req.body.index : undefined);
    store.save();
    res.json({ session: t.toJSON() });
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

// ---------- MCP sign-in (OAuth) ----------
// The provider redirects to localhost on this machine. Sign-in pages open in the server's own browser
// (the sign-in window), so that redirect lands by itself. Without a server browser the page opens on
// the user's device and the UI posts the failed localhost address back to /api/oauth/callback.
function chatOf(req) {
  const s = getSession(req);
  if (s.meta.kind !== 'chat') throw new Error('MCP sign-in from here works in chats; in a terminal session run /mcp');
  return s;
}
app.post('/api/sessions/:id/mcp/status', wrap(async (req, res) => res.json({ servers: await chatOf(req).mcpStatus({ start: !!req.body?.start }) })));
app.post(
  '/api/signin-page',
  wrap(async (req, res) => {
    openSigninPage(req.body?.url, { server: req.body?.server ? String(req.body.server).slice(0, 80) : null });
    res.json({ ok: true });
  })
);
app.post(
  '/api/sessions/:id/mcp/auth',
  wrap(async (req, res) => {
    const s = chatOf(req);
    res.json(signinInBrowser(await s.mcpAuthenticate(req.body?.name), req.body?.name, s.id));
  })
);
// Open a Sign in in the built-in browser when there is one: its redirect to localhost then lands
// on this machine and the sign-in finishes by itself. Without it, the UI opens it on the device.
function signinInBrowser(r, server, sid) {
  if (!r?.authUrl || !browserAvailable()) return r;
  openSigninPage(r.authUrl, { sid, server });
  return { ...r, inBrowser: true, server };
}
app.post(
  '/api/oauth/callback',
  wrap(async (req, res) => {
    const url = parseCallbackUrl(req.body?.url);
    // A sign-in Claude started in one of our chats: hand it the URL so it checks the state and finishes.
    const prefer = req.body?.sessionId ? store.get(req.body.sessionId) : null;
    const chats = [prefer, ...store.sessions.values()].filter((s) => s && s.meta.kind === 'chat' && s.oauth?.size);
    for (const s of [...chats, ...McpAdmin.all()]) {
      const name = s.oauthFlowFor(url);
      if (name) return res.json({ ...(await s.mcpCallback(name, url.toString())), server: name, sessionId: s.meta ? s.id : undefined });
    }
    // Anything else listening on this machine (a terminal's /mcp, an MCP server's own login): replay it.
    const r = await replayLoopback(url);
    res.json({ ok: r.status < 400, replayed: true, status: r.status, body: r.body });
  })
);

// Settings → MCP logins: a background claude process per folder (McpAdmin) does the sign-ins.
const adminFor = (cwd) => McpAdmin.for(cwd ? resolveDir(cwd) : config.projectsRoot);
app.get(
  '/api/mcp-logins',
  wrap(async (req, res) => {
    const a = adminFor(req.query.cwd);
    await a.mcpStatus({ start: true });
    res.json(a.snapshot());
  })
);
app.post(
  '/api/mcp-logins/:action',
  wrap(async (req, res) => {
    const a = adminFor(req.body?.cwd);
    const name = String(req.body?.name || '');
    const act = req.params.action;
    let out = {};
    if (act === 'signin') out = signinInBrowser(await a.mcpAuthenticate(name), name);
    else if (act === 'signout') out = await a.mcpSignOut(name);
    else if (act === 'reconnect') {
      a.ensureProcess();
      await a.mcpReconnect(name);
    } else if (act === 'cancel') a.cancelSignIn(name);
    else if (act === 'elicit') a.answerElicit(req.body || {});
    else throw new Error('Unknown action');
    res.json({ ...out, ...a.snapshot() });
  })
);
// After a sign-in anywhere, running chats (and other folders' helpers) pick the server up again.
onSignedIn((name, from) => {
  const hosts = [...[...store.sessions.values()].filter((s) => s.meta.kind === 'chat' && s.running), ...McpAdmin.all().filter((a) => a.proc)];
  for (const h of hosts) {
    if (h === from) continue;
    const s = h.mcpServerList().find((x) => x.name === name);
    if (s && s.status !== 'connected') setTimeout(() => h.mcpReconnect(name), 1500);
  }
});

app.get(
  '/api/sessions/:id/changes',
  wrap(async (req, res) => {
    res.json(await getChanges(getSession(req).meta.cwd));
  })
);

app.get(
  '/api/sessions/:id/pr',
  wrap(async (req, res) => res.json(await prStatus(getSession(req).meta.cwd)))
);
app.post(
  '/api/sessions/:id/pr/merge-when-ready',
  wrap(async (req, res) => res.json(await mergeWhenReady(getSession(req).meta.cwd, parseInt(req.body?.number, 10))))
);

// Side chat: streams the answer as NDJSON lines ({d: text} … then {done} or {error}).
app.post('/api/sessions/:id/btw', (req, res) => {
  let s;
  try {
    s = getSession(req);
    if (s.meta.kind !== 'chat') throw new Error('Side chat works in chats only');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const q = String(req.body?.question || '').trim();
  if (!q) return res.status(400).json({ error: 'Ask something' });
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const write = (o) => res.write(JSON.stringify(o) + '\n');
  const stop = sideChat(s, q, req.body?.history, {
    onDelta: (d) => write({ d }),
    onDone: (r) => {
      write(r.error ? { error: r.error } : { done: true });
      res.end();
    },
  });
  res.on('close', () => !res.writableEnded && stop());
});

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
const browserTabOf = (req) => (browser.isSigninId(req.params.id) ? req.params.id : getSession(req).id);
app.get('/api/signin-pages', (req, res) => res.json({ pages: browser.signinList() }));
app.post('/api/signin-pages/:id/close', wrap(async (req, res) => res.json({ ok: !!(await browser.closeSignin(req.params.id), true) })));
app.get(
  '/api/sessions/:id/browser',
  wrap(async (req, res) => {
    browserTabOf(req);
    res.json(await browser.state(req.params.id));
  })
);
app.get(
  '/api/sessions/:id/browser/frame',
  wrap(async (req, res) => {
    browserTabOf(req);
    const buf = await browser.screenshot(req.params.id, { type: 'jpeg', quality: 70 });
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/jpeg').send(buf);
  })
);
app.post(
  '/api/sessions/:id/browser/:op',
  wrap(async (req, res) => {
    browserTabOf(req);
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
app.get('/api/claude/models', wrap(async (req, res) => res.json({ models: await getModels() })));
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
// One-off notices for every open UI (e.g. "a sign-in page opened"), next to the session list.
const uiEvents = new Set();
function emitUi(msg) {
  const data = JSON.stringify(msg);
  for (const ws of uiEvents) if (ws.readyState === 1) ws.send(data);
}

function handleEvents(ws) {
  uiEvents.add(ws);
  ws.on('close', () => uiEvents.delete(ws));
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
      if (msg.t === 'send') {
        if (!msg.images?.length && /^!\s*\S/.test(msg.text || '')) return s.runShell(msg.text.replace(/^!\s*/, ''));
        if (!(msg.images?.length) && (await s.runLocalCommand(msg.text))) return;
        s.send(msg);
      }
      else if (msg.t === 'perm') s.answerPermission(msg);
      else if (msg.t === 'elicit') s.answerElicit(msg);
      else if (msg.t === 'interrupt') await s.interrupt();
      else if (msg.t === 'mode') await s.setMode(msg.mode);
      else if (msg.t === 'model') await s.setModel(msg.model);
      else if (msg.t === 'stop') s.stop();
      else if (msg.t === 'resume') await s.resume();
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
// Each run is a new chat in the task's folder (optionally its own worktree), named after the task.
if (config.schedules) schedules.startScheduler(async (t) => {
  const project = resolveDir(t.cwd);
  const wt = t.worktree ? await createWorktree(project, t.name) : null;
  const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const s = store.create({ cwd: wt ? wt.path : project, kind: 'chat', name: `${t.name} · ${when}`.slice(0, 80), model: t.model || undefined, permissionMode: t.permissionMode, effort: t.effort || undefined });
  s.meta.customName = true;
  s.meta.project = project;
  s.meta.scheduleId = t.id;
  if (wt) s.meta.worktree = wt;
  s.send({ text: t.prompt });
  store.save();
  return s.id;
});

server.listen(config.port, config.host, () => {
  const h = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  config.internalUrl = `http://${h}:${config.port}`;
  console.log(`claude-web listening on http://${config.host}:${config.port}`);
  console.log(`projects root: ${config.projectsRoot}`);
  if (rootCaseWarning()) console.warn(`warning: CW_PROJECTS_ROOT differs in letter case from your home folder. Use ${rootCaseWarning()} so Claude here and Claude on the host file sessions under the same folder.`);
  console.log(`data dir:      ${config.dataDir}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: saving sessions and shutting down`);
  store.shutdown();
  stopAllAdmins();
  browser.shutdown();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
