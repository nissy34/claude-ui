// The pull request for a chat's branch, with its CI checks (Desktop's PR status in Changes).
// Needs the gh CLI, signed in, on the server. Works for github.com and GitHub Enterprise hosts alike:
// gh picks the host from the folder's git remotes.
//
// How the PR is found, in order:
//  1. `gh pr view` for the checked-out branch (gh follows the branch's upstream).
//  2. The branch the local branch tracks, by name (worktree branches are often pushed under another name).
//  3. A PR whose head commit is this folder's HEAD (`gh pr list --search <sha>`), once that commit is pushed.
//  4. PR links the chat itself printed (e.g. `gh pr create` output), for this repository, whose head
//     commit is in this folder's history. If gh can't be used at all, the last such link is still shown.
import { execFile } from 'node:child_process';

const GH = process.env.CW_GH_BIN || 'gh';
const BASIC = 'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,statusCheckRollup,additions,deletions';
const FIELDS = BASIC + ',mergeable,mergeStateStatus,autoMergeRequest';

function run(file, cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env, timeout: 20_000, maxBuffer: 5 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code }));
      resolve(stdout);
    });
  });
}

const git = (cwd, args) => run('git', cwd, args, process.env).then((s) => s.trim());

function check(c) {
  // CheckRun has status/conclusion; StatusContext has state.
  const raw = (c.conclusion || c.state || c.status || '').toUpperCase();
  const state = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw) ? 'pass' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(raw) ? 'fail' : 'pending';
  return { name: c.name || c.context || 'check', state, url: c.detailsUrl || c.targetUrl || null };
}

function shape(j, via) {
  const checks = (j.statusCheckRollup || []).map(check);
  return {
    number: j.number,
    title: j.title,
    url: j.url,
    state: j.isDraft && j.state === 'OPEN' ? 'DRAFT' : j.state,
    mergeable: j.mergeable ?? null,
    mergeState: j.mergeStateStatus ?? null,
    review: j.reviewDecision || null,
    head: j.headRefName,
    base: j.baseRefName,
    autoMerge: !!j.autoMergeRequest,
    additions: j.additions ?? null,
    deletions: j.deletions ?? null,
    checks,
    summary: { pass: checks.filter((c) => c.state === 'pass').length, fail: checks.filter((c) => c.state === 'fail').length, pending: checks.filter((c) => c.state === 'pending').length },
    ...(via ? { via } : {}),
  };
}

const NOT_FOUND = /no pull requests? found|could not determine|not a git repository|no git remotes|no open pull requests/i;
const AUTH = /auth login|not logged|authentication token|bad credentials|HTTP 401/i;
// Older GitHub Enterprise servers lack some fields: ask again with the basic ones.
const FIELD = /unknown json field|doesn't exist on type|field '\w+' doesn't exist|cannot query field/i;

/** `{ host, repo }` of every git remote ("owner/name", lower case), for matching PR links. */
export async function remotes(cwd) {
  let out = '';
  try {
    out = await git(cwd, ['remote', '-v']);
  } catch {
    return [];
  }
  const seen = new Map();
  for (const line of out.split('\n')) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    // https://host/owner/repo(.git), ssh://git@host[:port]/owner/repo, git@host:owner/repo
    const m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i) || url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/);
    if (!m) continue;
    const r = { host: m[1].toLowerCase(), repo: m[2].toLowerCase().replace(/^\/+/, '') };
    seen.set(`${r.host}/${r.repo}`, r);
  }
  return [...seen.values()];
}

