import { api } from '../api.js';
import { confirmDialog, noticeDialog } from '../ui/dialogs.jsx';

const worktreesOf = (s) => {
  const list = Array.isArray(s.worktrees) ? s.worktrees : [];
  return s.worktree && !list.some((w) => w.path === s.worktree.path) ? [s.worktree, ...list] : list;
};

/**
 * Asks, deletes a chat, and says which of its worktrees were kept (uncommitted changes, or
 * another chat uses them). Resolves true when deleted.
 */
export async function deleteChat(s, { name } = {}) {
  const wts = worktreesOf(s);
  const what = name ? `Delete "${name}"?` : 'Delete this chat?';
  const wtNote = wts.length
    ? ` Its worktree${wts.length > 1 ? 's are' : ' is'} removed too, unless ${wts.length > 1 ? 'they have' : 'it has'} uncommitted changes. ${wts.length > 1 ? 'Branches' : `The branch ${wts[0].branch}`} with commits ${wts.length > 1 ? 'are' : 'is'} kept.`
    : '';
  if (!(await confirmDialog(`${what} Claude keeps its own transcript, so you can resume it later from Past conversations.${wtNote}`, { ok: 'Delete', danger: true }))) return false;
  const r = await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
  const kept = (r.worktrees || []).filter((w) => !w.removed);
  const branches = (r.worktrees || []).filter((w) => w.removed && !w.branchDeleted && w.branch);
  const lines = [
    ...kept.map((w) => `Kept the worktree ${w.path} (branch ${w.branch}) because ${w.kept}.`),
    ...branches.map((w) => `Removed the worktree; its branch ${w.branch} has commits, so it was kept.`),
  ];
  if (lines.length) noticeDialog(lines.join('\n'), { title: 'Worktree' });
  return true;
}
