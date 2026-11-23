#!/usr/bin/env node
// A scripted `gh` for tests (CW_GH_BIN). FAKE_GH_MODE picks how it behaves:
//   branch   - `gh pr view` finds the PR for the checked-out branch
//   upstream - only `gh pr view <upstream branch name>` finds it
//   commit   - only `gh pr list --search <sha>` finds it
//   chat     - only `gh pr view <url>` finds it
//   auth     - every call fails like gh with no sign-in for the remote's host
//   oldghes  - like branch, but the server rejects newer fields (older GitHub Enterprise)
//   odd      - `gh pr view` fails with an unexpected error
// FAKE_GH_HEAD: the PR's head commit. FAKE_GH_URL: the PR's url. FAKE_GH_UPSTREAM: the upstream branch name.
// FAKE_GH_LOG: file that gets one line per call.
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE || 'branch';
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\n');
const json = args[args.indexOf('--json') + 1] || '';
const url = process.env.FAKE_GH_URL || 'https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer/pull/1520';
const pr = {
  number: Number(url.split('/').pop()),
  title: 'Make CI green for #1494',
  url,
  state: 'OPEN',
  isDraft: false,
  headRefName: process.env.FAKE_GH_UPSTREAM || 'claude/fix-ci-1494',
  headRefOid: process.env.FAKE_GH_HEAD || '0'.repeat(40),
  baseRefName: 'main',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    { name: 'build', conclusion: 'SUCCESS', detailsUrl: url + '/checks' },
    { name: 'unit tests', conclusion: 'SUCCESS' },
    { name: 'e2e', status: 'IN_PROGRESS' },
  ],
  additions: 42,
  deletions: 7,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  autoMergeRequest: null,
};
const out = (o) => {
  const keep = (x) => Object.fromEntries(json.split(',').map((k) => [k, x[k]]));
  process.stdout.write(JSON.stringify(Array.isArray(o) ? o.map(keep) : keep(o)) + '\n');
  process.exit(0);
};
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};

if (mode === 'auth') fail('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
if (mode === 'oldghes' && /autoMergeRequest|mergeStateStatus/.test(json)) fail("GraphQL: Field 'autoMergeRequest' doesn't exist on type 'PullRequest' (repository.pullRequest.autoMergeRequest)");
const [cmd, sub, target] = args;
if (cmd !== 'pr') fail('unknown command');
if (sub === 'view') {
  const t = target && !target.startsWith('--') ? target : null;
  if (!t) {
    if (mode === 'branch' || mode === 'oldghes') out(pr);
    if (mode === 'odd') fail('HTTP 502: Bad Gateway (https://github-chf01.example.com/api/graphql)');
    fail('no pull requests found for branch "claude/pr-1494-ci-green-mwt7cqhw"');
  }
  if (mode === 'upstream' && t === pr.headRefName) out(pr);
  if (mode === 'chat' && t === url) out(pr);
  fail(`no pull requests found for branch "${t}"`);
}
if (sub === 'list') {
  const q = args[args.indexOf('--search') + 1];
  out(mode === 'commit' && q === pr.headRefOid ? [pr] : []);
}
fail('unknown command');
