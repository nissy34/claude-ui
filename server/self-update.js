// Self-update: the web server's side of the updater service (server/updater.js).
//   Settings > Server  (/api/update/*): check any branch and deploy it; the button press is the approval.
//   Chats              (/internal/update/*, the built-in "server" MCP tools): main only, and only
//                      after the user approved that exact update in the chat's permission prompt
//                      (recorded by ChatSession.answerPermission), whatever the chat's permission mode.
import http from 'node:http';
import { config } from './config.js';

export const UPDATE_TOOL = 'mcp__server__update_server';
const APPROVAL_MS = 15 * 60_000;

export const updaterConfigured = () => !!config.updaterSocket;

export function updater(method, p, body) {
  return new Promise((resolve, reject) => {
    if (!config.updaterSocket) return reject(Object.assign(new Error('Self-update needs the updater service (docker-compose.yml, service "updater").'), { status: 501 }));
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ socketPath: config.updaterSocket, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, timeout: 180_000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let out = {};
        try {
          out = JSON.parse(buf);
        } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(out);
        else reject(Object.assign(new Error(out.error || `updater: HTTP ${res.statusCode}`), { status: res.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('updater: timed out')));
    req.on('error', (e) => reject(Object.assign(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'The updater service is not running (docker compose up -d updater).' : e.message), { status: 503 })));
    if (data) req.write(data);
    req.end();
  });
}

/** The user's approval of update_server in this chat, used once. Throws when there is none. */
export function takeApproval(session, input) {
  const a = session?.updateApproval;
  if (!a || Date.now() - a.at > APPROVAL_MS) {
    throw Object.assign(
      new Error(
        'The user has not approved this update. update_server always needs the user to approve it in the permission prompt; if no prompt appeared, this chat is in a mode that skips prompts (switch it to ask first, or use Settings > Server).'
      ),
      { status: 403 }
    );
  }
  if (String(a.input?.to_commit || '') !== String(input.to_commit || '') || !!a.input?.restart_runner !== !!input.restart_runner) {
    throw Object.assign(new Error('The approved update differs from this request; call update_server again so the user approves what will run.'), { status: 403 });
  }
  session.updateApproval = null;
  return a;
}

export function mountUpdateRoutes(app, { store }) {
  // Errors keep their status (501 not set up, 503 updater down, 403 not approved, 409 busy).
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
  // ---- Settings > Server (behind the login) ----
  app.get('/api/update/status', wrap(async (req, res) => res.json(await updater('GET', '/status'))));
  app.get('/api/update/check', wrap(async (req, res) => res.json(await updater('GET', `/check?ref=${encodeURIComponent(String(req.query.ref || 'main'))}`))));
  app.get('/api/update/runs/:id', wrap(async (req, res) => res.json(await updater('GET', `/runs/${encodeURIComponent(req.params.id)}`))));
  app.post(
    '/api/update/run',
    wrap(async (req, res) => res.json(await updater('POST', '/deploy', { ref: String(req.body?.ref || 'main'), runner: !!req.body?.runner, source: 'settings', requestedBy: 'Settings > Server' })))
  );

  // ---- chats (internal token) ----
  app.get('/internal/update/check', wrap(async (req, res) => res.json({ ...(await updater('GET', '/check?ref=main')), running: (await updater('GET', '/status')).running })));
  app.get('/internal/update/runs/:id', wrap(async (req, res) => res.json(await updater('GET', `/runs/${encodeURIComponent(req.params.id)}`))));
  app.post(
    '/internal/update/run',
    wrap(async (req, res) => {
      const s = store.get(req.headers['x-cw-session']);
      if (!s) throw Object.assign(new Error('unknown chat'), { status: 403 });
      const input = { to_commit: req.body?.to_commit, restart_runner: !!req.body?.restart_runner };
      takeApproval(s, input);
      const run = await updater('POST', '/deploy', { ref: 'main', expect: input.to_commit, runner: input.restart_runner, source: 'chat', requestedBy: `chat "${s.meta.name}"`, ignoreChat: s.id });
      s.record({ k: 'notice', text: `Updating the server to ${input.to_commit}${input.restart_runner ? ' (and restarting the runner)' : ''}` });
      res.json(run);
    })
  );
}
