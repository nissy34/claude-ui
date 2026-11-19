// HTTP API for Projects (/api/cprojects; /api/projects already lists folders) and the internal
// route the built-in project MCP server calls.
import fs from 'node:fs';
import path from 'node:path';

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
      const s = await engine.startThread(p, { title: req.body?.title, brief: req.body?.brief, model: req.body?.model, effort: req.body?.effort, startedBy: 'user' });
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
      const feed = p.events.filter((e) => types.has(e.type) && (e.thread === tid || (e.type === 'session.message' && e.from?.id === tid)));
      res.json({ feed });
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
          if (s) await s.resume();
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
      const r = project(req).memory.write({ name: req.params.name, description: req.body?.description, content: req.body?.content, baseVersion: req.body?.version, by: { kind: 'user' } });
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
