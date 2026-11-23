#!/usr/bin/env node
// The chat's pull request (server/pr-status.js) with a scripted gh (scripts/fake-gh.mjs):
// a GitHub Enterprise remote, older Enterprise servers, gh not signed in, unexpected errors,
// and the chat environment's variables reaching gh.
// Run: node scripts/test-pr-status.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CW_GH_BIN = path.join(here, 'fake-gh.mjs');
fs.chmodSync(process.env.CW_GH_BIN, 0o755);
const { prStatus } = await import('../server/pr-status.js');

let failures = 0;
const check = (cond, msg, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`, !cond && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  if (!cond) failures++;
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pr-'));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['remote', 'add', 'origin', 'git@github-chf01.example.com:hyperscale/hyperscale-ui-streamer.git'], { cwd: repo });
const mode = (m, opts) => {
  process.env.FAKE_GH_MODE = m;
  return prStatus(repo, opts);
};

let r = await mode('branch');
check(r.pr?.number === 1520 && /github-chf01/.test(r.pr.url) && r.pr.summary.pass === 2 && r.pr.summary.pending === 1, 'PR on an Enterprise host is found', r);
r = await mode('oldghes');
check(r.pr?.number === 1520 && r.pr.mergeable === null, 'older Enterprise server: asks again with the basic fields', r);
r = await mode('none');
check(r.available && r.pr === null && !r.error, 'no PR: nothing shown', r);
r = await mode('auth');
check(r.available === false && /gh auth login --hostname github-chf01\.example\.com/.test(r.reason), 'not signed in: says to sign in for the Enterprise host', r);
r = await mode('odd');
check(r.pr === null && /502/.test(r.error), 'unexpected error is returned, not hidden', r);
process.env.FAKE_GH_ENV_CHECK = 'github-chf01.example.com';
r = await mode('branch', { env: { GH_HOST: 'github-chf01.example.com' } });
check(r.pr?.number === 1520, "the chat environment's variables reach gh", r);
delete process.env.FAKE_GH_ENV_CHECK;

fs.rmSync(repo, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
