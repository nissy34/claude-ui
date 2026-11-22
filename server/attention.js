// Attention feed: everything that is waiting on the user, across chats and projects, for a
// companion service such as the Teams bridge (teams-bridge/). It reads the same state the web UI
// shows and answers through the same code paths, so an answer from Teams and an answer in the UI
// are the same thing: whichever comes first wins and the other side sees it as answered.
//
// HTTP API under /api/bridge/*, bearer token (CW_BRIDGE_TOKEN or ~/.claude-web/bridge-token),
// never reachable from a browser page:
//   GET  /api/bridge/attention          open items now (permission prompts, questions, sign-ins, decisions)
//   GET  /api/bridge/events?after=N     long-poll for new events (asks, resolutions, coordinator posts,
//                                       finished turns of chats started from the bridge, notify_user)
//   POST /api/bridge/answer             { id, choice?, text?, behavior?, always? }
//   POST /api/bridge/act                { action, ... } start work: project_send, new_chat, send, stop, status
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { loginAllowed, loginFailed } from './auth.js';
import { controlSession } from './session-control.js';

const TOKEN_FILE = path.join(config.dataDir, 'bridge-token');
const RING = 500;
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

let token = process.env.CW_BRIDGE_TOKEN || '';
if (!token) {
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    try {
      fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    } catch {}
  }
}
export const getBridgeToken = () => token;

function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const got = m ? m[1].trim() : '';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return !!got && crypto.timingSafeEqual(a, b);
}

/** A one-line description of what a tool wants to do, for a permission card. */
export function describeTool(tool, input = {}) {
  const i = input || {};
  switch (tool) {
    case 'Bash':
      return clip(i.command || '', 600);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return clip(i.file_path || i.notebook_path || '', 300);
    case 'WebFetch':
      return clip(i.url || '', 300);
    case 'WebSearch':
      return clip(i.query || '', 300);
    case 'ExitPlanMode':
      return clip(i.plan || '', 1500);
    default: {
      const s = JSON.stringify(i);
      return clip(s === '{}' ? '' : s, 400);
    }
  }
}

