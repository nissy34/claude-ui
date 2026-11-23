import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { claudeEnv } from './gateway.js';
import { sessionExtras } from './environments.js';
import { ChatSession, claudeProjectDir, transcriptPath } from './chat.js';

export { claudeProjectDir, transcriptPath };

import { withOpener } from './opener.js';
import { resolveCommand, defaultShell } from './launch.js';

const require = createRequire(import.meta.url);
// node-pty is optional: without it, chat sessions still work and terminal sessions are disabled.
let pty = null;
let ptyError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyError = e.message;
}
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const OSC_RE = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const META_FILE = path.join(config.dataDir, 'sessions.json');
const SCREEN_DIR = path.join(config.dataDir, 'screens');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

function transcriptExists(cwd, id) {
  return !!id && fs.existsSync(transcriptPath(cwd, id));
}

function childEnv(sid, meta) {
  const env = { ...claudeEnv(sessionExtras(meta).env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  return withOpener(env, sid);
}

class Session {
  constructor(meta) {
    this.meta = meta; // persisted fields
    this.proc = null;
    this.clients = new Set();
    this.cols = meta.cols || 120;
    this.rows = meta.rows || 32;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: config.scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.dirty = false;
    // Restore last saved screen so history survives restarts.
    try {
      const saved = fs.readFileSync(this.screenFile, 'utf8');
      if (saved) this.term.write(saved);
    } catch {}
  }

  get id() {
    return this.meta.id;
  }
  get screenFile() {
    return path.join(SCREEN_DIR, `${this.meta.id}.txt`);
  }
  get running() {
    return !!this.proc;
  }

  toJSON() {
    return { ...this.meta, status: this.running ? 'running' : 'exited', clients: this.clients.size };
  }

  start({ resume } = {}) {
    if (this.proc) return;
    const m = this.meta;
    let file, args;
    if (m.kind === 'shell') {
      ({ file, args } = defaultShell());
    } else {
      file = config.claudeBin;
      args = [...config.claudeArgs];
      if (resume === 'continue') {
        args.push('--continue');
      } else if (resume) {
        args.push('--resume', resume);
        m.claudeSessionId = resume;
      } else if (transcriptExists(m.cwd, m.claudeSessionId)) {
        args.push('--resume', m.claudeSessionId);
      } else {
        m.claudeSessionId = m.claudeSessionId || crypto.randomUUID();
        args.push('--session-id', m.claudeSessionId);
      }
    }

    if (m.startedOnce) {
      this.term.write(`\r\n\x1b[2m── restarted ${new Date().toLocaleString()} ──\x1b[0m\r\n`);
    }
    m.startedOnce = true;

    let proc;
    try {
      if (!pty) throw new Error(`terminal sessions need the node-pty package, which failed to load (${ptyError}). Chat sessions still work.`);
      ({ file, args } = resolveCommand(file, args));
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: m.cwd,
        env: childEnv(this.meta.id, this.meta),
      });
    } catch (err) {
      const msg = `\r\n\x1b[31mFailed to start ${file}: ${err.message}\x1b[0m\r\n`;
      this.term.write(msg);
      this.broadcast({ t: 'o', d: msg });
      m.exitCode = -1;
      store.save();
      return;
    }
    this.proc = proc;
    m.pid = proc.pid;
    m.exitCode = null;
    m.lastActivity = Date.now();
    m.command = [file, ...args].join(' ');

    proc.onData((d) => {
      this.term.write(d);
      this.dirty = true;
      m.lastActivity = Date.now();
      // Window-title escapes (OSC 0/2) carry Claude's task summary; a bare BEL means "needs you".
      let changed = false;
      const stripped = d.replace(OSC_RE, (_, code, text) => {
        if ((code === '0' || code === '2') && text && text !== m.title) {
          m.title = text.slice(0, 120);
          changed = true;
        }
        return '';
      });
      if (stripped.includes('\x07') && !m.attention) {
        m.attention = true;
        changed = true;
      }
      if (changed) store.changed();
      this.broadcast({ t: 'o', d });
    });
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      m.pid = null;
      m.exitCode = exitCode;
      m.lastActivity = Date.now();
      const msg = `\r\n\x1b[2m── process exited (code ${exitCode}) ──\x1b[0m\r\n`;
      this.term.write(msg);
      this.broadcast({ t: 'o', d: msg });
      this.broadcast({ t: 'exit', code: exitCode });
      this.saveScreen(true);
      store.save();
    });
    store.save();
  }

  kill() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      const p = this.proc;
      setTimeout(() => {
        if (this.proc === p) {
          try {
            process.kill(p.pid, 'SIGKILL');
          } catch {}
        }
      }, 3000);
    }
  }

  write(data) {
    if (this.proc) this.proc.write(data);
    if (this.meta.attention) {
      this.meta.attention = false;
      store.changed();
    }
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.meta.cols = cols;
    this.meta.rows = rows;
    this.term.resize(cols, rows);
    this.broadcast({ t: 'size', cols, rows });
    if (this.proc) {
      try {
        this.proc.resize(cols, rows);
      } catch {}
    }
  }

  snapshot() {
    return this.serializer.serialize({ scrollback: config.scrollback });
  }

  saveScreen(force = false) {
    if (!force && !this.dirty) return;
    this.dirty = false;
    try {
      fs.writeFileSync(this.screenFile, this.snapshot());
    } catch (e) {
      console.error('saveScreen failed', e.message);
    }
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  dispose() {
    this.kill();
    for (const ws of this.clients) ws.close(4004, 'session deleted');
    this.term.dispose();
    try {
      fs.unlinkSync(this.screenFile);
    } catch {}
  }
}

