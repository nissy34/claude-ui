#!/usr/bin/env node
// Built-in stdio MCP server "server": lets a chat look for a Claude UI update and, with the user's
// approval, install it (main only). Given to chats only when the updater service is set up.
import { call, serve } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'check_for_update',
    description:
      'Check whether this Claude UI server (the web app you run in) is behind its main branch: the running commit, main\'s latest commit, and the commits in between. ' +
      'Read-only. Use it before suggesting or running update_server, and to answer "is the server up to date?".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_server',
    description:
      'Update this Claude UI server to a commit of its main branch: pull, rebuild and restart the web server. Chats keep running through it, this one included, and the tool returns when the new server is up (a few minutes). ' +
      'Always asks the user to approve. Call check_for_update first and pass its target commit as to_commit, so the user approves exactly what will run. Only main can be deployed from a chat; other branches go through Settings > Server. ' +
      'restart_runner also restarts the container that holds every chat (needed for a new Claude Code version): it waits until no chat is working, and chats cut off resume by themselves. Leave it off unless the user asks.',
    inputSchema: {
      type: 'object',
      properties: {
        to_commit: { type: 'string', description: 'The commit of main to update to, from check_for_update (its "target"), e.g. "a1b2c3d".' },
        restart_runner: { type: 'boolean', description: 'Also restart the runner container (new Claude Code version). Default false.' },
        reason: { type: 'string', description: 'One line for the user on why, e.g. "picks up the Teams sign-in fix (3 commits)".' },
      },
      required: ['to_commit'],
    },
  },
];

const fmt = (c) =>
  [
    c.upToDate ? `Up to date: the server runs ${c.head} (${c.branch}), the latest on main.` : `The server runs ${c.head} (${c.branch}); main is at ${c.target}, ${c.behind} commit${c.behind === 1 ? '' : 's'} ahead:`,
    ...(c.commits || []).map((x) => `- ${x.sha} ${x.subject}`),
    c.branch !== 'main' ? `Note: the checkout is on "${c.branch}", not main; updating from a chat switches it to main.` : '',
    c.dirty ? 'Note: the checkout has uncommitted changes, so an update would stop before building.' : '',
    c.running ? `An update is running now (${c.running.id}).` : '',
  ]
    .filter(Boolean)
    .join('\n');

async function waitForRun(id) {
  // The server restarts during the run; call() retries while it is away.
  const until = Date.now() + 45 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let r;
    try {
      r = await call('GET', `/internal/update/runs/${encodeURIComponent(id)}`);
    } catch (e) {
      if (Date.now() > until) throw e;
      continue;
    }
    if (r.status !== 'running') return r;
    if (Date.now() > until) return r;
  }
}

serve('server', TOOLS, async (name, a = {}) => {
  if (name === 'check_for_update') return { content: [{ type: 'text', text: fmt(await call('GET', '/internal/update/check')) }] };
  if (name !== 'update_server') throw new Error(`Unknown tool ${name}`);
  if (!a.to_commit) throw new Error('to_commit is required: call check_for_update and pass its target commit.');
  const run = await call('POST', '/internal/update/run', { to_commit: String(a.to_commit), restart_runner: !!a.restart_runner });
  const r = await waitForRun(run.id);
  const words = { ok: `Updated: the server now runs ${r.to} (was ${r.from}).`, 'rolled-back': `The new server failed its health check, so the previous one (${r.from}) was put back.`, failed: 'The update failed; the running server was not changed.', 'waiting-timed-out': 'Chats were still working when the wait ran out; nothing was restarted (the server keeps queuing new messages until someone undrains it).', running: 'Still running after 45 minutes; check Settings > Server.' };
  return { content: [{ type: 'text', text: `${words[r.status] || r.status}\n\nEnd of the log:\n${(r.output || '').split('\n').slice(-25).join('\n')}` }] };
});
