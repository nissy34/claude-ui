// The pull request for a chat's branch, with its CI checks (Desktop's PR status in Changes).
// Needs the gh CLI, signed in, on the server.
import { execFile } from 'node:child_process';

const GH = process.env.CW_GH_BIN || 'gh';
const FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName,autoMergeRequest';

function gh(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { cwd, timeout: 20_000, maxBuffer: 5 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code }));
      resolve(stdout);
    });
  });
}

function check(c) {
  // CheckRun has status/conclusion; StatusContext has state.
  const raw = (c.conclusion || c.state || c.status || '').toUpperCase();
  const state = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw) ? 'pass' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(raw) ? 'fail' : 'pending';
  return { name: c.name || c.context || 'check', state, url: c.detailsUrl || c.targetUrl || null };
}

export async function prStatus(cwd) {
  let out;
  try {
    out = await gh(cwd, ['pr', 'view', '--json', FIELDS]);
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: 'Install the GitHub CLI (gh) on the server and sign in to see pull requests here.' };
    if (/no pull requests? found|could not determine|not a git repository|no git remotes/i.test(e.message)) return { available: true, pr: null };
    if (/auth login|not logged/i.test(e.message)) return { available: false, reason: 'Sign in to the GitHub CLI on the server (gh auth login) to see pull requests here.' };
    return { available: true, pr: null, error: e.message.split('\n')[0] };
  }
  const j = JSON.parse(out);
  const checks = (j.statusCheckRollup || []).map(check);
  return {
    available: true,
    pr: {
      number: j.number,
      title: j.title,
      url: j.url,
      state: j.isDraft && j.state === 'OPEN' ? 'DRAFT' : j.state,
      mergeable: j.mergeable,
      mergeState: j.mergeStateStatus,
      review: j.reviewDecision,
      head: j.headRefName,
      base: j.baseRefName,
      autoMerge: !!j.autoMergeRequest,
      checks,
      summary: { pass: checks.filter((c) => c.state === 'pass').length, fail: checks.filter((c) => c.state === 'fail').length, pending: checks.filter((c) => c.state === 'pending').length },
    },
  };
}

/** GitHub auto-merge (squash), like Desktop's "Merge when ready". */
export async function mergeWhenReady(cwd, number) {
  await gh(cwd, ['pr', 'merge', String(number), '--auto', '--squash']);
  return prStatus(cwd);
}
