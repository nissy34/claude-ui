// Keeps a small copy of each chat's pull request in its meta (meta.pr), so the sidebar can show
// PR state icons and a "Done" label without asking gh for every row. Refreshed when a chat's PR
// is opened in the UI, shortly after a turn ends, and by a slow background sweep of recent chats.
import { prStatus } from './pr-status.js';
import { sessionExtras } from './environments.js';

const SWEEP_MS = 3 * 60_000;
const RECENT_MS = 7 * 24 * 3600_000;
const MAX_SWEEP = 30;
let ghMissingUntil = 0;
const inFlight = new Map();

/** The chat environment's variables for gh (GH_HOST, GH_ENTERPRISE_TOKEN, ...), so it signs in as it does in the chat. */
export function prOpts(s) {
  try {
    return { env: sessionExtras(s.meta).env };
  } catch {
    return {};
  }
}

function brief(pr) {
  if (!pr) return null;
  return { number: pr.number, state: pr.state, url: pr.url, title: pr.title, fail: pr.summary?.fail || 0, pending: pr.summary?.pending || 0 };
}

/** Store a prStatus() result on the session; saves only when something the sidebar shows changed. */
export function rememberPr(s, status, store) {
  if (!s || !status?.available || status.error) return;
  const next = brief(status.pr);
  const prev = s.meta.pr || null;
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  if (next) s.meta.pr = next;
  else delete s.meta.pr;
  store.save();
}

export async function refreshPr(s, store) {
  const cwd = s?.meta?.cwd;
  if (!cwd || s.meta.noFolder || s.meta.kind !== 'chat' || Date.now() < ghMissingUntil) return;
  if (inFlight.has(s.meta.id)) return inFlight.get(s.meta.id);
  const p = prStatus(cwd, prOpts(s))
    .then((st) => {
      if (!st.available) ghMissingUntil = Date.now() + 30 * 60_000; // gh missing or signed out: back off
      rememberPr(s, st, store);
    })
    .catch(() => {})
    .finally(() => inFlight.delete(s.meta.id));
  inFlight.set(s.meta.id, p);
  return p;
}

export function startPrSweep(store) {
  const sweep = async () => {
    const now = Date.now();
    const recent = [...store.sessions.values()]
      .filter((s) => s.meta.kind === 'chat' && !s.meta.archived && !s.meta.noFolder && s.meta.cwd && now - (s.meta.lastActivity || 0) < RECENT_MS)
      .sort((a, b) => b.meta.lastActivity - a.meta.lastActivity)
      .slice(0, MAX_SWEEP);
    for (const s of recent) {
      if (Date.now() < ghMissingUntil) break;
      await refreshPr(s, store);
    }
  };
  setTimeout(sweep, 15_000).unref?.();
  setInterval(sweep, SWEEP_MS).unref?.();
}
