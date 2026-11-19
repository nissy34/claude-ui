// Sets up the folders a new chat works in: switches pinned branches and creates git worktrees,
// so chats in the same repo don't edit each other's files. Also tidies worktrees up afterwards.
import fs from 'node:fs';
import { isGitRepo, createWorktree, checkoutBranch, removeWorktree, listBranches } from './git.js';

/**
 * folders: [{ path, branch?, worktree? }], the first is where Claude works.
 * Returns { cwd, project, worktree (first folder's, or null), worktrees: [...], addDirs: [...] }.
 * If any step fails, worktrees made so far are removed again.
 */
export async function prepareWorkspace(folders, name) {
  const made = [];
  const dirs = [];
  try {
    for (const f of folders) {
      if (!fs.existsSync(f.path)) {
        dirs.push(f.path);
        continue;
      }
      const git = (f.worktree || f.branch) && (await isGitRepo(f.path));
      if (f.worktree && git) {
        const wt = await createWorktree(f.path, name, { base: f.branch || undefined });
        made.push(wt);
        dirs.push(wt.path);
      } else {
        if (f.branch && git) {
          const { current } = await listBranches(f.path);
          if (current !== f.branch) await checkoutBranch(f.path, f.branch);
        }
        dirs.push(f.path);
      }
    }
  } catch (e) {
    for (const wt of made) await removeWorktree(wt).catch(() => {});
    throw e;
  }
  const mainWt = folders[0]?.worktree ? made.find((w) => w.path === dirs[0]) || null : null;
  return { cwd: dirs[0], project: folders[0]?.path, worktree: mainWt, worktrees: made, addDirs: dirs.slice(1) };
}

/** Worktrees a chat owns (older chats only have meta.worktree). */
export function worktreesOf(meta) {
  const list = Array.isArray(meta?.worktrees) ? meta.worktrees : [];
  return meta?.worktree && !list.some((w) => w.path === meta.worktree.path) ? [meta.worktree, ...list] : list;
}

/**
 * After a chat is deleted: removes each of its worktrees that no other chat uses and that has no
 * uncommitted changes. Returns what happened to each, for the UI to report.
 */
export async function cleanupWorktrees(meta, others) {
  const inUse = new Set();
  for (const m of others) for (const w of worktreesOf(m)) inUse.add(w.path);
  const out = [];
  for (const wt of worktreesOf(meta)) {
    if (inUse.has(wt.path)) {
      out.push({ path: wt.path, branch: wt.branch, kept: 'another chat uses it' });
      continue;
    }
    try {
      const r = await removeWorktree(wt);
      out.push({ path: wt.path, branch: wt.branch, ...r });
    } catch (e) {
      out.push({ path: wt.path, branch: wt.branch, removed: false, kept: e.message.split('\n')[0] });
    }
  }
  return out;
}
