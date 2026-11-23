#!/usr/bin/env node
// Finding a chat's pull request (server/pr-status.js) with a scripted gh (scripts/fake-gh.mjs):
// a worktree branch pushed under another name, a GitHub Enterprise remote, older Enterprise servers,
// gh not signed in to the host, and PR links the chat printed.
// Run: node scripts/test-pr-status.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CW_GH_BIN = path.join(here, 'fake-gh.mjs');
fs.chmodSync(process.env.CW_GH_BIN, 0o755);
const { prStatus, remotes, prLinks } = await import('../server/pr-status.js');

let failures = 0;
const check = (cond, msg, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`, !cond && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  if (!cond) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pr-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main');
g('commit', '-q', '--allow-empty', '-m', 'base');
g('remote', 'add', 'origin', 'git@github-chf01.example.com:hyperscale/hyperscale-ui-streamer.git');
g('update-ref', 'refs/remotes/origin/main', 'HEAD');
g('checkout', '-q', '-b', 'claude/pr-1494-ci-green-mwt7cqhw');
g('commit', '-q', '--allow-empty', '-m', 'fix ci');
const head = g('rev-parse', 'HEAD');
process.env.FAKE_GH_HEAD = head;
const URL = 'https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer/pull/1520';
const said = [`Opened it: ${URL}`, 'Unrelated: https://github.com/other/repo/pull/9'];

const rems = await remotes(repo);
check(rems.length === 1 && rems[0].host === 'github-chf01.example.com' && rems[0].repo === 'hyperscale/hyperscale-ui-streamer', 'ssh remote on an Enterprise host is parsed', rems);
check(prLinks(said, rems).length === 1 && prLinks(said, rems)[0].number === 1520, 'only links to this repository count', prLinks(said, rems));

const mode = async (m, opts) => {
  process.env.FAKE_GH_MODE = m;
  return prStatus(repo, opts);
};

let r = await mode('branch');
check(r.pr?.number === 1520 && r.pr.url === URL && r.pr.summary.pass === 2 && r.pr.summary.pending === 1, 'branch: PR on the Enterprise host is found', r);

r = await mode('oldghes');
check(r.pr?.number === 1520 && r.pr.mergeable === null, 'older Enterprise server: asks again with the basic fields', r);

r = await mode('upstream');
check(r.pr === null, 'upstream: nothing found while the branch has no upstream', r);
g('update-ref', 'refs/remotes/origin/claude/fix-ci-1494', 'HEAD');
g('branch', '--set-upstream-to', 'origin/claude/fix-ci-1494');
r = await mode('upstream');
check(r.pr?.number === 1520 && r.pr.via === 'upstream', 'upstream: worktree branch pushed under another name is found', r);

r = await mode('commit');
check(r.pr?.number === 1520 && r.pr.via === 'commit', 'commit: PR whose head is this commit is found', r);

r = await mode('chat', { texts: said });
check(r.pr?.number === 1520 && r.pr.via === 'chat', 'chat: PR link the chat printed is used when its head is in history', r);
process.env.FAKE_GH_HEAD = 'f'.repeat(40);
r = await mode('chat', { texts: said });
check(r.pr === null, 'chat: a linked PR whose head is not in this history is ignored', r);
process.env.FAKE_GH_HEAD = head;

r = await mode('auth');
check(r.available === false && /github-chf01\.example\.com/.test(r.reason), 'auth, no link: says to sign in for the Enterprise host', r);
r = await mode('auth', { texts: said });
check(r.pr?.linkOnly && r.pr.url === URL && /gh auth login --hostname github-chf01/.test(r.note), 'auth, with link: shows the link and why there is no status', r);

r = await mode('odd');
check(r.pr === null && /502/.test(r.error), 'unexpected gh error is returned, not hidden', r);

process.env.FAKE_GH_LOG = path.join(tmp, 'gh.log');
g('branch', '--unset-upstream');
g('update-ref', '-d', 'refs/remotes/origin/claude/fix-ci-1494');
await mode('upstream');
const calls = fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n');
check(calls.length === 1, 'nothing pushed and no links: a single gh call', calls);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
