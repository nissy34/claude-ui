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

/** Working-tree changes against HEAD, including untracked files. */
export async function getChanges(cwd) {
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
  const diffText = hasHead ? await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M']) : await git(cwd, ['diff', '--cached', '--no-color']);
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
  return { git: true, branch, files };
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

export async function createWorktree(cwd, name) {
  if (!(await isGitRepo(cwd))) throw new Error('Worktrees need a git repository');
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const slug = (name || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'chat';
  const id = `${slug}-${Date.now().toString(36)}`;
  const dir = path.join(top, '.claude', 'worktrees', id);
  const branch = `claude/${id}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir]);
  // Keep worktrees out of the main checkout's status.
  try {
    const exclude = path.join(top, '.git', 'info', 'exclude');
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.claude/worktrees/')) fs.appendFileSync(exclude, '\n.claude/worktrees/\n');
  } catch {}
  return { path: fs.realpathSync(dir), branch };
}
