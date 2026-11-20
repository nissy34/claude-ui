// HTTP API for Projects (/api/cprojects; /api/projects already lists folders) and the internal
// route the built-in project MCP server calls.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_FROM } from './cprojects.js';

export function mountProjectRoutes(app, { engine, store, resolveDir, wrap }) {
  // ---- internal: tool calls from the project MCP server (x-cw-session names the caller) ----
  app.post(
    '/internal/cproject/tool',
    wrap(async (req, res) => {
      const s = store.get(req.headers['x-cw-session']);
      if (!s) throw new Error('Unknown session');
      res.json(await engine.tool(s, String(req.body?.name || ''), req.body?.args || {}));
    })
  );

  // ---- internal: PostToolUse hook of a thread; answers with pending notes (or nothing) ----
  app.post('/internal/cproject/hook', (req, res) => {
    req.resume(); // the tool result in the body is not needed
    const s = store.get(req.headers['x-cw-session']);
    let out = {};
    try {
      out = s ? engine.hookNotes(s) : {};
    } catch (e) {
      console.warn('project hook:', e.message);
    }
    res.json(out);
  });

  const cleanFolders = (folders) => (Array.isArray(folders) ? folders : []).map((f) => ({ path: resolveDir(typeof f === 'string' ? f : f.path) }));
  const project = (req) => engine.get(req.params.id);
  const thread = (p, req) => {
    if (!p.state.threads[req.params.tid]) throw new Error('No such thread');
    return req.params.tid;
  };

  app.get('/api/cprojects', (req, res) => res.json({ projects: engine.list() }));

  app.post(
    '/api/cprojects',
    wrap(async (req, res) => {
      const b = req.body || {};
      const p = await engine.create({ ...b, folders: cleanFolders(b.folders) });
      if (typeof b.prompt === 'string' && b.prompt.trim()) engine.userMessage(p, b.prompt);
      res.json({ project: p.detail() });
    })
  );

  app.get(
    '/api/cprojects/:id',
    wrap(async (req, res) => res.json({ project: project(req).detail({ limit: Math.min(Number(req.query.limit) || 300, 2000) }) }))
  );

  app.patch(
    '/api/cprojects/:id',
    wrap(async (req, res) => {
      const p = project(req);
      const patch = { ...(req.body || {}) };
      if (patch.folders) patch.folders = cleanFolders(patch.folders);
      engine.update(p, patch);
      res.json({ project: p.detail() });
    })
  );

  app.delete(
    '/api/cprojects/:id',
    wrap(async (req, res) => {
      await engine.remove(project(req));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/cprojects/:id/messages',
    wrap(async (req, res) => {
      const ev = engine.userMessage(project(req), req.body?.text);
      res.json({ event: ev });
    })
  );

  // The Custom view tab: add it (empty), pin one of the project's pages, or remove it.
  app.post(
    '/api/cprojects/:id/view',
    wrap(async (req, res) => {
      const p = project(req);
      const b = req.body || {};
      if (b.remove) p.append({ type: 'view.removed', from: { kind: 'user' }, trust: 'principal', body: {} });
      else if (b.session && b.path) p.pinView(b.session, b.path, b.title, { kind: 'user' });
      else p.append({ type: 'view.added', from: { kind: 'user' }, trust: 'principal', body: {} });
      res.json({ view: p.viewInfo() });
    })
  );

  app.post(
    '/api/cprojects/:id/pause',
    wrap(async (req, res) => {
      engine.pause(project(req));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/cprojects/:id/restart-coordinator',
    wrap(async (req, res) => {
      await engine.restartCoordinator(project(req));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/cprojects/:id/resume',
    wrap(async (req, res) => {
      engine.resume(project(req));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/cprojects/:id/decisions/:did',
    wrap(async (req, res) => {
      const ev = engine.answerDecision(project(req), req.params.did, req.body || {});
      res.json({ event: ev });
    })
  );

  // Start or dismiss a thread the coordinator suggested.
  app.post(
    '/api/cprojects/:id/suggestions/:sid',
    wrap(async (req, res) => {
      const p = project(req);
      const r = await engine.answerSuggestion(p, req.params.sid, String(req.body?.action || ''));
      res.json({ ...r, thread: r.thread ? p.threadSummary(p.state.threads[r.thread]) : null });
    })
  );

  // Move an existing regular chat into the project as a thread.
  app.post(
    '/api/cprojects/:id/adopt',
    wrap(async (req, res) => {
      const p = project(req);
      const s = await engine.adoptChat(p, String(req.body?.session || ''));
      res.json({ thread: p.threadSummary(p.state.threads[s.id]) });
    })
  );

  // A thread the user starts by hand (from the Overview), like the coordinator's start_thread.
  app.post(
    '/api/cprojects/:id/threads',
    wrap(async (req, res) => {
      const p = project(req);
      const s = await engine.startThread(p, { title: req.body?.title, brief: req.body?.brief, model: req.body?.model, effort: req.body?.effort, dependsOn: req.body?.dependsOn, startedBy: 'user' });
      res.json({ thread: p.threadSummary(p.state.threads[s.id]) });
    })
  );

  // A thread's Conversation: its brief, your messages, its posts and cards (the transcript is the Work log).
  app.get(
    '/api/cprojects/:id/threads/:tid/feed',
    wrap(async (req, res) => {
      const p = project(req);
      const tid = thread(p, req);
      const types = new Set(['thread.started', 'user.message', 'thread.post', 'checklist.updated', 'decision.requested', 'session.message', 'reminder.set', 'reminder.due', 'thread.resolved', 'thread.reopened', 'pr.updated', 'notice']);
      const feed = [];
      for (const e of p.events) {
        if (types.has(e.type) && (e.thread === tid || (e.type === 'session.message' && e.from?.id === tid))) feed.push(e);
        // What passed between threads shows as activity rows: notes it shared, notes handed to it, signals about it.
        else if (e.type === 'note.shared' && e.thread === tid && e.body.kind !== 'decision') feed.push(e);
        else if (e.type === 'signal' && (e.thread === tid || (e.body.threads || []).includes(tid))) feed.push(e);
        else if (e.type === 'memory.changed' && e.from?.id === tid) {
          // Consecutive memory writes collapse into one "Updated project memory" row.
          const last = feed[feed.length - 1];
          if (last?.type === 'memory.changed') last.body = { ...last.body, names: [...new Set([...(last.body.names || [last.body.name]), e.body.name])] };
          else feed.push({ ...e, body: { ...e.body, names: [e.body.name] } });
        }
        else if (e.type === 'notes.delivered' && e.body.session === tid && !e.body.dropped) {
          const notes = e.body.ids.map((id) => p.state.notes?.[id]).filter(Boolean).map((n) => ({ id: n.id, kind: n.kind, text: n.text, files: n.files, from: n.by ? p.state.threads[n.by]?.title || n.by : 'the user' }));
          if (notes.length) feed.push({ ...e, body: { ...e.body, notes } });
        }
      }
      res.json({ feed });
    })
  );

  // Plain-text search over memory, notes, reports and threads' conversations (no model).
  app.get(
    '/api/cprojects/:id/search',
    wrap(async (req, res) => {
      const p = project(req);
      res.json({ hits: p.search(String(req.query.q || ''), { limit: Math.min(Number(req.query.limit) || 12, 30) }) });
    })
  );

  // Retract a note (it stops being delivered and found).
  app.delete(
    '/api/cprojects/:id/notes/:nid',
    wrap(async (req, res) => {
      const p = project(req);
      if (!p.state.notes?.[req.params.nid]) throw new Error('No such note');
      p.append({ type: 'note.retracted', from: { kind: 'user' }, trust: 'principal', body: { id: req.params.nid } });
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/cprojects/:id/threads/:tid/:action',
    wrap(async (req, res) => {
      const p = project(req);
      const tid = thread(p, req);
      switch (req.params.action) {
        case 'resolve':
          engine.resolveThread(p, tid, { resolved: true });
          break;
        case 'reopen':
          engine.resolveThread(p, tid, { resolved: false });
          break;
        case 'stop':
          await engine.stopThread(p, tid);
          break;
        case 'remind': {
          const at = req.body?.at ? Date.parse(req.body.at) : req.body?.minutes ? Date.now() + Number(req.body.minutes) * 60_000 : 0;
          engine.remind(p, tid, at || 0, req.body?.note);
          break;
        }
        case 'nudge': {
          const s = store.get(tid);
          if (s) await s.resume({ from: PROJECT_FROM });
          break;
        }
        case 'message': {
          const ev = engine.steerThread(p, tid, req.body?.text);
          return res.json({ event: ev });
        }
        case 'side': {
          const s = await engine.sideThread(p, tid, req.body?.question);
          return res.json({ thread: p.threadSummary(p.state.threads[s.id]) });
        }
        case 'fork': {
          const t = p.state.threads[tid];
          const s = await engine.startThread(p, { title: String(req.body?.title || `${t.title} (fork)`), brief: req.body?.brief || '', forkFrom: tid, startedBy: 'user' });
          return res.json({ thread: p.threadSummary(p.state.threads[s.id]) });
        }
        default:
          throw new Error('Unknown action');
      }
      res.json({ thread: p.threadSummary(p.state.threads[tid]) });
    })
  );

  // ---- memory ----
  app.put(
    '/api/cprojects/:id/memory-pinned',
    wrap(async (req, res) => res.json(project(req).memory.setPinned(req.body?.text, { by: { kind: 'user' } })))
  );
  app.get(
    '/api/cprojects/:id/memory',
    wrap(async (req, res) => res.json(project(req).memory.list()))
  );
  app.get(
    '/api/cprojects/:id/memory/:name',
    wrap(async (req, res) => res.json(project(req).memory.read(req.params.name)))
  );
  app.put(
    '/api/cprojects/:id/memory/:name',
    wrap(async (req, res) => {
      const r = project(req).memory.write({ name: req.params.name, description: req.body?.description, content: req.body?.content, type: req.body?.type, baseVersion: req.body?.version, by: { kind: 'user' } });
      if (r.conflict) return res.status(409).json({ error: r.note, current: r.current });
      res.json(r);
    })
  );
  app.delete(
    '/api/cprojects/:id/memory/:name',
    wrap(async (req, res) => res.json(project(req).memory.remove(req.params.name, { by: { kind: 'user' }, force: true })))
  );

  // ---- library: shared files (uploads and thread outputs) ----
  const libPath = (p, rel) => {
    const root = fs.realpathSync(p.libraryDir);
    const abs = path.resolve(root, String(rel || ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Outside the library');
    return abs;
  };
  app.get(
    '/api/cprojects/:id/library',
    wrap(async (req, res) => {
      const p = project(req);
      const root = fs.realpathSync(p.libraryDir);
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 4 || out.length > 1000) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs, depth + 1);
          else if (e.isFile()) {
            const st = fs.statSync(abs);
            out.push({ path: path.relative(root, abs), size: st.size, modified: st.mtimeMs });
          }
        }
      };
      walk(root, 0);
      out.sort((a, b) => b.modified - a.modified);
      res.json({ root, files: out });
    })
  );
  app.get(
    '/api/cprojects/:id/library/file',
    wrap(async (req, res) => {
      const abs = libPath(project(req), req.query.path);
      if (!fs.statSync(abs).isFile()) throw new Error('Not a file');
      res.download(abs, path.basename(abs));
    })
  );
  app.post(
    '/api/cprojects/:id/library',
    wrap(async (req, res) => {
      const p = project(req);
      const name = path.basename(String(req.body?.name || ''));
      if (!name || name.startsWith('.')) throw new Error('Bad file name');
      const data = Buffer.from(String(req.body?.data || ''), 'base64');
      const dest = libPath(p, path.join('uploads', name));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      p.append({ type: 'library.added', from: { kind: 'user' }, trust: 'principal', body: { path: path.relative(p.libraryDir, dest), size: data.length } });
      res.json({ ok: true, path: path.relative(p.libraryDir, dest) });
    })
  );
  app.delete(
    '/api/cprojects/:id/library/file',
    wrap(async (req, res) => {
      const abs = libPath(project(req), req.query.path);
      fs.rmSync(abs, { force: true });
      res.json({ ok: true });
    })
  );
}
