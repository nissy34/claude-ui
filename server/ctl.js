#!/usr/bin/env node
// Talk to the running server from a shell on the same machine (or `docker compose exec claude-ui`):
//   node server/ctl.js status                 commit, runner, what is working
//   node server/ctl.js drain [--wait] [--timeout <minutes>] [--reason <text>] [--ignore <chat id>]
//                                             stop starting new turns; --wait blocks until nothing works
//   node server/ctl.js undrain                deliver what queued up and carry on
// Exit code 0 on success; 2 when --wait timed out (the server keeps draining).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name, d) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : d;
};
const host = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host;
const base = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/internal/server`;
const token = fs.readFileSync(path.join(config.dataDir, 'internal-token'), 'utf8').trim();

async function api(p, body) {
  const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-cw-token': token }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

function describe(st) {
  const lines = [`commit ${st.commit || 'unknown'} · runner ${st.runner.configured ? (st.runner.up ? 'connected' : 'NOT connected') : 'off'}${st.draining ? ` · draining since ${new Date(st.draining.since).toLocaleTimeString()}` : ''}`];
  if (st.busy.idle) lines.push('no chat is working');
  for (const c of st.busy.chats) lines.push(`working: ${c.name}${c.backgroundTasks ? ` (${c.backgroundTasks} background task${c.backgroundTasks > 1 ? 's' : ''})` : ''}`);
  for (const t of st.busy.terminals) lines.push(`terminal running: ${t.name}`);
  return lines.join('\n');
}

try {
  if (cmd === 'status') console.log(describe(await api('/status')));
  else if (cmd === 'undrain') console.log(describe(await api('/drain', { on: false })));
  else if (cmd === 'drain') {
    let st = await api('/drain', { on: true, reason: opt('--reason', 'restart') });
    console.log(describe(st));
    if (flag('--wait')) {
      const until = Date.now() + Number(opt('--timeout', '720')) * 60_000;
      let last = '';
      // The chat that asked for this update (it waits on it, so it never goes idle).
      const ignore = opt('--ignore', '');
      const busy = (x) => x.busy.chats.filter((c) => c.id !== ignore);
      while (busy(st).length) {
        if (Date.now() > until) {
          console.error('timed out waiting for chats to finish; still draining (undrain to carry on)');
          process.exit(2);
        }
        await new Promise((r) => setTimeout(r, 5000));
        st = await api('/status');
        const now = busy(st).map((c) => c.name).join(', ');
        if (now !== last) console.log(now ? `waiting for: ${now}` : 'idle');
        last = now;
      }
      console.log('idle: safe to restart');
    }
  } else {
    console.error(`unknown command ${cmd} (status, drain, undrain)`);
    process.exit(1);
  }
} catch (e) {
  console.error(`ctl: ${e.message}`);
  process.exit(1);
}
