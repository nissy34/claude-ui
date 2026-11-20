// Git and file helpers: changes panel, @-mention file search, file preview, worktrees.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function git(cwd, args, { maxBuffer = 20 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

export async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

function splitDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const header = chunk.split('\n', 1)[0];
    const m = header.match(/^a\/(.+?) b\/(.+)$/);
    const p = m ? m[2] : header;
    let add = 0;
    let del = 0;
    for (const l of chunk.split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) add++;
      else if (l.startsWith('-') && !l.startsWith('---')) del++;
    }
    files.push({ path: p, diff: 'diff --git ' + chunk, add, del });
  }
  return files;
}

/** The branches a diff can be measured against: the remote's default branch first, then local ones. */
async function baseCandidates(cwd, current) {
  const out = [];
  try {
    const head = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (head) out.push(head);
  } catch {}
  try {
    const local = (await git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', '--count=25'])).split('\n').filter(Boolean);
    for (const b of local) if (b !== current && !out.includes(b)) out.push(b);
  } catch {}
  return out;
}

const SAFE_REF = /^(?!-)[\w./@{}~^-]{1,200}$/;

/** Changes in the working tree, including untracked files: against HEAD (uncommitted only), or
 *  with `base`, everything since this branch left that branch (commits plus uncommitted work).
 *  `ignoreWs` drops whitespace-only changes. */
export async function getChanges(cwd, { base, ignoreWs } = {}) {
  if (!(await isGitRepo(cwd))) return { git: false, files: [] };
  let branch = '';
  try {
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {}
  let hasHead = true;
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }
  const bases = hasHead ? await baseCandidates(cwd, branch) : [];
  let from = 'HEAD';
  let baseUsed = null;
  if (base && base !== 'HEAD' && hasHead) {
    if (!SAFE_REF.test(base)) throw new Error('Bad branch name');
    try {
      from = (await git(cwd, ['merge-base', base, 'HEAD'])).trim();
      baseUsed = base;
    } catch {
      throw new Error(`Can't compare with ${base}: no common history`);
    }
  }
  const ws = ignoreWs ? ['-w'] : [];
  const diffText = hasHead ? await git(cwd, ['diff', from, '--no-color', '--no-ext-diff', '-M', ...ws]) : await git(cwd, ['diff', '--cached', '--no-color', ...ws]);
  const files = splitDiff(diffText).map((f) => ({ ...f, status: 'modified' }));
  for (const f of files) if (/^new file mode/m.test(f.diff)) f.status = 'added';
  for (const f of files) if (/^deleted file mode/m.test(f.diff)) f.status = 'deleted';

  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  for (const rel of untracked.slice(0, 100)) {
    const full = path.join(cwd, rel);
    let body = '';
    try {
      const st = fs.statSync(full);
      body = st.size > 200_000 ? '(file too large to show)' : fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (body.includes('\u0000')) body = '(binary file)';
    const lines = body.replace(/\n$/, '').split('\n');
    files.push({
      path: rel,
      status: 'added',
      add: lines.length,
      del: 0,
      diff: `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n'),
    });
  }
  if (ignoreWs) for (let i = files.length - 1; i >= 0; i--) if (files[i].status !== 'added' && !/^@@/m.test(files[i].diff)) files.splice(i, 1);
  return { git: true, branch, base: baseUsed, bases, files };
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache']);

async function listFiles(cwd) {
  if (await isGitRepo(cwd)) {
    try {
      const out = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']);
      return out.split('\n').filter(Boolean);
    } catch {}
  }
  const out = [];
  const walk = (dir, rel) => {
    if (out.length > 20000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(cwd, '');
  return out;
}

const fileCache = new Map(); // cwd -> {at, files}

export async function searchFiles(cwd, q) {
  let entry = fileCache.get(cwd);
  if (!entry || Date.now() - entry.at > 15_000) {
    entry = { at: Date.now(), files: await listFiles(cwd) };
    fileCache.set(cwd, entry);
  }
  q = (q || '').toLowerCase();
  if (!q) return entry.files.slice(0, 30);
  const scored = [];
  for (const f of entry.files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else {
      // subsequence match
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i === q.length) score = 3;
    }
    if (score >= 0) scored.push([score, f.length, f]);
    if (scored.length > 2000) break;
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, 30).map((s) => s[2]);
}

export function readFileSafe(root, rel) {
  const full = path.resolve(root, rel);
  const real = fs.realpathSync(full);
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('Path is outside the session folder');
  const st = fs.statSync(real);
  if (st.isDirectory()) throw new Error('That is a folder');
  if (st.size > 1_000_000) return { path: rel, tooLarge: true, size: st.size };
  const buf = fs.readFileSync(real);
  if (buf.includes(0)) return { path: rel, binary: true, size: st.size };
  return { path: rel, content: buf.toString('utf8'), size: st.size };
}

async function revParse(cwd, ref) {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).trim();
  } catch {
    return '';
  }
}

/** Local branches (most recently committed first) plus the checked-out one, for the branch pickers. */
export async function listBranches(cwd) {
  if (!(await isGitRepo(cwd))) return { git: false, current: '', branches: [] };
  let current = '';
  try {
    current = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
  } catch {}
  const fmt = (refs) => git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', ...refs]).then((o) => o.split('\n').map((x) => x.trim()).filter(Boolean), () => []);
  const branches = await fmt(['refs/heads']);
  const heads = new Set(branches);
  // Branches that exist only on a remote, by their short name (origin/feature -> feature).
  for (const r of await fmt(['refs/remotes'])) {
    if (r.endsWith('/HEAD') || !r.includes('/')) continue;
    const short = r.replace(/^[^/]+\//, '');
    if (!heads.has(short)) (heads.add(short), branches.push(short));
  }
  return { git: true, current, branches: branches.slice(0, 200) };
}

const slugify = (name) => (name || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-+|-+$/g, '') || 'chat';

/**
 * A fresh worktree on a new branch claude/<slug>-<id>, under <repo>/.claude/worktrees/.
 * base: branch to start from (a local branch, or one only on a remote); default is the checked-out commit.
 * Returns { path, branch, repo, base (commit it started at), from (base branch name) }.
 */
export async function createWorktree(cwd, name, { base, at } = {}) {
  if (!(await isGitRepo(cwd))) throw new Error('Worktrees need a git repository');
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const id = `${slugify(name)}-${Date.now().toString(36)}`;
  const dir = at && !fs.existsSync(at) ? at : path.join(top, '.claude', 'worktrees', id); // at: reuse a removed worktree's folder
  const branch = `claude/${id}`;
  let start = 'HEAD';
  if (base) {
    if (base.startsWith('-')) throw new Error('Bad branch name');
    if (await revParse(top, `refs/heads/${base}`)) start = base;
    else {
      const remoteRef = (await git(top, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/*/${base}`]).catch(() => '')).split('\n').filter(Boolean)[0];
      if (!remoteRef) throw new Error(`No branch called ${base} in ${path.basename(top)}`);
      start = remoteRef;
    }
  }
  const baseSha = await revParse(top, `${start}^{commit}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['worktree', 'add', '-b', branch, dir];
  if (baseSha) args.push(start);
  await git(top, args);
  // Keep worktrees out of the main checkout's status.
  try {
    const common = path.resolve(top, (await git(top, ['rev-parse', '--git-common-dir'])).trim());
    const exclude = path.join(common, 'info', 'exclude');
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.claude/worktrees/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, '\n.claude/worktrees/\n');
    }
  } catch {}
  return { path: fs.realpathSync(dir), branch, repo: top, base: baseSha, from: base || (await git(top, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || undefined };
}

/** Switches a normal checkout to another branch (fetching it from the remote if it is only there). */
export async function checkoutBranch(cwd, branch) {
  if (!branch || branch.startsWith('-')) throw new Error('Bad branch name');
  const cur = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (cur === branch) return;
  try {
    await git(cwd, ['checkout', branch, '--']);
  } catch (e) {
    throw new Error(`Couldn't switch ${path.basename(cwd)} to ${branch}: ${e.message.split('\n').slice(0, 3).join(' ')}`);
  }
}