const PR_URL = /https?:\/\/([a-z0-9.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;

/** PR links in some text that point at one of `rems`, newest last. */
export function prLinks(texts, rems) {
  const want = new Set(rems.map((r) => `${r.host}/${r.repo}`));
  const out = [];
  for (const t of texts) {
    if (typeof t !== 'string' || !t.includes('/pull/')) continue;
    for (const m of t.matchAll(PR_URL)) {
      const key = `${m[1].toLowerCase().replace(/:\d+$/, '')}/${m[2].toLowerCase()}/${m[3].toLowerCase()}`;
      if (!want.size || want.has(key)) out.push({ url: m[0], number: Number(m[4]) });
    }
  }
  // Newest mention wins; keep each PR once.
  const seen = new Set();
  return out.reverse().filter((l) => !seen.has(l.url) && seen.add(l.url));
}

/** Text a chat showed (Claude's replies and tool output), for prLinks. */
export function chatTexts(events = []) {
  const out = [];
  for (const e of events.slice(-2000)) {
    if (e.k === 'block' && e.block?.type === 'text') out.push(e.block.text);
    else if (e.k === 'tool_result' && !e.isError) out.push(e.text);
  }
  return out;
}

async function inHistory(cwd, oid, head) {
  if (!oid) return false;
  if (oid === head) return true;
  try {
    await git(cwd, ['merge-base', '--is-ancestor', oid, head]);
    return true;
  } catch {}
  try {
    await git(cwd, ['merge-base', '--is-ancestor', head, oid]);
    return true;
  } catch {}
  return false;
}

/**
 * The PR for the chat's folder.
 * `env` is the chat's extra environment (its environment's variables, e.g. GH_HOST or GH_ENTERPRISE_TOKEN),
 * so gh signs in the same way it does inside the chat. `texts` is what the chat showed, for PR links.
 */
export async function prStatus(cwd, { env: extra = {}, texts = [] } = {}) {
  const env = { ...process.env, ...extra, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  let fields = FIELDS;
  const gh = async (args) => {
    try {
      return JSON.parse(await run(GH, cwd, [...args, '--json', fields], env));
    } catch (e) {
      if (fields !== BASIC && FIELD.test(e.message)) {
        fields = BASIC;
        return JSON.parse(await run(GH, cwd, [...args, '--json', fields], env));
      }
      throw e;
    }
  };
  const rems = await remotes(cwd);
  const links = prLinks(texts, rems);
  const hostNote = (msg) => {
    const host = rems.find((r) => r.host !== 'github.com')?.host;
    return host ? `${msg} For ${host}: gh auth login --hostname ${host}` : msg;
  };
  const fallback = (reason) =>
    links.length
      ? { available: true, pr: { number: links[0].number, url: links[0].url, title: null, state: null, checks: [], summary: { pass: 0, fail: 0, pending: 0 }, linkOnly: true, via: 'chat' }, note: reason }
      : { available: false, reason };

  // 1. The checked-out branch.
  try {
    return { available: true, pr: shape(await gh(['pr', 'view'])) };
  } catch (e) {
    if (e.code === 'ENOENT') return fallback('Install the GitHub CLI (gh) on the server and sign in to see pull requests here.');
    if (/none of the git remotes|known github host/i.test(e.message)) return fallback(hostNote("The GitHub CLI on the server isn't signed in to this repository's host."));
    if (AUTH.test(e.message)) return fallback(hostNote('Sign in to the GitHub CLI on the server (gh auth login) to see pull requests here.'));
    if (!NOT_FOUND.test(e.message)) {
      const err = e.message.split('\n')[0];
      const fb = fallback(err);
      return fb.available ? fb : { available: true, pr: null, error: err };
    }
  }

  let branch = '';
  let head = '';
  try {
    branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    head = await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return { available: true, pr: null };
  }

  // 2. The branch it tracks, when pushed under another name.
  try {
    const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const name = up.replace(/^[^/]+\//, '');
    if (name && name !== branch) return { available: true, pr: shape(await gh(['pr', 'view', name]), 'upstream') };
  } catch {}

  // 3. A PR whose head is this commit. Only when the commit was pushed and isn't on the default branch,
  // so chats with nothing pushed don't cost a search.
  try {
    const refs = (await git(cwd, ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/remotes'])).split('\n').filter(Boolean);
    const defaults = new Set();
    for (const r of rems.length ? await git(cwd, ['remote']).then((s) => s.split('\n')) : []) {
      try {
        defaults.add(await git(cwd, ['symbolic-ref', `refs/remotes/${r}/HEAD`]));
      } catch {}
    }
    if (!refs.length || refs.some((r) => defaults.has(r) || /\/(main|master)$/.test(r))) throw new Error('skip');

    const list = await gh(['pr', 'list', '--state', 'all', '--limit', '10', '--search', head]);
    const hit = list.find((p) => p.headRefOid === head && p.baseRefName !== branch);
    if (hit) return { available: true, pr: shape(hit, 'commit') };
  } catch {}

  // 4. A PR the chat linked to, if its head is in this folder's history.
  for (const l of links.slice(0, 3)) {
    try {
      const j = await gh(['pr', 'view', l.url]);
      if (await inHistory(cwd, j.headRefOid, head)) return { available: true, pr: shape(j, 'chat') };
    } catch {}
  }
  return { available: true, pr: null };
}

/** GitHub auto-merge (squash), like Desktop's "Merge when ready". */
export async function mergeWhenReady(cwd, number, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}), GH_PROMPT_DISABLED: '1' };
  await run(GH, cwd, ['pr', 'merge', String(number), '--auto', '--squash'], env);
  return prStatus(cwd, opts);
}