export function createAttention({ store, engine, resolveDir, listProjects, desktopRun, onStatus }) {
  let bridgeStatus = null;
  const ring = []; // { seq, ts, ...event }
  let seq = 0;
  const waiters = new Set();
  let lastSeen = 0; // the last time a visible UI tab reported in

  function push(ev) {
    const e = { seq: ++seq, ts: Date.now(), ...ev };
    ring.push(e);
    if (ring.length > RING) ring.shift();
    for (const w of [...waiters]) w();
    return e;
  }

  const sessionInfo = (s) => {
    const p = engine?.projectOf(s);
    const t = p?.state.threads[s.id];
    return {
      id: s.id,
      name: s.meta.name,
      ...(p ? { project: { id: p.id, name: p.settings.name }, thread: t ? t.title : p.coordinatorId === s.id ? 'coordinator' : null } : {}),
    };
  };

  function permItem(s, p) {
    const base = { id: `perm:${s.id}:${p.reqId}`, session: sessionInfo(s), ts: p.ts };
    if (p.tool === 'AskUserQuestion') {
      const qs = Array.isArray(p.input?.questions) ? p.input.questions : [];
      return {
        ...base,
        kind: 'question',
        questions: qs.map((q) => ({ question: clip(q.question, 500), header: q.header || null, multiSelect: !!q.multiSelect, options: (q.options || []).map((o) => ({ label: clip(o.label, 120), description: clip(o.description || '', 200) })) })),
      };
    }
    if (p.tool === 'ExitPlanMode') return { ...base, kind: 'plan', tool: p.tool, detail: describeTool(p.tool, p.input) };
    return { ...base, kind: 'permission', tool: p.tool, detail: describeTool(p.tool, p.input), canAlways: Array.isArray(p.suggestions) && p.suggestions.length > 0, reason: p.reason ? clip(typeof p.reason === 'string' ? p.reason : JSON.stringify(p.reason), 200) : null };
  }

  function elicitItem(s, e) {
    // Forms can ask for passwords: those stay in the UI. Only links go out.
    return { id: `elicit:${s.id}:${e.reqId}`, kind: 'signin', session: sessionInfo(s), ts: e.ts, server: e.server, message: clip(e.message, 500), url: e.mode === 'url' ? e.url : null, form: e.mode !== 'url' };
  }

  function decisionItem(p, d) {
    return {
      id: `decision:${p.id}:${d.id}`,
      kind: 'decision',
      project: { id: p.id, name: p.settings.name },
      thread: d.thread ? p.state.threads[d.thread]?.title || null : 'coordinator',
      ts: d.ts,
      question: d.question,
      options: d.options.map((o) => ({ label: o.label, consequence: o.consequence || '' })),
      recommended: d.recommended,
      irreversible: !!d.irreversible,
    };
  }

  function openDecisions(p) {
    return Object.values(p.state.decisions || {}).filter((x) => !x.answer);
  }

  function list() {
    const items = [];
    for (const s of store.sessions.values()) {
      if (s.meta.kind !== 'chat' || s.meta.archived) continue;
      for (const p of s.pending?.values?.() || []) items.push(permItem(s, p));
      for (const e of s.elicits?.values?.() || []) items.push(elicitItem(s, e));
    }
    if (engine) for (const p of engine.projects.values()) for (const d of openDecisions(p)) items.push(decisionItem(p, d));
    return items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  // ---------- hooks: chats ----------
  const permTools = new Map(); // request id -> tool, to word the answer
  store.recordHooks ||= new Set();
  store.recordHooks.add((s, ev) => {
    switch (ev.k) {
      case 'perm':
        permTools.set(ev.reqId, ev.tool);
        return push({ type: 'ask', item: permItem(s, ev) });
      case 'elicit':
        return push({ type: 'ask', item: elicitItem(s, ev) });
      case 'perm_done': {
        const tool = permTools.get(ev.reqId);
        permTools.delete(ev.reqId);
        const answer = ev.behavior === 'allow' ? (tool === 'AskUserQuestion' ? 'answered' : ev.always ? 'always allowed' : 'allowed') : ev.behavior === 'deny' ? (tool === 'AskUserQuestion' ? 'declined' : 'denied') : ev.behavior;
        return push({ type: 'resolved', id: `perm:${s.id}:${ev.reqId}`, answer, by: s.lastAnswerBy || 'ui' });
      }
      case 'elicit_done':
        return push({ type: 'resolved', id: `elicit:${s.id}:${ev.reqId}`, answer: ev.action, by: s.lastAnswerBy || 'ui' });
      case 'result':
        // Turn updates only for chats the bridge started or wrote to; projects report through their coordinator.
        if (s.meta.bridge && !s.meta.cproject) push({ type: 'turn', session: sessionInfo(s), isError: !!ev.isError, text: clip(ev.isError ? ev.text || 'The turn failed.' : s.lastReply(), 3000) });
        return;
    }
  });

  // ---------- hooks: projects ----------
  if (engine) {
    engine.eventHooks ||= new Set();
    engine.eventHooks.add((p, ev) => {
      if (ev.type === 'decision.requested') {
        const d = openDecisions(p).find((x) => x.id === ev.body.id);
        if (d) push({ type: 'ask', item: decisionItem(p, d) });
      } else if (ev.type === 'decision.answered' || ev.type === 'decision.withdrawn') {
        push({ type: 'resolved', id: `decision:${p.id}:${ev.body.id}`, answer: ev.body.label || (ev.type === 'decision.withdrawn' ? 'withdrawn' : ''), by: ev.from?.via === 'bridge' || p.lastAnswerBy === 'bridge' ? 'bridge' : 'ui' });
      } else if (ev.type === 'chat.post') {
        push({ type: 'post', project: { id: p.id, name: p.settings.name }, text: clip(ev.body.text, 3000) });
      }
    });
  }

  // ---------- answers ----------
  function parseId(id) {
    const m = /^(perm|elicit|decision):([^:]+):(.+)$/.exec(String(id || ''));
    if (!m) throw new Error(`Unknown item "${id}"`);
    return { kind: m[1], a: m[2], b: m[3] };
  }

  function answer({ id, choice, text, behavior, always, answers }) {
    const { kind, a, b } = parseId(id);
    if (kind === 'decision') {
      const p = engine?.projects.get(a);
      if (!p) throw new Error('That project is gone.');
      const d = openDecisions(p).find((x) => x.id === b);
      if (!d) return { ok: false, already: true, note: 'Already answered or withdrawn.' };
      let i = choice;
      if (typeof i !== 'number') {
        const t = String(text ?? choice ?? '').trim().toLowerCase();
        i = /^\d+$/.test(t) ? Number(t) - 1 : d.options.findIndex((o) => o.label.toLowerCase() === t);
        if (i < 0) i = d.options.findIndex((o) => o.label.toLowerCase().startsWith(t));
      }
      if (!(i >= 0 && i < d.options.length)) throw new Error(`Pick 1 to ${d.options.length}.`);
      p.lastAnswerBy = 'bridge';
      try {
        const ev = engine.answerDecision(p, b, { choice: i, note: typeof choice === 'number' ? text || '' : '' }, { by: 'user' });
        return { ok: true, answered: ev.body.label };
      } finally {
        p.lastAnswerBy = null;
      }
    }
    const s = store.get(a);
    if (!s) throw new Error('That chat is gone.');
    s.lastAnswerBy = 'bridge';
    try {
      if (kind === 'elicit') {
        if (!s.elicits.has(b)) return { ok: false, already: true, note: 'Already answered.' };
        const act = ['accept', 'decline', 'cancel'].includes(behavior) ? behavior : 'accept';
        if (act === 'accept' && s.elicits.get(b).mode !== 'url') throw new Error('This sign-in is a form; fill it in in the web UI.');
        s.answerElicit({ reqId: b, action: act });
        return { ok: true, answered: act };
      }
      const p = s.pending.get(b);
      if (!p) return { ok: false, already: true, note: 'Already answered.' };
      if (p.tool === 'AskUserQuestion') {
        if (behavior === 'deny') {
          s.answerPermission({ reqId: b, behavior: 'deny', message: text || 'The user declined to answer.' });
          return { ok: true, answered: 'declined' };
        }
        const qs = Array.isArray(p.input?.questions) ? p.input.questions : [];
        let out = answers && typeof answers === 'object' ? answers : null;
        if (!out) {
          // One reply answers the questions in order: "2", "Blue", or "1, 3" per line for several questions.
          const lines = qs.length > 1 ? String(text ?? choice ?? '').split(/\n|;/).map((x) => x.trim()) : [String(text ?? choice ?? '').trim()];
          out = {};
          qs.forEach((q, qi) => {
            const raw = lines[qi] ?? '';
            const opts = q.options || [];
            const parts = q.multiSelect ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [raw];
            const picked = parts.map((x) => (/^\d+$/.test(x) && opts[Number(x) - 1] ? opts[Number(x) - 1].label : opts.find((o) => o.label.toLowerCase() === x.toLowerCase())?.label || x));
            out[q.question] = picked.join(', ');
          });
        }
        if (Object.values(out).some((v) => !String(v).trim())) throw new Error('Every question needs an answer.');
        s.answerPermission({ reqId: b, behavior: 'allow', updatedInput: { ...p.input, answers: out } });
        return { ok: true, answered: Object.values(out).join(' / ') };
      }
      const allow = behavior === 'allow' || behavior === 'always';
      s.answerPermission({ reqId: b, behavior: allow ? 'allow' : 'deny', always: allow && (always || behavior === 'always'), ...(allow ? {} : { message: text ? `The user denied this from Teams: ${text}` : 'The user denied this action.' }) });
      return { ok: true, answered: allow ? (always || behavior === 'always' ? 'always allowed' : 'allowed') : 'denied' };
    } finally {
      s.lastAnswerBy = null;
    }
  }

  // ---------- starting work ----------
  function project(id) {
    if (!engine) throw new Error('Projects are not available on this server.');
    const key = String(id || '').trim().toLowerCase();
    const all = [...engine.projects.values()].filter((p) => !p.settings.archived);
    const hit = engine.projects.get(String(id || '').trim()) || all.find((p) => p.settings.name.toLowerCase() === key) || (key && all.filter((p) => p.settings.name.toLowerCase().includes(key)).length === 1 ? all.find((p) => p.settings.name.toLowerCase().includes(key)) : null);
    if (!hit) throw new Error(`No project "${id}". Projects: ${all.map((p) => p.settings.name).join(', ') || 'none'}`);
    return hit;
  }

  function chatOf(id) {
    const key = String(id || '').trim();
    const s = store.get(key);
    if (s) return s;
    const lower = key.toLowerCase();
    const hits = [...store.sessions.values()].filter((x) => x.meta.kind === 'chat' && !x.meta.archived && String(x.meta.name || '').toLowerCase().includes(lower));
    if (hits.length === 1) return hits[0];
    throw new Error(hits.length ? `"${id}" matches ${hits.length} chats; be more specific.` : `No chat "${id}".`);
  }

  async function folderPath(name) {
    const raw = String(name || '').trim();
    if (!raw) throw new Error('Which folder?');
    try {
      const dir = resolveDir(raw);
      if (fs.existsSync(dir)) return dir;
    } catch {}
    const list = await listProjects();
    const rows = list.projects || list.folders || list || [];
    const lower = raw.toLowerCase();
    const names = rows.map((r) => (typeof r === 'string' ? { name: r, path: r } : r));
    const hit = names.find((r) => r.name?.toLowerCase() === lower) || (names.filter((r) => r.name?.toLowerCase().includes(lower)).length === 1 ? names.find((r) => r.name?.toLowerCase().includes(lower)) : null);
    if (!hit) throw new Error(`No folder "${raw}".`);
    return resolveDir(hit.path || hit.name);
  }

  async function act(a = {}) {
    switch (a.action) {
      case 'project_send': {
        const p = project(a.project);
        engine.userMessage(p, String(a.text || ''), { from: 'user' });
        return { ok: true, target: { type: 'project', id: p.id, name: p.settings.name } };
      }
      case 'new_chat': {
        const dir = await folderPath(a.folder);
        const text = String(a.text || '').trim();
        if (!text) throw new Error('What should it do?');
        const s = store.create({ cwd: dir, kind: 'chat', name: clip(text.split('\n')[0], 80) });
        s.meta.project = dir;
        s.meta.bridge = true;
        s.send({ text });
        store.save();
        store.changed?.();
        return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name } };
      }
      case 'send': {
        const s = chatOf(a.chat);
        if (s.meta.kind !== 'chat') throw new Error('That is a terminal session.');
        if (s.meta.cproject) {
          // A project thread: steer it through its project so the coordinator sees it.
          const p = engine.projectOf(s);
          if (p.coordinatorId === s.id) {
            engine.userMessage(p, String(a.text || ''), { from: 'user' });
            return { ok: true, target: { type: 'project', id: p.id, name: p.settings.name } };
          }
          engine.steerThread(p, s.id, String(a.text || ''), { from: 'user' });
          return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name } };
        }
        s.meta.bridge = true;
        const r = s.deliver({ text: String(a.text || '') });
        return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name }, queued: !!r?.queued };
      }
      case 'stop': {
        const s = chatOf(a.chat);
        return { ...(await controlSession(store, s, 'stop', {}, 'you, from Teams')), target: { type: 'chat', id: s.id, name: s.meta.name } };
      }
      case 'status': {
        const busy = [...store.sessions.values()].filter((s) => s.meta.kind === 'chat' && !s.meta.archived && !s.meta.cproject && s.state === 'busy').map((s) => ({ id: s.id, name: s.meta.name }));
        const projects = engine ? (await desktopRun('projects_list', {})).projects : [];
        return { busyChats: busy, projects, waiting: list().length };
      }
      case 'folders':
        return listProjects();
      default:
        throw new Error(`Unknown action ${a.action}`);
    }
  }

  // ---------- HTTP ----------
  function mount(app) {
    app.use('/api/bridge', (req, res, next) => {
      if (req.headers.origin) return res.status(403).json({ error: 'Browser requests are not allowed' });
      if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many failed attempts, try again later.' });
      if (!tokenOk(req)) {
        loginFailed(req.ip);
        return res.status(401).json({ error: 'Missing or wrong bridge token.' });
      }
      next();
    });
    app.get('/api/bridge/attention', (req, res) => res.json({ seq, items: list(), lastSeen }));
    app.get('/api/bridge/events', (req, res) => {
      const after = Number(req.query.after) || 0;
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 50) * 1000;
      const send = () => {
        // A restart resets seq: a bridge asking for events after a higher seq gets everything.
        const from = after > seq ? 0 : after;
        res.json({ seq, lastSeen, events: ring.filter((e) => e.seq > from) });
      };
      if (ring.some((e) => e.seq > after) || after > seq || !wait) return send();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        waiters.delete(finish);
        clearTimeout(timer);
        send();
      };
      const timer = setTimeout(finish, wait);
      waiters.add(finish);
      req.on('close', () => {
        done = true;
        waiters.delete(finish);
        clearTimeout(timer);
      });
    });
    // The bridge reports its own state (e.g. "sign in with this code"), shown in the web UI.
    app.post('/api/bridge/status', (req, res) => {
      const b = req.body || {};
      bridgeStatus = { state: clip(b.state, 20), message: clip(b.message, 500), code: b.code ? clip(b.code, 20) : null, url: b.url ? clip(b.url, 200) : null, at: Date.now() };
      onStatus?.(bridgeStatus);
      res.json({ ok: true });
    });
    app.post('/api/bridge/answer', (req, res) => {
      try {
        res.json(answer(req.body || {}));
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
    app.post('/api/bridge/act', async (req, res) => {
      try {
        res.json(await act(req.body || {}));
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  }

  return {
    mount,
    list,
    answer,
    act,
    push,
    /** A visible UI tab reported in: the bridge can hold pings while you are at the screen. */
    seen() {
      lastSeen = Date.now();
    },
    status: () => bridgeStatus,
    notify(s, text) {
      return push({ type: 'notify', session: sessionInfo(s), text: clip(text, 2000) });
    },
  };
}
