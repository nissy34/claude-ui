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
const { prStatus, prLinks, repoKey } = await import('../server/pr-status.js');

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

// Chats that push to another branch (e.g. an existing PR's): the repository's PRs the chat linked to.
check(repoKey('git@github-chf01.example.com:hyperscale/hyperscale-ui-streamer.git') === 'github-chf01.example.com/hyperscale/hyperscale-ui-streamer', 'scp-style Enterprise remote is parsed');
const base = 'https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer/pull/';
const said = [`Watching ${base}1494`, `Merged ${base}1521, back on ${base}1494`, 'Unrelated https://github.com/other/repo/pull/9', `Opened ${base}1520`, `Old ${base}404`];
check(JSON.stringify(prLinks(said, new Set(['github-chf01.example.com/hyperscale/hyperscale-ui-streamer'])).map((u) => +u.split('/').pop())) === '[404,1520,1494,1521]', 'links: this repository only, newest first, once each', prLinks(said, new Set(['github-chf01.example.com/hyperscale/hyperscale-ui-streamer'])));
r = await mode('none', { texts: said });
check(r.pr === null && JSON.stringify(r.linked.map((p) => p.number)) === '[1520,1494]' && r.linked[1].head === 'multisession', 'no PR on the branch: linked PRs are listed (a link gh cannot open is skipped, three at most)', r);
r = await mode('branch', { texts: said });
check(r.pr?.number === 1520 && JSON.stringify(r.linked.map((p) => p.number)) === '[1494,1521]', "the branch's own PR is not listed twice", r);
r = await mode('none');
check(r.linked === undefined, 'no chat text: no linked lookup (sidebar sweep stays at one gh call)', r);

fs.rmSync(repo, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
