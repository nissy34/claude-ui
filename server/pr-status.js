// The pull request for a chat's branch, with its CI checks (Desktop's PR status in Changes).
// Needs the gh CLI, signed in, on the server. Works for github.com and GitHub Enterprise alike:
// gh picks the host from the folder's git remotes.
import { execFile } from 'node:child_process';

const GH = process.env.CW_GH_BIN || 'gh';
const BASIC = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,additions,deletions';
const FIELDS = BASIC + ',mergeable,mergeStateStatus,autoMergeRequest';
// Older GitHub Enterprise servers lack some fields: ask again with the basic ones.
const FIELD_ERROR = /unknown json field|doesn't exist on type|cannot query field/i;

/** `extra` is the chat environment's variables (e.g. GH_HOST, GH_ENTERPRISE_TOKEN), so gh signs in as it does in the chat. */
function gh(cwd, args, extra = {}) {
  const env = { ...process.env, ...extra, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  return new Promise((resolve, reject) => {
    execFile(GH, args, { cwd, env, timeout: 20_000, maxBuffer: 5 << 20, windowsHide: true }, (err, stdout, stderr) => {
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

export async function prStatus(cwd, { env } = {}) {
  let out;
  try {
    out = await gh(cwd, ['pr', 'view', '--json', FIELDS], env).catch((e) => {
      if (FIELD_ERROR.test(e.message)) return gh(cwd, ['pr', 'view', '--json', BASIC], env);
      throw e;
    });
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: 'Install the GitHub CLI (gh) on the server and sign in to see pull requests here.' };
    if (/no pull requests? found|could not determine|not a git repository|no git remotes/i.test(e.message)) return { available: true, pr: null };
    if (/auth login|not logged/i.test(e.message)) return { available: false, reason: `Sign in to the GitHub CLI on the server to see pull requests here (gh auth login${await enterpriseHost(cwd)}).` };
    // Anything else is shown on the card rather than hidden.
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
      mergeable: j.mergeable ?? null,
      mergeState: j.mergeStateStatus ?? null,
      review: j.reviewDecision,
      head: j.headRefName,
      base: j.baseRefName,
      autoMerge: !!j.autoMergeRequest,
      additions: j.additions ?? null,
      deletions: j.deletions ?? null,
      checks,
      summary: { pass: checks.filter((c) => c.state === 'pass').length, fail: checks.filter((c) => c.state === 'fail').length, pending: checks.filter((c) => c.state === 'pending').length },
    },
  };
}

/** " --hostname <host>" when origin is not on github.com, for the sign-in hint. */
async function enterpriseHost(cwd) {
  const url = await new Promise((r) => execFile('git', ['remote', 'get-url', 'origin'], { cwd, windowsHide: true }, (err, out) => r(err ? '' : out.trim())));
  const host = (url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i) || url.match(/^[^@/]+@([^:/]+):/) || [])[1];
  return host && host !== 'github.com' ? ` --hostname ${host}` : '';
}

/** GitHub auto-merge (squash), like Desktop's "Merge when ready". */
export async function mergeWhenReady(cwd, number, opts = {}) {
  await gh(cwd, ['pr', 'merge', String(number), '--auto', '--squash'], opts.env);
  return prStatus(cwd, opts);
}
