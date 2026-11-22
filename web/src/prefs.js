// Per-browser preferences (appearance, notifications, defaults for new chats).
const KEY = 'cw.prefs';
const DEFAULTS = { fontSize: 'medium', notifications: true, sendOnEnter: true, suggestions: true, newModel: '', newMode: 'auto', newEffort: '' };
const listeners = new Set();

export function getPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // New chats start in Auto mode now. Older saves stored every default, so drop their old 'default' mode once.
    if (!saved.v) {
      if (saved.newMode === 'default') delete saved.newMode;
      saved.v = 2;
    }
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPref(k, v) {
  const next = { ...getPrefs(), [k]: v };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  applyPrefs(next);
  listeners.forEach((fn) => fn(next));
  return next;
}

export function onPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SIZES = { small: 0.92, medium: 1, large: 1.1, xlarge: 1.22 };
export function applyPrefs(p = getPrefs()) {
  document.documentElement.style.setProperty('--chat-scale', SIZES[p.fontSize] || 1);
}

// Defaults applied to a new chat unless the caller already set them.
export function newChatDefaults(opts) {
  if (opts.kind && opts.kind !== 'chat') return opts;
  const p = getPrefs();
  return {
    ...opts,
    model: opts.model ?? (p.newModel || undefined),
    permissionMode: opts.permissionMode ?? p.newMode,
    effort: opts.effort ?? (p.newEffort || undefined),
  };
}

applyPrefs();