class Store {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch {}
    for (const meta of list) {
      // Processes don't survive a server restart; they're shown as exited and can be resumed.
      meta.pid = null;
      this.sessions.set(meta.id, meta.kind === 'chat' ? new ChatSession(meta, this) : new Session(meta));
    }
    // Messages queued for a chat when the server stopped: deliver them now.
    setTimeout(() => {
      for (const s of this.sessions.values()) if (s.meta.kind === 'chat' && s.inbox.length) s.flushInbox();
    }, 2000).unref?.();
    this.saveTimer = setInterval(() => {
      for (const s of this.sessions.values()) s.saveScreen();
    }, 10_000);
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON()).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(id) {
    return this.sessions.get(id);
  }

  create({ cwd, kind = 'chat', name, resume, model, permissionMode, effort, initialInput }) {
    const id = crypto.randomUUID();
    kind = ['chat', 'claude', 'shell'].includes(kind) ? kind : 'chat';
    const meta = {
      id,
      kind,
      name: name || path.basename(cwd),
      cwd,
      claudeSessionId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      exitCode: null,
      attention: false,
    };
    let s;
    if (kind === 'chat') {
      if (resume === 'continue') resume = latestTranscript(cwd);
      if (resume) meta.claudeSessionId = resume;
      if (model) meta.model = String(model).slice(0, 100);
      // No mode given: the server default (CW_DEFAULT_MODE, Auto). 'default' asks before edits.
      if (permissionMode == null || permissionMode === '') permissionMode = config.defaultMode;
      if (['auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permissionMode)) meta.permissionMode = permissionMode;
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) meta.effort = effort;
      s = new ChatSession(meta, this);
      if (resume) s.seedFromTranscript();
      this.sessions.set(id, s);
    } else {
      s = new Session(meta);
      this.sessions.set(id, s);
      s.start({ resume });
      // e.g. type /login into a fresh claude TUI once it has started
      if (initialInput) setTimeout(() => s.write(initialInput), 3000);
    }
    this.save();
    return s;
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    s.dispose();
    // Files and pictures sent in the chat go with it.
    if (/^[0-9a-f-]{36}$/.test(id)) fs.rmSync(path.join(config.dataDir, 'uploads', id), { recursive: true, force: true });
    this.save();
    return true;
  }

  save() {
    const list = [...this.sessions.values()].map((s) => s.meta);
    const tmp = META_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, META_FILE);
    this.changed();
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  shutdown() {
    this.shuttingDown = true;
    clearInterval(this.saveTimer);
    for (const s of this.sessions.values()) {
      s.saveScreen(true);
    }
    this.save();
    for (const s of this.sessions.values()) (s.shutdown ? s.shutdown() : s.kill());
  }
}

function latestTranscript(cwd) {
  try {
    const dir = claudeProjectDir(cwd);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let best = null;
    for (const f of files) {
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || t > best.t) best = { t, id: f.slice(0, -6) };
    }
    return best?.id || null;
  } catch {
    return null;
  }
}

export const store = new Store();
