#!/usr/bin/env node
// Checks for signing in with a Claude OAuth token (claude setup-token), server/gateway.js, with the
// fake CLI: the token is write-only, every claude process gets CLAUDE_CODE_OAUTH_TOKEN and loses
// what Claude Code would pick over it, the gateway still wins when on, "Claude login" removes a
// token set in .env, and the Test button tells a good token from a bad one.
// Run: node scripts/test-oauth-token.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tok-'));
const port = 20000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const GOOD = 'sk-ant-oat01-good-token-abcd';
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(tmp, 'projects', 'demo'), { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });
const log = path.join(tmp, 'fake.log');
const settings = path.join(claudeDir, 'settings.json');

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  CLAUDE_CONFIG_DIR: claudeDir,
  FAKE_CLAUDE_LOG: log,
  FAKE_CLAUDE_GOOD_TOKEN: GOOD,
  FAKE_CLAUDE_LOG_ENV: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY,CLAUDE_CODE_USE_BEDROCK,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL',
  // Set by hand in .env: an older token, an API key and the Bedrock switch (both beat a token).
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-old-env-token',
  ANTHROPIC_API_KEY: 'sk-ant-api03-env-key',
  CLAUDE_CODE_USE_BEDROCK: '1',
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];

let failures = 0;
let passes = 0;
const check = (cond, msg, extra) => {
  if (cond) {
    passes++;
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function api(p, opts = {}) {
  const res = await fetch(base + p, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: res.status, j, text };
}
async function until(fn, ms = 10_000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const logLines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
const entries = (since) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').slice(since).map((l) => JSON.parse(l)) : []);
/** Env and --settings env of the newest long-running claude process started after log line `since`. */
async function spawned(since) {
  const hit = await until(() => entries(since).filter((x) => x.env && !x.argv.includes('json')).pop(), 10_000, 'a claude process');
  const i = hit.argv.lastIndexOf('--settings');
  let se = null;
  try {
    se = i >= 0 ? JSON.parse(hit.argv[i + 1]).env || null : null;
  } catch {}
  let helper;
  try {
    helper = i >= 0 ? JSON.parse(hit.argv[i + 1]).apiKeyHelper : undefined;
  } catch {}
  return { e: hit.env, se, argv: hit.argv, helper };
}
// The model list is cached until a sign-in change; `fresh` saves the same choice again to clear it.
async function modelsProcess(fresh) {
  if (fresh) await api('/api/claude-token', { method: 'PUT', body: { use: fresh } });
  const n = logLines();
  await api('/api/claude/models');
  return spawned(n);
}

let server;
async function main() {
  server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];

  console.log('Never chosen: the environment as it is');
  let s = (await api('/api/claude-token')).j;
  check(s.use === '' && !s.hasToken && s.envToken && s.mode?.source === 'env', 'a token in .env is reported as set up outside the UI', s);
  let { e, se } = await modelsProcess();
  check(e.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-old-env-token' && e.ANTHROPIC_API_KEY && se === null, 'claude gets the environment unchanged, no --settings override', { e, se });

  console.log('Saving and testing');
  let r = await api('/api/claude-token', { method: 'PUT', body: { use: 'token' } });
  check(r.status === 400, 'cannot pick the token before pasting one', r.j);
  r = await api('/api/claude-token', { method: 'PUT', body: { token: 'sk-ant-api03-abc' } });
  check(r.status === 400 && /API key/.test(r.j.error), 'an API key is refused with a clear message', r.j);
  r = await api('/api/claude-token', { method: 'PUT', body: { token: 'hello world' } });
  check(r.status === 400, 'text with spaces is refused', r.j);
  r = await api('/api/claude-token/test', { method: 'POST', body: { token: 'sk-ant-oat01-wrong' } });
  check(r.j.ok === false && /refused the token/.test(r.j.error), 'Test: a wrong token is refused', r.j);
  r = await api('/api/claude-token/test', { method: 'POST', body: { token: GOOD } });
  check(r.j.ok === true, 'Test: the right token works', r.j);
  const testRun = entries(0).filter((x) => x.env && x.argv.includes('json')).pop();
  check(testRun && testRun.argv.includes('haiku') && !testRun.env.ANTHROPIC_API_KEY && !testRun.env.CLAUDE_CODE_USE_BEDROCK, 'Test runs the smallest model without the variables that beat a token', testRun);
  r = await api('/api/claude-token', { method: 'PUT', body: { token: `  ${GOOD}\n`, use: 'token' } });
  check(r.status === 200 && r.j.active && r.j.use === 'token' && r.j.tokenHint === '…abcd' && r.j.mode?.source === 'ui', 'saved and in use', r.j);
  check(!r.text.includes(GOOD) && !(await api('/api/claude-token')).text.includes(GOOD) && !(await api('/api/gateway')).text.includes(GOOD), 'no route returns the token');
  const file = path.join(tmp, 'data', 'claude-token.json');
  check((fs.statSync(file).mode & 0o077) === 0, 'claude-token.json is readable only by its owner', (fs.statSync(file).mode & 0o777).toString(8));
  r = await api('/api/claude-token/test', { method: 'POST', body: {} });
  check(r.j.ok === true, 'Test with the saved token', r.j);

  console.log('Claude processes use the token');
  ({ e, se } = await modelsProcess());
  check(e.CLAUDE_CODE_OAUTH_TOKEN === GOOD, 'claude gets the saved token, not the one from .env', e);
  check(!e.ANTHROPIC_API_KEY && !e.CLAUDE_CODE_USE_BEDROCK, 'the API key and Bedrock switch are removed', e);
  check(se?.ANTHROPIC_API_KEY === '' && se.CLAUDE_CODE_USE_BEDROCK === '' && se.ANTHROPIC_BASE_URL === '' && !('CLAUDE_CODE_OAUTH_TOKEN' in se), '--settings blanks them over settings.json files (no token in the arguments)', se);
  fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-settings', ANTHROPIC_API_KEY: 'x' } }));
  ({ e, se } = await modelsProcess('token'));
  check(se?.CLAUDE_CODE_OAUTH_TOKEN === GOOD && se.ANTHROPIC_API_KEY === '', 'a token in settings.json is overridden by the saved one', se);
  fs.writeFileSync(settings, JSON.stringify({ apiKeyHelper: 'echo k' }));
  s = (await api('/api/claude-token')).j;
  check(s.apiKeyHelper === true, 'an apiKeyHelper in settings.json is reported', s);
  const { helper } = await modelsProcess('token');
  check(helper === '', '--settings turns an apiKeyHelper off while the token is in use', helper);
  fs.rmSync(settings);
  const si = (await api('/api/sign-ins')).j.rows.find((x) => x.kind === 'claude');
  check(si?.state === 'long-lived' && /Settings > Account/.test(si.note), 'Sign-ins shows the long-lived token', si);
  check((await api('/api/gateway')).j.login?.source === 'ui', 'the gateway status carries the token login for chats');

  console.log('A chat follows the choice');
  const { project } = (await api('/api/cprojects', { method: 'POST', body: { name: 'Demo', folders: [path.join(tmp, 'projects', 'demo')] } })).j;
  let n = logLines();
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'hello' } });
  ({ e } = await spawned(n));
  check(e.CLAUDE_CODE_OAUTH_TOKEN === GOOD, "the project's coordinator signs in with the token", e);

  console.log('The gateway still wins when on');
  await api('/api/gateway', { method: 'PUT', body: { enabled: true, baseUrl: 'http://127.0.0.1:9/anthropic', token: 'gw-key' } });
  s = (await api('/api/claude-token')).j;
  check(!s.active && s.gateway === 'always' && s.mode === null, 'gateway Always: the token is noted but not in use', s);
  ({ e } = await modelsProcess());
  check(e.ANTHROPIC_AUTH_TOKEN === 'gw-key' && !e.CLAUDE_CODE_OAUTH_TOKEN, 'claude gets the gateway key and no token', e);
  await api('/api/gateway', { method: 'PUT', body: { enabled: false, failover: { enabled: true } } });
  s = (await api('/api/claude-token')).j;
  check(s.active && !s.gateway, 'gateway As fallback: the token is in use until a limit is reached', s);
  ({ e, se } = await modelsProcess());
  check(e.CLAUDE_CODE_OAUTH_TOKEN === GOOD && !e.ANTHROPIC_AUTH_TOKEN && se.ANTHROPIC_AUTH_TOKEN === '', 'back on the token, gateway blanked', { e, se });
  await api('/api/gateway', { method: 'PUT', body: { failover: { enabled: false } } });

  console.log('"Claude login" means the server login, even with a token in .env');
  n = logLines();
  r = await api('/api/claude-token', { method: 'PUT', body: { use: 'login' } });
  check(r.j.use === 'login' && !r.j.active && r.j.hasToken && r.j.mode === null, 'switched to the Claude login, token kept for later', r.j);
  ({ e, se } = await modelsProcess());
  check(!e.CLAUDE_CODE_OAUTH_TOKEN && se?.CLAUDE_CODE_OAUTH_TOKEN === '', 'no token in the environment, and --settings blanks one in settings.json', { e, se });
  check(e.ANTHROPIC_API_KEY === 'sk-ant-api03-env-key', 'other variables are left as they were', e);
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'again' } });
  const next = await until(() => entries(n).filter((x) => x.env && x.argv.join(' ').includes('coordinator')).pop(), 10_000, 'coordinator restart').catch(() => null);
  check(next && !next.env.CLAUDE_CODE_OAUTH_TOKEN, "the project's next message runs on the Claude login", next?.env);
  check(!(await api('/api/sign-ins')).j.rows.some((x) => x.kind === 'claude' && x.state === 'long-lived'), 'Sign-ins no longer shows the token');

  console.log('Removing the token');
  r = await api('/api/claude-token', { method: 'PUT', body: { use: 'token' } });
  check(r.j.active, 'and back to the saved token in one click', r.j);
  r = await api('/api/claude-token', { method: 'PUT', body: { token: '' } });
  check(r.j.use === 'login' && !r.j.hasToken && !r.j.active, 'removing it goes back to the Claude login', r.j);
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    server?.kill('SIGTERM');
    console.log(`\n${passes} passed, ${failures} failed`);
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log('kept', tmp);
    process.exit(failures ? 1 : 0);
  });
