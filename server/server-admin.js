// Server lifecycle: which commit is running, the session runner's state, and draining (stop
// starting new turns and wait until nothing is working) before a restart that would stop chats,
// such as a runner or Claude Code upgrade. Used by server/ctl.js, scripts/deploy.sh and
// Settings > Server.
import { config } from './config.js';
import { runner } from './proc.js';

export const commit = (process.env.CW_COMMIT || '').trim() || null;

/** What would be cut off by stopping every process now. */
export function busySummary(store) {
  const chats = [];
  const terminals = [];
  for (const s of store.sessions.values()) {
    if (s.meta.kind === 'chat') {
      const tasks = s.liveTaskCount?.() || 0;
      // Waiting on a permission prompt or a form is not work: it is asked again after a resume.
      const working = s.turns > 0 && !s.pending.size && !s.elicits.size;
      if (working || tasks) chats.push({ id: s.id, name: s.meta.name, state: s.state, backgroundTasks: tasks });
    } else if (s.running) terminals.push({ id: s.id, name: s.meta.name, kind: s.meta.kind });
  }
  return { idle: chats.length === 0, chats, terminals };
}

export function serverStatus(store) {
  return {
    commit,
    pid: process.pid,
    startedAt: STARTED,
    runner: { configured: !!config.runnerSocket, up: runner.up, runnerId: runner.runnerId },
    draining: store.draining || null,
    busy: busySummary(store),
  };
}
const STARTED = Date.now();

/** Start or stop draining. While draining, new messages wait in each chat's queue (kept across restarts). */
export function setDraining(store, on, reason = '') {
  if (on) store.draining ||= { since: Date.now(), reason: String(reason || '').slice(0, 200) };
  else {
    store.draining = null;
    // Deliver what queued up meanwhile.
    for (const s of store.sessions.values()) if (s.meta.kind === 'chat' && s.inbox?.length) s.flushInbox();
  }
  store.changed();
  return serverStatus(store);
}

/** Unauthenticated, for health checks after a deploy: says only that it is up and which commit. */
export function mountHealth(app) {
  app.get('/api/health', (req, res) => res.json({ ok: true, commit }));
}

/** Behind the login check (/api) or the internal token (/internal). */
export function mountServerRoutes(app, { store }) {
  for (const base of ['/internal/server', '/api/server']) {
    app.get(`${base}/status`, (req, res) => res.json(serverStatus(store)));
    app.post(`${base}/drain`, (req, res) => res.json(setDraining(store, req.body?.on !== false, req.body?.reason)));
  }
}
