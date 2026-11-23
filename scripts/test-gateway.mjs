#!/usr/bin/env node
// Checks for the company AI gateway mode (server/gateway.js) with the fake CLI and a fake gateway:
// the key is write-only, every claude process gets ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN and
// loses the Bedrock variables, settings.json overrides are found and removed, Sign-ins shows the
// gateway instead of a Claude login. Run: node scripts/test-gateway.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gw-'));
const port = 19000 + Math.floor(Math.random() * 500);
const gwPort = port + 500;
const base = `http://127.0.0.1:${port}`;
const gwUrl = `http://127.0.0.1:${gwPort}/anthropic`;
const KEY = 'sk-test-gateway-key-9876';
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });
const log = path.join(tmp, 'fake.log');

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
  FAKE_CLAUDE_LOG_ENV: 'ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,CLAUDE_CODE_USE_BEDROCK,ANTHROPIC_MODEL,AWS_PROFILE',
  // The old shared Bedrock setup, still in the server's environment (.env).
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_MODEL: 'arn:aws:bedrock:old',
  AWS_PROFILE: 'dev',
  // A gateway someone put in .env by hand.
  ANTHROPIC_BASE_URL: 'http://old.example/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'old-env-key',
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });

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

// The gateway: a model list for the right key, 401 otherwise.
const gw = http
  .createServer((req, res) => {
    if (!req.url.startsWith('/anthropic/v1/models')) return res.writeHead(404).end('{}');
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"type":"error"}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5' }] }));
  })
  .listen(gwPort, '127.0.0.1');

/** Env of the newest fake CLI process started after `since` (line count of the log). */
async function spawnedEnv(since) {
  return until(() => {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').slice(since) : [];
    const hit = lines.map((l) => JSON.parse(l)).filter((x) => x.env).pop();
    return hit?.env;
  }, 10_000, 'a claude process');
}
/** The env of the newest claude process's --settings flag (what wins over settings.json). */
function lastSettingsEnv(since) {
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').slice(since).map((l) => JSON.parse(l));
  const argv = lines.filter((x) => x.env).pop()?.argv || [];
  const i = argv.lastIndexOf('--settings');
  try {
    return i >= 0 ? JSON.parse(argv[i + 1]).env || null : null;
  } catch {
    return null;
  }
}
const logLines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);

