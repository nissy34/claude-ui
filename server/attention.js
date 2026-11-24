// Attention feed: everything that is waiting on the user, across chats and projects, for a
// companion service such as the Teams bridge (teams-bridge/). It reads the same state the web UI
// shows and answers through the same code paths, so an answer from Teams and an answer in the UI
// are the same thing: whichever comes first wins and the other side sees it as answered.
//
// HTTP API under /api/bridge/*, bearer token (CW_BRIDGE_TOKEN or ~/.claude-web/bridge-token),
// never reachable from a browser page:
//   GET  /api/bridge/attention          open items now (permission prompts, questions, sign-ins, decisions)
//   GET  /api/bridge/events?after=N     long-poll for new events (asks, resolutions, coordinator posts,
//                                       finished turns and live status of chats with a Teams thread,
//                                       threads to open, archived chats, notify_user)
//   POST /api/bridge/answer             { id, choice?, text?, behavior?, always? }
//   POST /api/bridge/act                { action, ... } start work: project_send, new_chat, send, stop, status
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { loginAllowed, loginFailed } from './auth.js';
import { controlSession } from './session-control.js';
import { loopbackUrl, probe, deliverCallback, submitForm, newSeal, sealLink, openSealed, findCallback, findSealed } from './loopback-signin.js';

// The encrypt-on-phone page for localhost password forms (docs/seal.html, served by GitHub Pages).
const SEAL_URL = process.env.CW_SEAL_URL || 'https://nissy34.github.io/claude-ui/seal.html';

const TOKEN_FILE = path.join(config.dataDir, 'bridge-token');
const RING = 500;
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/**
 * The text the chat wrote in the turn that just ended: back to your last message or the turn before.
 * followUp: this turn followed an earlier one with no message from you in between (a background
 * agent or task finishing woke the chat).
 */
