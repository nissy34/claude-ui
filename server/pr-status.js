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

/** `gh pr view [target]` as JSON, asking again with the basic fields if the server rejects newer ones. */
async function view(cwd, target, env) {
  const args = ['pr', 'view', ...(target ? [target] : []), '--json'];
  const out = await gh(cwd, [...args, FIELDS], env).catch((e) => {
    if (FIELD_ERROR.test(e.message)) return gh(cwd, [...args, BASIC], env);
    throw e;
  });
  return JSON.parse(out);
}

function shape(j) {
  const checks = (j.statusCheckRollup || []).map(check);
  return {
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
  };
}

/**
 * The PR for the chat's branch. With `texts` (what the chat showed), also `linked`: this repository's
 * PRs the chat linked to, newest first, for chats that work on other branches (e.g. push to a PR's branch).
 * `env` is the chat environment's variables.
 */
export async function prStatus(cwd, { env, texts, maxLinked = MAX_LINKED } = {}) {
  let pr = null;
  try {
    pr = shape(await view(cwd, null, env));
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: 'Install the GitHub CLI (gh) on the server and sign in to see pull requests here.' };
    if (/auth login|not logged/i.test(e.message)) return { available: false, reason: `Sign in to the GitHub CLI on the server to see pull requests here (gh auth login${hostFlag(await originHost(cwd))}).` };
    // Anything else but "no PR for this branch" is shown on the card rather than hidden.
    if (!/no pull requests? found|could not determine|not a git repository|no git remotes/i.test(e.message)) return { available: true, pr: null, error: e.message.split('\n')[0], linked: [] };
  }
  const linked = texts ? await linkedPrs(cwd, texts, env, pr, maxLinked) : undefined;
  return { available: true, pr, ...(linked ? { linked } : {}) };
}

const PR_URL = /https?:\/\/([\w.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
const MAX_LINKED = 3;

/** PR links in `texts` that point at one of this folder's remotes, newest first, each once. */
export function prLinks(texts, repos) {
  const out = [];
  for (const t of texts) {
    if (typeof t !== 'string' || !t.includes('/pull/')) continue;
    for (const m of t.matchAll(PR_URL)) {
      if (repos.has(`${m[1]}/${m[2]}/${m[3]}`.toLowerCase())) out.push(`https://${m[1]}/${m[2]}/${m[3]}/pull/${m[4]}`);
    }
  }
  const seen = new Map();
  for (const u of out.reverse()) if (!seen.has(u.toLowerCase())) seen.set(u.toLowerCase(), u);
  return [...seen.values()];
}

async function linkedPrs(cwd, texts, env, branchPr, max = MAX_LINKED) {
  const repos = new Set((await remoteUrls(cwd)).map(repoKey).filter(Boolean));
  const urls = prLinks(texts, repos)
    .filter((u) => !branchPr || u.toLowerCase() !== String(branchPr.url).toLowerCase())
    .slice(0, max);
  const prs = await Promise.all(urls.map((u) => view(cwd, u, env).then(shape, () => null)));
  return prs.filter(Boolean);
}

/** Text a chat showed (Claude's replies and tool output), newest last, for prLinks. */
export function chatTexts(events = []) {
  const out = [];
  for (const e of events.slice(-3000)) {
    if (e.k === 'block' && e.block?.type === 'text') out.push(e.block.text);
    else if (e.k === 'tool_result' && !e.isError) out.push(e.text);
    // What Claude sent through tools, e.g. a thread's post or a PR it opened with an MCP tool.
    else if (e.k === 'block' && e.block?.type === 'tool_use' && e.block.input) out.push(JSON.stringify(e.block.input));
  }
  return out;
}

const git = (cwd, args) => new Promise((r) => execFile('git', args, { cwd, windowsHide: true }, (err, out) => r(err ? '' : out.trim())));

async function remoteUrls(cwd) {
  const names = (await git(cwd, ['remote'])).split('\n').filter(Boolean);
  return Promise.all(names.map((n) => git(cwd, ['remote', 'get-url', n])));
}

/** "host/owner/repo" (lower case) of a git remote URL: https, ssh:// or scp-style. */
export function repoKey(url) {
  const m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i) || url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2].replace(/^\/+/, '')}`.toLowerCase() : null;
}

const originHost = async (cwd) => (repoKey(await git(cwd, ['remote', 'get-url', 'origin'])) || '').split('/')[0];
const hostFlag = (host) => (host && host !== 'github.com' ? ` --hostname ${host}` : '');

/** GitHub auto-merge (squash), like Desktop's "Merge when ready". */
export async function mergeWhenReady(cwd, number, opts = {}) {
  await gh(cwd, ['pr', 'merge', String(number), '--auto', '--squash'], opts.env);
  return prStatus(cwd, opts);
}
