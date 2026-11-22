#!/usr/bin/env node
// Checks that chats can find each other with the sessions MCP tools: list_sessions with no
// children shows every chat, and send_to_session takes an id prefix or a chat name.
// Run: node scripts/test-sessions.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rep-'));
const port = 19000 + Math.floor(Math.random() * 900); const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(tmp, 'projects', 'demo'), { recursive: true });
const env = { ...process.env, CW_PORT: String(port), CW_PASSWORD: 'pw', CW_DATA_DIR: path.join(tmp, 'data'), CW_PROJECTS_ROOT: path.join(tmp, 'projects'), CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'), CW_BROWSER: '0', CW_AUTO_TITLES: '0', FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];
const srv = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const api = async (p, b) => { const r = await fetch(base + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base + '/api/me').then(() => 1, () => 0)) break; await sleep(150); }
  const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = lr.headers.get('set-cookie').split(';')[0];
  const b = (await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Soak' })).session;
  const short = b.id.slice(0, 8);
  const lines = [`@@call sessions__list_sessions {}`, `@@call sessions__list_sessions {"all":true}`, `@@call sessions__send_to_session ${JSON.stringify({ id: short, message: 'hello by prefix' })}`, `@@call sessions__send_to_session ${JSON.stringify({ id: 'Soak', message: 'hello by name' })}`,
    // Ids that are not chats: a running background subagent of this chat, a finished one (agent-like id), and junk.
    '@@bgtask 20000 #a7f18f83a2845f75e', '@@call sessions__read_session {"id":"a7f18f83a2845f75e"}', '@@call sessions__read_session {"id":"a0123456789abcdef"}', '@@call sessions__send_to_session {"id":"zzz-nope","message":"hi"}'];
  await api('/api/sessions', { kind: 'chat', cwd: 'demo', name: 'Caller', prompt: lines.join('\n') });
  for (let i = 0; i < 60; i++) { await sleep(250); const l = fs.existsSync(env.FAKE_CLAUDE_LOG) ? fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8') : ''; if ((l.match(/"call":"sessions__send_to_session"/g) || []).length >= 3) break; }
  await sleep(1500);
  const log = fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const calls = log.filter((x) => x.call);
  let fails = 0;
  const check = (c, m, x) => (c ? console.log(`  ok   ${m}`) : (fails++, console.log(`  FAIL ${m}`, JSON.stringify(x ?? '').slice(0, 400))));
  const lists = calls.filter((x) => x.call === 'sessions__list_sessions');
  check(lists[0] && !lists[0].result.includes(b.id) && /all=true/.test(lists[0].result), 'list_sessions defaults to children and says how to see every chat', lists[0]);
  check(lists[1] && lists[1].result.includes(b.id), 'list_sessions all=true lists the other chats', lists[1]);
  const sends = calls.filter((x) => x.call === 'sessions__send_to_session');
  check(sends[0] && /Delivered|Queued/.test(sends[0].result) && !/Error/.test(sends[0].result), 'send_to_session accepts an 8-character id prefix', sends[0]);
  check(sends[1] && /Delivered|Queued/.test(sends[1].result) && !/Error/.test(sends[1].result), 'send_to_session accepts a chat name', sends[1]);
  const soak = log.filter((x) => x.prompt && !x.prompt.includes('@@call')).map((x) => x.prompt).join('\n');
  check(soak.includes('hello by prefix') && soak.includes('hello by name'), 'the target chat receives both messages', soak.slice(0, 300));
  const reads = calls.filter((x) => x.call === 'sessions__read_session');
  check(reads[0] && !/Error/.test(reads[0].result) && /background agent of this chat/.test(reads[0].result) && /running/.test(reads[0].result), 'read_session on a background subagent id returns its status', reads[0]);
  check(reads[1] && /looks like a background subagent id/.test(reads[1].result) && reads[1].result.includes(b.id), 'an agent-like id that is gone says so and lists the chats', reads[1]);
  check(sends[2] && /Error/.test(sends[2].result) && reads[1] && sends[2].result.includes(b.id) && sends[2].result.includes('"Soak"'), 'a junk id lists the chats on this server in the error', sends[2]);
  if (process.env.VERBOSE) for (const x of [...reads, sends[2]]) console.log(x?.result);
  process.exitCode = fails ? 1 : 0;
} finally { srv.kill(); }