/** True when removing the worktree loses no commits: it has none of its own, or they are all in its repo's checked-out branch. */
export async function worktreeMerged(wt) {
  if (!wt?.path || !fs.existsSync(wt.path)) return false;
  const repo = wt.repo || (await git(wt.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim().replace(/[\\/]\.git$/, '');
  if (!repo) return false;
  const head = await revParse(wt.path, 'HEAD').catch(() => null);
  if (!head) return false;
  if (head === wt.base) return true; // no commits of its own
  return git(repo, ['merge-base', '--is-ancestor', head, 'HEAD']).then(() => true, () => false);
}

/** Files a worktree changed against the commit it started from: committed, staged, unstaged and new. */
export async function changedFiles(wt, max = 200) {
  if (!wt?.path || !fs.existsSync(wt.path)) return [];
  const out = new Set();
  const add = (txt) => txt.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => out.size < max && out.add(l));
  if (wt.base) add(await git(wt.path, ['diff', '--name-only', wt.base]).catch(() => ''));
  else add(await git(wt.path, ['diff', '--name-only', 'HEAD']).catch(() => ''));
  add(await git(wt.path, ['ls-files', '--others', '--exclude-standard']).catch(() => ''));
  return [...out].sort();
}

/**
 * Removes a chat's worktree when it is safe: never with uncommitted changes. Its branch goes too
 * when it has no commits of its own; a branch with work on it is kept.
 * Returns { removed, kept?: reason, branchDeleted }.
 */
export async function removeWorktree(wt) {
  if (!wt?.path) return { removed: false };
  if (!fs.existsSync(wt.path)) {
    if (wt.repo && fs.existsSync(wt.repo)) await git(wt.repo, ['worktree', 'prune']).catch(() => {});
    return { removed: true, branchDeleted: false };
  }
  const status = await git(wt.path, ['status', '--porcelain']).catch(() => null);
  if (status === null) return { removed: false, kept: 'not a git worktree any more' };
  if (status.trim()) return { removed: false, kept: 'it has uncommitted changes' };
  const repo = wt.repo || (await git(wt.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim().replace(/[\\/]\.git$/, '');
  const head = await revParse(wt.path, 'HEAD');
  await git(repo, ['worktree', 'remove', wt.path]);
  let branchDeleted = false;
  if (wt.branch && wt.base && head === wt.base) {
    await git(repo, ['branch', '-D', wt.branch]).then(() => (branchDeleted = true)).catch(() => {});
  }
  return { removed: true, branchDeleted };
}
