#!/usr/bin/env node
// The updater: a small service in its own container (docker-compose.yml, service "updater") that
// updates Claude UI by running scripts/deploy.sh in the checkout docker compose runs from. It
// outlives the web server it restarts, so a chat or Settings > Server can ask for an update and
// see how it went. Only the web server can reach it (its socket is hidden from the runner, where
// chats run).
//
// HTTP over a Unix socket ($CW_UPDATER_SOCKET):
//   GET  /status                 what is running now, the last run, the checkout
//   GET  /check?ref=main         fetch and compare: current commit, the branch's latest, commits between
//   POST /deploy {ref, runner, source, expect}
//        source "chat": main only, and `expect` (the commit the user approved) must still be main's tip
//   GET  /runs/<id>              a run's state and the end of its log
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const expand = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, home));
const SOCK = expand(process.env.CW_UPDATER_SOCKET || path.join(home, '.claude-web', 'updater', 'updater.sock'));
const REPO = expand(process.env.CW_UPDATER_REPO || '/deploy');
const RUNS = path.join(path.dirname(SOCK), 'runs');
const REF_RE = /^[\w][\w./-]{0,120}$/;
const CHAT_REF = 'main';

const git = (args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile('git', ['-C', REPO, ...args], { timeout: 120_000, maxBuffer: 4 << 20, ...opts }, (e, out, err) => (e ? reject(new Error((err || e.message).trim())) : resolve(out.trim())))
  );

/** The compose project this updater belongs to, so deploy.sh drives the right containers. */
async function composeProject() {
  if (process.env.COMPOSE_PROJECT_NAME) return process.env.COMPOSE_PROJECT_NAME;
  return new Promise((resolve) =>
    execFile('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', os.hostname()], (e, out) => resolve(e ? '' : out.trim()))
  );
}

let current = null; // the run in progress
const runs = new Map();

function loadRuns() {
  fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8'));
      // A run the updater was itself stopped in the middle of.
      if (r.status === 'running') r.status = 'interrupted';
      runs.set(r.id, r);
    } catch {}
  }
}

function saveRun(r) {
  fs.writeFileSync(path.join(RUNS, `${r.id}.json`), JSON.stringify(r, null, 2), { mode: 0o600 });
}

function tail(r, bytes = 8192) {
  try {
    const st = fs.statSync(r.log);
    const fd = fs.openSync(r.log, 'r');
    const n = Math.min(bytes, st.size);
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n);
    fs.closeSync(fd);
    return b.toString('utf8');
  } catch {
    return '';
  }
}

const view = (r) => r && { ...r, log: undefined, output: tail(r) };

async function check(ref) {
  if (!REF_RE.test(ref)) throw Object.assign(new Error('bad branch name'), { status: 400 });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await git(['rev-parse', '--short', 'HEAD']);
  await git(['fetch', '--quiet', 'origin', ref]);
  const target = await git(['rev-parse', '--short', 'FETCH_HEAD']);
  const log = await git(['log', '--no-decorate', '--format=%h %s', '-n', '30', `HEAD..FETCH_HEAD`]).catch(() => '');
  const behind = Number(await git(['rev-list', '--count', 'HEAD..FETCH_HEAD']).catch(() => '0'));
  const dirty = !!(await git(['status', '--porcelain', '--untracked-files=no']).catch(() => ''));
  return { ref, branch, head, target, behind, upToDate: behind === 0 && (branch === ref || head === target), commits: log ? log.split('\n').map((l) => ({ sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) })) : [], dirty };
}

async function deploy({ ref = CHAT_REF, runner = false, source = 'settings', expect, requestedBy, ignoreChat } = {}) {
  if (current) throw Object.assign(new Error(`an update is already running (${current.id})`), { status: 409 });
  if (!REF_RE.test(ref)) throw Object.assign(new Error('bad branch name'), { status: 400 });
  if (source === 'chat') {
    // Chats update from main only, and only to the commit the user saw and approved.
    if (ref !== CHAT_REF) throw Object.assign(new Error(`chats can only update from ${CHAT_REF}; use Settings > Server for other branches`), { status: 403 });
    const c = await check(CHAT_REF);
    if (!expect || !c.target.startsWith(String(expect).slice(0, 7)) || !String(expect).startsWith(c.target.slice(0, 7))) {
      throw Object.assign(new Error(`${CHAT_REF} is now at ${c.target}, not the approved ${expect || '(none)'}; check again and ask for approval`), { status: 409 });
    }
  }
  const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  const from = await git(['rev-parse', '--short', 'HEAD']).catch(() => null);
  const r = { id, status: 'running', ref, runner: !!runner, source, requestedBy: requestedBy || null, from, to: null, startedAt: Date.now(), endedAt: null, exitCode: null, log: path.join(RUNS, `${id}.log`) };
  const project = await composeProject();
  const out = fs.openSync(r.log, 'a', 0o600);
  const args = [path.join(REPO, 'scripts', 'deploy.sh'), '--ref', ref];
  if (source === 'chat') args.push('--commit', String(expect));
  if (runner) args.push('--runner');
  if (runner && ignoreChat && /^[\w-]{1,64}$/.test(ignoreChat)) args.push('--ignore-chat', ignoreChat);
  const p = spawn('bash', args, { cwd: REPO, env: { ...process.env, ...(project ? { COMPOSE_PROJECT_NAME: project } : {}) }, stdio: ['ignore', out, out] });
  current = r;
  runs.set(id, r);
  saveRun(r);
  p.on('close', async (code) => {
    fs.closeSync(out);
    r.exitCode = code;
    r.endedAt = Date.now();
    r.to = await git(['rev-parse', '--short', 'HEAD']).catch(() => null);
    r.status = code === 0 ? 'ok' : code === 3 ? 'rolled-back' : code === 2 ? 'waiting-timed-out' : 'failed';
    current = null;
    saveRun(r);
    console.log(`updater: run ${id} ${r.status} (${r.from} -> ${r.to})`);
  });
  console.log(`updater: run ${id} started (${source}, ${ref}${runner ? ', with runner' : ''})`);
  return view(r);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startUpdater() {
  loadRuns();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://updater');
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const last = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0] || null;
        return send(res, 200, { running: view(current), last: view(last), repo: REPO, project: await composeProject(), commit: await git(['rev-parse', '--short', 'HEAD']).catch(() => null), branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null) });
      }
      if (req.method === 'GET' && url.pathname === '/check') return send(res, 200, await check(url.searchParams.get('ref') || CHAT_REF));
      if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
        const r = runs.get(url.pathname.slice(6));
        return r ? send(res, 200, view(r)) : send(res, 404, { error: 'no such run' });
      }
      if (req.method === 'POST' && url.pathname === '/deploy') {
        let body = '';
        for await (const c of req) body += c;
        return send(res, 200, await deploy(JSON.parse(body || '{}')));
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  const old = process.umask(0o177);
  server.listen(SOCK, () => {
    process.umask(old);
    console.log(`updater: listening on ${SOCK} (checkout ${REPO})`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) startUpdater();