let server;
async function main() {
  server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  await until(async () => fetch(base + '/api/me').then(() => true).catch(() => false), 15_000, 'server');
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];

  console.log('Off by default');
  let s = (await api('/api/gateway')).j;
  check(s.active === false && s.hasToken === false && s.mode?.source === 'env' && s.external?.source === 'env', 'a gateway in .env is reported as set up outside the UI', s);
  check(s.envConflicts.includes('CLAUDE_CODE_USE_BEDROCK'), 'the Bedrock switch in the environment is reported', s.envConflicts);
  let n = logLines();
  await api('/api/claude/models');
  let e = await spawnedEnv(n);
  check(e.ANTHROPIC_AUTH_TOKEN === 'old-env-key' && e.CLAUDE_CODE_USE_BEDROCK === '1', 'never switched here: claude gets the environment as it was', e);
  check(lastSettingsEnv(n) === null, 'never switched here: no --settings override');

  console.log('A running chat moves with the switch');
  const { project } = (await api('/api/cprojects', { method: 'POST', body: { name: 'Demo', folders: [repo] } })).j;
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'hello' } });
  const firstPid = await until(() => {
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return lines.find((x) => x.env && x.argv.join(' ').includes('coordinator'))?.pid;
  }, 10_000, 'coordinator process');
  await sleep(1500);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  check(alive(firstPid), 'the coordinator process stays up between turns');

  console.log('Saving and testing');
  let r = await api('/api/gateway', { method: 'PUT', body: { enabled: true } });
  check(r.status === 400, 'cannot turn on without an address and key', r.j);
  r = await api('/api/gateway/test', { method: 'POST', body: { baseUrl: gwUrl, token: 'wrong' } });
  check(r.j.ok === false && /refused the key/.test(r.j.error), 'a wrong key is refused', r.j);
  r = await api('/api/gateway/test', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${gwPort + 1}/anthropic`, token: KEY } });
  check(r.j.ok === false && /Could not reach/.test(r.j.error), 'an unreachable gateway is reported', r.j);
  r = await api('/api/gateway/test', { method: 'POST', body: { baseUrl: gwUrl + '/', token: KEY } });
  check(r.j.ok === true && r.j.models?.[0] === 'claude-sonnet-4-5', 'the right key lists the models', r.j);
  r = await api('/api/gateway', { method: 'PUT', body: { enabled: true, baseUrl: gwUrl + '/', token: `  ${KEY}\n` } });
  check(r.status === 200 && r.j.active && r.j.baseUrl === gwUrl && r.j.tokenHint === '…9876', 'saved and on (address trimmed)', r.j);
  check(!r.text.includes(KEY), 'the key is not sent back');
  check(!(await api('/api/gateway')).text.includes(KEY) && !(await api('/api/claude/status')).text.includes(KEY), 'no route returns the key');
  const file = path.join(tmp, 'data', 'gateway.json');
  check((fs.statSync(file).mode & 0o077) === 0, 'gateway.json is readable only by its owner', (fs.statSync(file).mode & 0o777).toString(8));
  r = await api('/api/gateway/test', { method: 'POST', body: {} });
  check(r.j.ok === true, 'test with the saved key', r.j);

  console.log('Claude processes use the gateway');
  n = logLines();
  await api('/api/claude/models');
  e = await spawnedEnv(n);
  check(e.ANTHROPIC_BASE_URL === gwUrl && e.ANTHROPIC_AUTH_TOKEN === KEY && e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '1', 'claude gets the gateway address, key and model discovery', e);
  check(!e.CLAUDE_CODE_USE_BEDROCK && !e.ANTHROPIC_MODEL, 'the Bedrock switch and model pin are removed', e);
  let se = lastSettingsEnv(n);
  check(se?.ANTHROPIC_BASE_URL === gwUrl && se.CLAUDE_CODE_USE_BEDROCK === '' && se.ANTHROPIC_API_KEY === '' && !('ANTHROPIC_AUTH_TOKEN' in se), '--settings pins the gateway over settings.json files (no key in the arguments)', se);
  check(e.AWS_PROFILE === 'dev', "AWS_PROFILE is left for Claude's own aws commands", e);
  await until(() => !alive(firstPid), 8000, 'the old coordinator process to stop').catch(() => null);
  check(!alive(firstPid), 'turning the gateway on restarts the idle chat process');
  n = logLines();
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'again' } });
  e = await spawnedEnv(n);
  check(e.ANTHROPIC_AUTH_TOKEN === KEY, "the chat's next message runs on the gateway", e);
  r = await api('/api/gateway', { method: 'PUT', body: { discovery: false } });
  n = logLines();
  await api('/api/claude/models');
  e = await spawnedEnv(n);
  check(e.ANTHROPIC_AUTH_TOKEN === KEY && !e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, 'model discovery can be turned off', e);
  await api('/api/gateway', { method: 'PUT', body: { discovery: true } });

  console.log('Sign-ins and login status');
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  const si = (await api('/api/sign-ins')).j;
  const row = (si.rows || []).find((x) => x.kind === 'claude');
  check(row?.state === 'gateway' && row.host === `127.0.0.1:${gwPort}` && !row.nextAt, 'Sign-ins shows the gateway key, not the Claude login', si);

  console.log('settings.json overrides');
  const settings = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', KEEP_ME: 'x' } }, null, 2));
  s = (await api('/api/gateway')).j;
  check(s.settingsConflicts.includes('CLAUDE_CODE_USE_BEDROCK') && s.settingsConflicts.includes('AWS_REGION') && !s.settingsConflicts.includes('KEEP_ME'), 'conflicting keys in settings.json are found', s.settingsConflicts);
  r = await api('/api/gateway/fix-settings', { method: 'POST' });
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check(r.j.removed?.length === 2 && after.env.KEEP_ME === 'x' && !after.env.CLAUDE_CODE_USE_BEDROCK && after.model === 'opus', 'they are removed, everything else kept', after);
  check(fs.existsSync(settings + '.before-gateway') && r.j.status.settingsConflicts.length === 0, 'a backup is kept and no conflicts remain');

  console.log('Turning it off really goes back to the Claude login');
  await api('/api/gateway', { method: 'PUT', body: { enabled: false } });
  n = logLines();
  await api('/api/claude/models');
  e = await spawnedEnv(n);
  check(!e.ANTHROPIC_AUTH_TOKEN && !e.ANTHROPIC_BASE_URL && !e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, 'switched off: no gateway variables, not even the ones from .env', e);
  se = lastSettingsEnv(n);
  check(se?.ANTHROPIC_BASE_URL === '' && se.ANTHROPIC_AUTH_TOKEN === '' && se.CLAUDE_CODE_USE_BEDROCK === '', 'switched off: --settings blanks the gateway and Bedrock, whatever settings.json says', se);
  s = (await api('/api/gateway')).j;
  check(s.mode === null && s.external === null, 'switched off: no gateway reported', s);
  n = logLines();
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'and back' } });
  e = await spawnedEnv(n);
  check(!e.ANTHROPIC_AUTH_TOKEN && !e.ANTHROPIC_BASE_URL, "the open chat's next message is back on the Claude login", e);

  console.log('Gateway set up by hand in settings.json');
  await api('/api/gateway', { method: 'PUT', body: { enabled: false, token: '' } });
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: gwUrl, ANTHROPIC_AUTH_TOKEN: KEY } }));
  r = await api('/api/gateway');
  check(r.j.active === false && r.j.mode === null && r.j.settingsGateway === true, 'the switch is off and wins: settings.json gateway noted but not in use', r.j);
  check(!r.text.includes(KEY), 'the hand-set key is not sent back either');
  n = logLines();
  await api('/api/claude/models');
  e = await spawnedEnv(n);
  check(!e.ANTHROPIC_AUTH_TOKEN, 'with the UI setting off, nothing is added to the environment', e);
  r = await api('/api/gateway/import', { method: 'POST' });
  const cleaned = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check(r.j.active && r.j.baseUrl === gwUrl && r.j.tokenHint === '…9876' && !cleaned.env, '"Manage it here" moves the gateway from settings.json into the switch', { r: r.j, cleaned });
  check(!r.text.includes(KEY), 'the moved key is not sent back');
  await api('/api/gateway', { method: 'PUT', body: { enabled: false } });
  n = logLines();
  await api('/api/claude/models');
  e = await spawnedEnv(n);
  check(!e.ANTHROPIC_AUTH_TOKEN && (await api('/api/gateway')).j.mode === null, 'after moving it, the switch turns it off', e);
  await failover(project);
}

/** Prompts the fake CLI got since log line `since`, with the env of the process that got them. */
function promptsSince(since) {
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').slice(since).map((l) => JSON.parse(l));
  const envOf = new Map(lines.filter((x) => x.env).map((x) => [x.pid, x.env]));
  return lines.filter((x) => x.prompt).map((x) => ({ text: x.prompt, env: envOf.get(x.pid) || null }));
}

async function failover(project) {
  console.log('Failover: the gateway steps in when the subscription runs out');
  let s = (await api('/api/gateway', { method: 'PUT', body: { failover: { enabled: true } } })).j;
  check(s.failover.enabled && s.failover.weekly && !s.failover.fiveHour && !s.active, 'failover on: weekly yes, 5-hour no by default, gateway not in use yet', s.failover);
  // Resets in a few seconds, so the project's own wait for it is over before the next steps.
  const soon = Math.floor(Date.now() / 1000) + 4;
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: `@@limit {"rateLimitType":"five_hour","resetsAt":${soon}}` } });
  await sleep(2500);
  s = (await api('/api/gateway')).j;
  check(!s.active && s.mode === null, 'the 5-hour limit does not switch (off by default)', s.mode);
  const d1 = (await api(`/api/cprojects/${project.id}`)).j.project;
  check(d1.limit?.until === soon * 1000, 'the project waits for the 5-hour reset as before', d1.limit);
  await until(async () => !(await api(`/api/cprojects/${project.id}`)).j.project.limit, 10_000, 'the 5-hour reset').catch(() => null);
  await sleep(1500);

  const week = Math.floor(Date.now() / 1000) + 5 * 86400;
  const n = logLines();
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: `@@limit {"rateLimitType":"seven_day","resetsAt":${week}}` } });
  s = (await until(async () => {
    const r = (await api('/api/gateway')).j;
    return r.active && r;
  }, 8000, 'failover to engage').catch(() => ({})));
  check(s.active && s.mode?.source === 'failover' && s.failoverKind === 'weekly' && s.failoverUntil === week * 1000, 'the weekly limit switches every chat to the gateway until it resets', s);
  const cont = await until(() => promptsSince(n).find((p) => /continues on the company AI gateway/.test(p.text)), 10_000, 'continuation').catch(() => null);
  check(cont && cont.env?.ANTHROPIC_AUTH_TOKEN === KEY, 'the cut-off chat continues by itself, on the gateway', cont);
  const d2 = (await api(`/api/cprojects/${project.id}`)).j.project;
  check(d2.feed.filter((e) => e.type === 'turn.failed' && /usage limit/.test(e.body?.text || '')).length === 1, 'no failed turn is reported for the switch (only the earlier 5-hour one)');
  const si = (await api('/api/sign-ins')).j.rows.find((x) => x.kind === 'claude');
  check(si?.state === 'gateway', 'Sign-ins shows the gateway while it stands in', si);

  console.log('Back to the subscription');
  const n2 = logLines();
  s = (await api('/api/gateway/end-failover', { method: 'POST' })).j;
  check(!s.active && s.mode === null && s.failoverUntil === 0, '"Back to subscription now" ends it', s);
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: 'after the reset' } });
  const back = await until(() => promptsSince(n2).find((p) => /after the reset/.test(p.text)), 10_000, 'next message').catch(() => null);
  check(back && !back.env?.ANTHROPIC_AUTH_TOKEN, "the chat's next message is on the subscription again", back);

  s = (await api('/api/gateway', { method: 'PUT', body: { failover: { fiveHour: true } } })).j;
  check(s.failover.fiveHour && s.failover.weekly, 'the 5-hour limit can be ticked too', s.failover);
  const soon2 = Math.floor(Date.now() / 1000) + 1800;
  await sleep(1500);
  await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: `@@limit {"rateLimitType":"five_hour","resetsAt":${soon2}}` } });
  s = (await until(async () => {
    const r = (await api('/api/gateway')).j;
    return r.active && r;
  }, 8000, 'failover on 5-hour').catch(() => ({})));
  check(s.failoverKind === 'five_hour', 'then the 5-hour limit switches too', s);
  s = (await api('/api/gateway', { method: 'PUT', body: { failover: { fiveHour: false } } })).j;
  check(!s.active, 'unticking the limit it stands in for goes back to the subscription', s);
  s = (await api('/api/gateway', { method: 'PUT', body: { failover: { enabled: false } } })).j;
  check(!s.failover.enabled && !s.active, 'failover off');
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    server?.kill('SIGTERM');
    gw.close();
    console.log(`\n${passes} passed, ${failures} failed`);
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log("kept", tmp);
    process.exit(failures ? 1 : 0);
  });
