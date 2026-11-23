#!/usr/bin/env node
// A scripted `gh` for tests (CW_GH_BIN). FAKE_GH_MODE picks how `gh pr view` behaves:
//   branch  - finds the PR (on a GitHub Enterprise host)
//   oldghes - like branch, but rejects newer fields, like older GitHub Enterprise servers
//   none    - no PR for this branch
//   auth    - gh isn't signed in to the remote's host
//   odd     - an unexpected error
// FAKE_GH_ENV_CHECK: if set, `gh` fails unless GH_HOST has this value (checks the chat's env reaches gh).
const args = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE || 'branch';
const json = args[args.indexOf('--json') + 1] || '';
const fail = (msg) => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};
if (process.env.FAKE_GH_ENV_CHECK && process.env.GH_HOST !== process.env.FAKE_GH_ENV_CHECK) fail('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
if (args[0] !== 'pr' || args[1] !== 'view') fail('unknown command');
if (mode === 'auth') fail('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
if (mode === 'none') fail('no pull requests found for branch "claude/pr-1494-ci-green-mwt7cqhw"');
if (mode === 'odd') fail('HTTP 502: Bad Gateway (https://github-chf01.example.com/api/graphql)');
if (mode === 'oldghes' && /autoMergeRequest|mergeStateStatus|mergeable/.test(json)) fail("GraphQL: Field 'autoMergeRequest' doesn't exist on type 'PullRequest'");
const url = 'https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer/pull/1520';
const pr = {
  number: 1520, title: 'Make CI green for #1494', url, state: 'OPEN', isDraft: false,
  headRefName: 'claude/pr-1494-ci-green-mwt7cqhw', baseRefName: 'main', reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS', detailsUrl: url + '/checks' }, { name: 'unit tests', conclusion: 'SUCCESS' }, { name: 'e2e', status: 'IN_PROGRESS' }],
  additions: 42, deletions: 7, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMergeRequest: null,
};
process.stdout.write(JSON.stringify(Object.fromEntries(json.split(',').map((k) => [k, pr[k]]))) + '\n');
