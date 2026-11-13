// Per-browser preferences (appearance, notifications, defaults for new chats).
const KEY = 'cw.prefs';
const DEFAULTS = { fontSize: 'medium', notifications: true, sendOnEnter: true, newModel: '', newMode: 'default', newEffort: '' };
const listeners = new Set();

export function getPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
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
    permissionMode: opts.permissionMode ?? (p.newMode !== 'default' ? p.newMode : undefined),
    effort: opts.effort ?? (p.newEffort || undefined),
  };
}

applyPrefs();