function turnReply(s) {
  const out = [];
  const ev = s.events || [];
  let i = ev.length - 1;
  if (ev[i]?.k === 'result') i--;
  let followUp = false;
  for (; i >= 0; i--) {
    const e = ev[i];
    if (e.k === 'user') break;
    if (e.k === 'result') {
      followUp = true;
      break;
    }
    if (e.k === 'block' && e.block?.type === 'text' && !e.parent) out.unshift(e.block.text);
  }
  return { text: out.join('\n\n'), followUp };
}
/** One short line from Markdown text: its first sentence or line, without formatting. */
export function oneLine(text, n = 160) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, '').replace(/[*_`]/g, '').trim())
    .find((l) => l && !/^\|/.test(l));
  if (!t) return '';
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t);
  return clip(m && m[1].length >= 20 ? m[1] : t, n);
}

/**
 * Where a chat is, in one line, for the status card at the top of its Teams thread:
 * working (and on what), waiting on you, or done (with the first line of its last reply).
 */
export function chatStatus(s) {
  const running = (s.tasksSummary?.() || []).filter((t) => t.status === 'running').length;
  if (s.pending?.size) {
    const p = [...s.pending.values()][0];
    return { state: 'waiting', line: p.tool === 'AskUserQuestion' ? clip(p.input?.questions?.[0]?.question || 'A question for you', 160) : `Wants to use ${p.tool}${describeTool(p.tool, p.input) ? `: ${clip(describeTool(p.tool, p.input), 120)}` : ''}`, running };
  }
  if (s.elicits?.size) return { state: 'waiting', line: `Needs a sign-in to ${[...s.elicits.values()][0].server || 'a service'}`, running };
  const busy = s.turns > 0;
  const ev = s.events || [];
  if (busy) {
    // The newest top-level step: a tool it is running, or the words it is writing.
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e.k === 'user') break;
      if (e.k !== 'block' || e.parent) continue;
      if (e.block?.type === 'tool_use') {
        const d = describeTool(e.block.name, e.block.input);
        return { state: 'working', line: `${e.block.name}${d ? `: ${clip(d.split('\n')[0], 120)}` : ''}`, running };
      }
      if (e.block?.type === 'text' && e.block.text?.trim()) return { state: 'working', line: oneLine(e.block.text.split('\n\n').at(-1)), running };
    }
    return { state: 'working', line: 'Thinking', running };
  }
  const last = s.lastReply?.() || '';
  const failed = ev.at(-1)?.k === 'result' && ev.at(-1).isError;
  if (running) return { state: 'working', line: `${running === 1 ? 'A background task is' : `${running} background tasks are`} running`, running, result: oneLine(last) };
  return { state: failed ? 'error' : ev.some((e) => e.k === 'user') ? 'done' : 'idle', line: failed ? 'Stopped with an error' : oneLine(last) || 'Nothing yet', running: 0 };
}

/** Split a leading Markdown blockquote ("> …" lines, as a quote reply sends) from the rest: [quote lines or '', rest]. */
const splitQuote = (text) => {
  const m = /^((?:>[^\n]*(?:\n|$))+)\n*/.exec(text || '');
  return m ? [m[1].trimEnd(), text.slice(m[0].length)] : ['', text];
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
  let signinReply = null; // the pasted http://localhost/?code=… address, until the bridge takes it
  const signinWaiters = new Set();
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
    const item = { id: `elicit:${s.id}:${e.reqId}`, kind: 'signin', session: sessionInfo(s), ts: e.ts, server: e.server, message: clip(e.message, 500), url: e.mode === 'url' ? e.url : null, form: e.mode !== 'url' };
    if (e.mode === 'url' && loopbackUrl(e.url)) {
      // A link that only opens on this machine: what we found behind it (see loopback-signin.js).
      const f = localFlows.get(item.id);
      if (!f) item.local = 'checking';
      else if (f.kind === 'sso') Object.assign(item, { local: 'sso', url: f.signinUrl });
      else if (f.kind === 'form') Object.assign(item, { local: 'form', url: null, fields: f.form.fields.map((x) => x.label), sealUrl: f.seal ? sealLink(SEAL_URL, f.seal, { server: e.server, fields: f.form.fields }) : null });
      else Object.assign(item, { local: 'unknown', why: f.why || null });
    }
    return item;
  }

  // ---------- sign-ins whose link only opens on this machine ----------
  const localFlows = new Map(); // elicit item id -> { kind, port, jar, signinUrl | form, seal, s, reqId, url }
  async function prepareLocal(s, e) {
    const id = `elicit:${s.id}:${e.reqId}`;
    const r = await Promise.race([probe(e.url), new Promise((ok) => setTimeout(() => ok({ kind: 'unknown', why: 'the page took too long' }), 8000))]);
    const f = { ...r, s, reqId: e.reqId, url: e.url, server: e.server };
    if (f.kind === 'form') f.seal = await newSeal();
    localFlows.set(id, f);
    return f;
  }
  const sealUrlOf = (f) => sealLink(SEAL_URL, f.seal, { server: f.server, fields: f.form.fields });
  function finishedLocal(f, id) {
    localFlows.delete(id);
    f.s.lastAnswerBy = 'bridge';
    try {
      if (f.s.elicits.has(f.reqId)) f.s.answerElicit({ reqId: f.reqId, action: 'accept' });
    } finally {
      f.s.lastAnswerBy = null;
    }
  }

  /**
   * Finish a localhost sign-in from a Teams reply: the callback address the phone ended on (sso), or
   * the code from the encrypt page (form). The decrypted values only go to the localhost page.
   */
  async function finishLocal({ id, callback, sealed }) {
    if (sealed) {
      const sd = findSealed(sealed);
      if (!sd) throw new Error("That doesn't look like a code from the encrypt page.");
      const hit = [...localFlows].find(([, f]) => f.kind === 'form' && f.seal?.sid === sd.sid) || [...localFlows].find(([k, f]) => f.kind === 'form' && f.usedSids?.has(sd.sid) && (!id || k === id));
      if (!hit) throw new Error('That code is for a sign-in that is gone or already finished.');
      const [key, f] = hit;
      if (!f.seal || f.seal.sid !== sd.sid) {
        f.seal = await newSeal();
        return { ok: false, id: key, note: 'That code was already used. Open the new link and enter it again.', sealUrl: sealUrlOf(f) };
      }
      if (Date.now() > f.seal.exp) {
        f.seal = await newSeal();
        return { ok: false, id: key, note: 'That link expired. Open the new one and enter it again.', sealUrl: sealUrlOf(f) };
      }
      let values = await openSealed(f.seal, sd);
      // One use: the key is gone whatever happens next.
      (f.usedSids ||= new Set()).add(f.seal.sid);
      f.seal = null;
      const names = new Set(f.form.fields.map((x) => x.name));
      if (Object.keys(values).some((k) => !names.has(k)) || Object.values(values).some((v) => typeof v !== 'string' || v.length > 2000)) {
        f.seal = await newSeal();
        return { ok: false, id: key, note: "That code doesn't match this sign-in's fields. Open the new link and enter it again.", sealUrl: sealUrlOf(f) };
      }
      let r;
      try {
        r = await submitForm(f, values);
      } finally {
        values = null;
      }
      if (r.ok) {
        finishedLocal(f, key);
        return { ok: true, id: key, answered: 'signed in' };
      }
      // Wrong password, or the page wants a fresh form (new hidden tokens): read it again, new key.
      const again = await probe(f.url).catch(() => null);
      if (again?.kind === 'form') Object.assign(f, { form: again.form, jar: again.jar, page: again.page });
      f.seal = await newSeal();
      return { ok: false, id: key, note: `The sign-in page didn't accept it${r.note ? ` (${clip(r.note, 160)})` : ''}. Check the username and password and try again with the new link.`, sealUrl: sealUrlOf(f) };
    }
    const url = findCallback(callback);
    if (!url) throw new Error('That is not a localhost address.');
    const port = url.port || '80';
    const cands = [...localFlows].filter(([k, f]) => f.kind === 'sso' && (!id || k === id));
    const hit = cands.find(([, f]) => f.port === port);
    if (!hit) throw new Error(cands.length ? `No sign-in is waiting on port ${port}; this one waits on port ${cands.map(([, f]) => f.port).join(', ')}.` : 'No sign-in is waiting for that address. It may have finished or timed out.');
    const [key, f] = hit;
    const r = await deliverCallback(f, url);
    if (!r.ok) return { ok: false, id: key, note: `The sign-in didn't take it (HTTP ${r.status}${r.body ? `: ${clip(r.body, 160)}` : ''}). Start the sign-in again if it keeps failing.` };
    finishedLocal(f, key);
    return { ok: true, id: key, answered: 'signed in' };
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
  // Live status for chats with a Teams thread: what it is doing now, for the card at the top of the
  // thread. At most one update per chat every STATUS_MS (the last one always goes out).
  const STATUS_MS = Number(process.env.CW_BRIDGE_STATUS_MS) || 15_000;
  const statusTimers = new Map(); // session id -> { at, timer }
  function liveStatus(s) {
    const t = statusTimers.get(s.id) || { at: 0, timer: null };
    statusTimers.set(s.id, t);
    if (t.timer) return;
    const fire = () => {
      t.timer = null;
      t.at = Date.now();
      if (s.turns > 0) push({ type: 'status', session: sessionInfo(s), status: chatStatus(s) });
    };
    const wait = Math.max(0, t.at + STATUS_MS - Date.now());
    if (!wait) fire();
    else t.timer = setTimeout(fire, wait);
  }
  store.recordHooks.add((s, ev) => {
    if (ev.k === 'block' && !ev.parent && (ev.block?.type === 'tool_use' || ev.block?.type === 'text') && s.meta.teamsThread && !s.meta.cproject && !s.meta.archived) liveStatus(s);
    switch (ev.k) {
      case 'perm':
        permTools.set(ev.reqId, ev.tool);
        return push({ type: 'ask', item: permItem(s, ev) });
      case 'elicit':
        // A localhost link: look behind it first, so the card can carry something a phone can open.
        if (ev.mode === 'url' && loopbackUrl(ev.url))
          return void prepareLocal(s, ev)
            .catch(() => null)
            .then(() => s.elicits.has(ev.reqId) && push({ type: 'ask', item: elicitItem(s, ev) }));
        return push({ type: 'ask', item: elicitItem(s, ev) });
      case 'perm_done': {
        const tool = permTools.get(ev.reqId);
        permTools.delete(ev.reqId);
        const answer = ev.behavior === 'allow' ? (tool === 'AskUserQuestion' ? 'answered' : ev.always ? 'always allowed' : 'allowed') : ev.behavior === 'deny' ? (tool === 'AskUserQuestion' ? 'declined' : 'denied') : ev.behavior;
        return push({ type: 'resolved', id: `perm:${s.id}:${ev.reqId}`, answer, by: s.lastAnswerBy || 'ui' });
      }
      case 'elicit_done':
        localFlows.delete(`elicit:${s.id}:${ev.reqId}`);
        return push({ type: 'resolved', id: `elicit:${s.id}:${ev.reqId}`, answer: ev.action, by: s.lastAnswerBy || 'ui' });
      case 'result':
        // Turn updates only for chats the bridge started, wrote to, or gave a Teams thread; projects
        // report through their coordinator.
        if ((s.meta.bridge || s.meta.teamsThread) && !s.meta.cproject) {
          // Only this turn's words: a turn started by a background task's notice has no user message
          // before it, so the whole reply since your message would repeat the earlier report.
          const { text, followUp } = turnReply(s);
          const running = (s.tasksSummary?.() || []).filter((t) => t.status === 'running').length;
          // followUp with no text: nothing new to say, but the bridge can still mark the last report finished.
          push({ type: 'turn', session: sessionInfo(s), via: s.meta.bridgeVia || null, isError: !!ev.isError, running, followUp, text: clip(ev.isError ? ev.text || 'The turn failed.' : text.trim(), 3000), status: { ...chatStatus(s), ...(ev.isError ? { state: 'error', line: oneLine(ev.text || 'Stopped with an error') } : {}) } });
        }
        // The Assistant answers in Teams when the message came from Teams.
        if (s.meta.assistant && s.meta.teamsReply) {
          s.meta.teamsReply = false;
          const text = ev.isError ? `Sorry, that failed: ${ev.text || 'unknown error'}` : s.lastReply();
          if (text.trim()) push({ type: 'assistant', session: sessionInfo(s), text: clip(text, 4000) });
        }
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
        push({ type: 'post', project: { id: p.id, name: p.settings.name }, via: projectVia.get(p.id) || null, text: clip(ev.body.text, 3000) });
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
        const lf = localFlows.get(id);
        if (act === 'accept' && lf?.kind === 'sso') throw new Error('Reply with the address the sign-in page ended on (it starts with http://localhost).');
        if (act === 'accept' && lf?.kind === 'form') throw new Error('Reply with the code from the encrypt page.');
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

  // Who asked last: 'assistant' when the Assistant passed your words on, so the answer can come back
  // where you asked (the Assistant's thread in Teams) instead of in a thread of its own.
  const projectVia = new Map();

  async function act(a = {}) {
    switch (a.action) {
      case 'project_send': {
        const p = project(a.project);
        projectVia.set(p.id, a.via || null);
        // Asked through the Assistant: the project's thread in Teams opens (or is linked) for the answer.
        if (a.via === 'assistant') push({ type: 'thread', target: { type: 'project', id: p.id, name: p.settings.name }, via: 'assistant', sent: true });
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
        s.meta.bridgeVia = a.via || null;
        // Started by the Assistant: the chat gets its own Teams thread before it can ask anything.
        if (a.via === 'assistant') {
          s.meta.teamsThread = true;
          push({ type: 'thread', target: { type: 'chat', id: s.id, name: s.meta.name }, status: { state: 'working', line: 'Starting', running: 0 }, via: 'assistant', sent: true });
        }
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
            projectVia.set(p.id, a.via || null);
            engine.userMessage(p, String(a.text || ''), { from: 'user' });
            return { ok: true, target: { type: 'project', id: p.id, name: p.settings.name } };
          }
          engine.steerThread(p, s.id, String(a.text || ''), { from: 'user' });
          return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name } };
        }
        s.meta.bridge = true;
        s.meta.bridgeVia = a.via || null;
        // What it was doing when your message came: if it is busy, your message waits for this step.
        const before = chatStatus(s);
        const busy = s.isBusy?.() || false;
        if (a.via === 'assistant') {
          s.meta.teamsThread = true;
          push({ type: 'thread', target: { type: 'chat', id: s.id, name: s.meta.name }, status: before, via: 'assistant', sent: true });
        }
        const r = s.deliver({ text: String(a.text || '') });
        return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name }, queued: !!r?.queued, busy, status: busy ? before : { state: 'working', line: 'Reading your message', running: before.running } };
      }
      case 'link': {
        // The bridge opened a Teams thread for this chat: from now on its turns are reported there.
        const s = chatOf(a.chat);
        if (!s.meta.cproject && !s.meta.teamsThread) {
          s.meta.teamsThread = true;
          store.save();
        }
        return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name }, status: chatStatus(s) };
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
      case 'assistant': {
        const text = String(a.text || '').trim();
        if (!text) throw new Error('Message is empty');
        const s = assistant();
        s.meta.teamsReply = true;
        // A Teams quote reply arrives as a "> quoted" blockquote on top. Only your own words below it can
        // back answer_request's quote, and the blockquote stays first so the web UI shows it as a quote.
        const [quoted, own] = splitQuote(text);
        s.meta.lastUserText = own;
        const body = a.context ? `${String(a.context).slice(0, 2000)}\n\n${own}` : own;
        const r = s.deliver({ text: quoted ? `${quoted}\n\n${body}` : body });
        return { ok: true, target: { type: 'chat', id: s.id, name: s.meta.name }, queued: !!r?.queued };
      }
      case 'folders':
        return listProjects();
      default:
        throw new Error(`Unknown action ${a.action}`);
    }
  }

  // ---------- the Assistant (chief of staff) ----------
  /** The one Assistant chat: a Haiku chat with only the assistant tools. Made on first use. */
  function assistant() {
    let s = [...store.sessions.values()].find((x) => x.meta.assistant && !x.meta.archived);
    if (!s) {
      if (!config.assistant) throw new Error('The Assistant is turned off (CW_ASSISTANT=0).');
      s = store.create({ cwd: config.scratchDir, kind: 'chat', name: 'Assistant', model: config.assistantModel });
      s.meta.assistant = true;
      s.meta.customName = true;
      s.meta.pinned = true;
      s.meta.modeSet = true;
      store.save();
      store.changed?.();
    } else if (!s.meta.modeSet) {
      // Made before chats started in Auto mode: switch it once.
      s.meta.modeSet = true;
      if (!s.meta.permissionMode && config.defaultMode !== 'default') s.meta.permissionMode = config.defaultMode;
      store.save();
    }
    return s;
  }

  const shortItem = (i) => ({
    id: i.id,
    kind: i.kind,
    where: i.session ? (i.session.project ? `${i.session.project.name}${i.session.thread && i.session.thread !== 'coordinator' ? ` / ${i.session.thread}` : ''}` : `chat "${i.session.name}"`) : `${i.project?.name}${i.thread && i.thread !== 'coordinator' ? ` / ${i.thread}` : ''}`,
    ...(i.kind === 'permission' || i.kind === 'plan' ? { tool: i.tool, detail: clip(i.detail, 300) } : {}),
    ...(i.kind === 'question' ? { questions: i.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label) })) } : {}),
    ...(i.kind === 'decision' ? { question: i.question, options: i.options.map((o, n) => `${n + 1}. ${o.label}${n === i.recommended ? ' (recommended)' : ''}`), irreversible: i.irreversible } : {}),
    ...(i.kind === 'signin' ? { server: i.server, url: i.url, form: i.form, ...(i.local ? { local: i.local } : {}) } : {}),
    waiting: Math.round((Date.now() - (i.ts || Date.now())) / 60000) + ' min',
  });

  /** A tool call from the Assistant's built-in MCP server. */
  async function assistantTool(s, name, a = {}) {
    if (!s?.meta.assistant) throw new Error('Only the Assistant chat can use these tools.');
    switch (name) {
      case 'overview': {
        const st = await act({ action: 'status' });
        return { waitingOnUser: list().map(shortItem), projects: st.projects, workingChats: st.busyChats };
      }
      case 'answer_request': {
        // Guard: the quoted words must be in the user's latest message, so a misread can't approve anything.
        const quote = String(a.quote || '').trim().toLowerCase();
        const last = String(s.meta.lastUserText || s.lastUserText?.() || '').toLowerCase();
        if (!quote || !last.includes(quote)) throw new Error("quote must be words from the user's latest message. If they didn't clearly say what to answer, ask them.");
        if (!config.assistantMayApprove && String(a.id).startsWith('perm:') && a.behavior !== 'deny') {
          const item = list().find((i) => i.id === a.id);
          if (item && item.kind !== 'question') throw new Error('Approving tools from the Assistant is turned off. Tell the user to answer it in the web UI or with #code in Teams.');
        }
        const body = { id: a.id, text: a.text };
        if (a.behavior) body.behavior = a.behavior;
        if (typeof a.choice === 'number') body.choice = a.choice - 1;
        return answer(body);
      }
      case 'project_status':
        return desktopRun('project_status', { project_id: project(a.project).id, chat_messages: 8 });
      case 'message_project':
        return act({ action: 'project_send', project: a.project, text: a.text, via: 'assistant' });
      case 'list_folders': {
        const f = await listProjects();
        return { folders: (f.projects || []).map((x) => x.name) };
      }
      case 'start_chat':
        return act({ action: 'new_chat', folder: a.folder, text: a.task, via: 'assistant' });
      case 'find_chats':
        return desktopRun('list_sessions', { query: a.query || '', limit: 15 });
      case 'read_chat':
        return desktopRun('get_session', { id: chatOf(a.chat).id, max_chars: 6000 });
      case 'message_chat':
        return act({ action: 'send', chat: a.chat, text: a.text, via: 'assistant' });
      case 'stop_chat':
        return act({ action: 'stop', chat: a.chat });
      case 'open_thread': {
        // The chat's (or project's) own thread in the Teams channel: made if it doesn't exist yet,
        // and the bridge adds its link under your reply.
        if (a.project) {
          const p = project(a.project);
          push({ type: 'thread', target: { type: 'project', id: p.id, name: p.settings.name }, via: 'assistant' });
          return { ok: true, note: `The thread for project ${p.settings.name} is linked under your reply in Teams. Don't paste a link yourself.` };
        }
        const c = chatOf(a.chat);
        if (c.meta.cproject) {
          const p = engine.projectOf(c);
          push({ type: 'thread', target: { type: 'project', id: p.id, name: p.settings.name }, via: 'assistant' });
          return { ok: true, note: `That chat belongs to project ${p.settings.name}; its project thread is linked under your reply.` };
        }
        c.meta.teamsThread = true;
        store.save();
        push({ type: 'thread', target: { type: 'chat', id: c.id, name: c.meta.name }, status: chatStatus(c), via: 'assistant' });
        return { ok: true, status: chatStatus(c), note: "The chat's thread is linked under your reply in Teams. Don't paste a link yourself." };
      }
      default:
        throw new Error(`Unknown tool ${name}`);
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
      bridgeStatus = { state: clip(b.state, 20), message: clip(b.message, 500), code: b.code ? clip(b.code, 20) : null, url: b.url ? clip(b.url, 2000) : null, at: Date.now() };
      onStatus?.(bridgeStatus);
      res.json({ ok: true });
    });
    // Browser sign-in for the bridge: the address you paste in Settings > Teams waits here for the bridge.
    app.get('/api/bridge/signin-reply', (req, res) => {
      const take = () => {
        const url = signinReply;
        signinReply = null;
        res.json({ url });
      };
      if (signinReply) return take();
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 50) * 1000;
      if (!wait) return res.json({ url: null });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        signinWaiters.delete(finish);
        clearTimeout(timer);
        take();
      };
      const timer = setTimeout(finish, wait);
      signinWaiters.add(finish);
      req.on('close', () => {
        done = true;
        signinWaiters.delete(finish);
        clearTimeout(timer);
      });
    });
    app.post('/api/bridge/answer', async (req, res) => {
      try {
        const b = req.body || {};
        res.json(b.callback || b.sealed ? await finishLocal(b) : answer(b));
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
    /** From Settings > Teams in the web UI (cookie-authenticated). */
    signinReply(url) {
      signinReply = String(url || '').trim().slice(0, 4000);
      for (const w of [...signinWaiters]) w();
    },
    assistant,
    assistantTool,
    /** A chat was archived or deleted: its Teams thread goes away. */
    archived(s) {
      if (s?.meta?.kind !== 'chat') return;
      return push({ type: 'archived', session: { id: s.id, name: s.meta.name } });
    },
    notify(s, text) {
      return push({ type: 'notify', session: sessionInfo(s), text: clip(text, 2000) });
    },
  };
}
