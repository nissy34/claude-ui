import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getPrefs, onPrefs } from '../prefs.js';
import { needsSignIn } from './McpAuth.jsx';
import { findModel, modelLabel, useModels } from '../models.js';
import { withQuote } from './quote.js';
import { QuoteMark } from './QuoteReply.jsx';
import { Button, Menu, useDismiss } from '../ui/index.jsx';
import { promptDialog } from '../ui/dialogs.jsx';
import MentionInput from './MentionInput.jsx';
import { chatToken } from './mentions.jsx';

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export const MODES = [
  { id: 'default', label: 'Ask before edits', short: 'Ask', desc: 'Claude asks before changing files or running commands' },
  { id: 'auto', label: 'Auto mode', short: 'Auto', desc: 'A safety classifier approves or blocks each action, so Claude rarely needs to ask' },
  { id: 'acceptEdits', label: 'Accept edits', short: 'Edits', desc: 'File edits are applied automatically' },
  { id: 'plan', label: 'Plan mode', short: 'Plan', desc: 'Claude explores and proposes a plan before changing anything' },
  { id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', desc: 'Everything runs without asking. Use with care' },
];

const EFFORTS = [
  { id: '', label: 'Default effort' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ media_type: file.type, data: String(r.result).split(',')[1], url: r.result, name: file.name });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const SENDABLE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024; // Claude takes up to 5 MB per image once base64-encoded
const MAX_SIDE = 2000;

const loadBitmap = (blob) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => (URL.revokeObjectURL(url), resolve(img));
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('not a picture this browser can open')));
    img.src = url;
  });

/**
 * A picture ready to send to Claude: PNG, JPEG, GIF or WebP under the size limit. Bigger ones,
 * or other formats the browser can open (BMP, AVIF, HEIC on Safari…), are scaled down and
 * re-encoded. Returns null when it can't be made into one (then it goes up as a file).
 */
async function sendableImage(file) {
  if (SENDABLE.test(file.type) && file.size <= MAX_IMAGE_BYTES) return file;
  let img;
  try {
    img = await loadBitmap(file);
  } catch {
    return null;
  }
  const encode = (scale, type, q) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext('2d');
    if (type === 'image/jpeg') (g.fillStyle = '#fff'), g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, type, q));
  };
  let scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  // Screenshots stay sharp as PNG when that fits; otherwise JPEG, smaller until it fits.
  if (file.type === 'image/png') {
    const png = await encode(scale, 'image/png');
    if (png && png.size <= MAX_IMAGE_BYTES) return new File([png], file.name.replace(/\.\w+$/, '') + '.png', { type: 'image/png' });
  }
  for (let i = 0; i < 6; i++, scale *= 0.75) {
    const jpg = await encode(scale, 'image/jpeg', 0.85);
    if (jpg && jpg.size <= MAX_IMAGE_BYTES) return new File([jpg], (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  }
  return null;
}

function MenuIcon({ type }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, className: 'cm-ico', 'aria-hidden': true };
  if (type === 'chat')
    return (
      <svg {...common}>
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
      </svg>
    );
  if (type === 'cmd')
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" strokeLinejoin="round" />
    </svg>
  );
}

const SpeechRec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

// Close a popover when clicking anywhere outside its .menu-wrap.
function useOutsideClose(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && close();
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

function fmtSize(n) {
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// A small ring that fills as the context window is used. Click for details and /compact.
// Window: what the CLI reported for the chat's model. Before it has (older CLIs, or a chat from
// before this was tracked) guess from the model name, and never claim a window smaller than the
// tokens already in it.
export function contextWindowFor({ used, window: win, compactWindow, model }) {
  if (win) return win;
  const guess = /\[1m\]/i.test(model || '') ? 1_000_000 : 200_000;
  const known = compactWindow ? Math.max(compactWindow, guess) : guess;
  return used > known ? 1_000_000 : known;
}

function ContextRing({ used, window: winIn, compactWindow, model, onCompact }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!used) return null;
  const win = contextWindowFor({ used, window: winIn, compactWindow, model });
  const pct = Math.min(1, used / win);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`chip icon ctx-ring ${pct > 0.8 ? 'hot' : ''}`} title={`${Math.round(pct * 100)}% of context used`} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.2" />
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <Menu place="up" align="right">
          <div className="pad">
            <b>{Math.round(pct * 100)}% of context used</b>
            <div className="muted text-sm" style={{ marginTop: 4 }}>
              {used.toLocaleString()} of {win.toLocaleString()} tokens. Claude compacts automatically when it gets full.
            </div>
          </div>
          <div className="sep" />
          <button onClick={() => (setOpen(false), onCompact())}>
            <span className="check" />
            Compact now
          </button>
        </Menu>
      )}
    </div>
  );
}

const WINDOW_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet', seven_day_fable: 'Weekly · Fable' };
export function windowName(k) {
  return WINDOW_NAMES[k] || k.replace(/_/g, ' ').replace(/^seven day/, 'Weekly').replace(/^five hour/, '5-hour');
}
export function fmtReset(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const soon = d - Date.now() < 86400000;
  return `Resets ${soon ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// Plan usage limits, like the desktop app's popover.
function UsageButton({ usage }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const entries = Object.entries(usage || {}).filter(([, w]) => w && typeof w.utilization === 'number');
  if (!entries.length) return null;
  const main = (usage.five_hour || entries[0][1]).utilization;
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="footer-info usage-btn" onClick={() => setOpen(!open)} title="Plan usage limits">
        {Math.round(main * 100)}% of plan used
      </button>
      {open && (
        <Menu place="up" align="right" className="usage-pop">
          <div className="pad usage-title">Plan usage limits</div>
          {entries.map(([k, w]) => (
            <div key={k} className="usage-row">
              <div className="usage-line">
                <b>{windowName(k)}</b>
                <span className="muted">
                  {fmtReset(w.resetsAt)} {Math.round(w.utilization * 100)}%
                </span>
              </div>
              <div className="meter">
                <span style={{ width: `${Math.min(100, w.utilization * 100)}%` }} />
              </div>
            </div>
          ))}
        </Menu>
      )}
    </div>
  );
}

function ModelItem({ m, on, onPick }) {
  return (
    <button className={on ? 'on' : ''} onClick={onPick}>
      <span className="check">{on ? '✓' : ''}</span>
      <span>
        {m.displayName}
        {m.description && <span className="desc">{m.description}</span>}
      </span>
    </button>
  );
}

export default function Composer({ sessionId, disabled, busy, onSend, onStop, mode, onMode, model, activeModel, onModel, effort, onEffort, commands, footer, onError, placeholder, context, onCompact, insert, usage, mcpServers, onMcpSignIn, onMcpRefresh, onSettings, onBrowser, chats, initialDraft, quote, onClearQuote, nextPrompt }) {
  const draftKey = `cw.draft.${sessionId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || initialDraft || '';
    } catch {
      return initialDraft || '';
    }
  });
  // A brief handed off from Claude Desktop to send later: put it in the box when it shows up.
  useEffect(() => {
    if (initialDraft) setText((t) => t || initialDraft);
  }, [initialDraft]);
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // {name, path, size} | {name, uploading:true}
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const [menu, setMenu] = useState(null); // 'mode' | 'model' | 'effort' | 'plus'
  const [sub, setSub] = useState(null);
  // While the Connectors list is open, keep checking servers that are still starting.
  const mcpPending = !mcpServers?.length || mcpServers.some((m) => m.status === 'pending');
  useEffect(() => {
    if (menu !== 'plus' || sub !== 'mcp' || !mcpPending || !onMcpRefresh) return;
    const t = setTimeout(onMcpRefresh, 2000);
    return () => clearTimeout(t);
  }, [menu, sub, mcpPending, mcpServers, onMcpRefresh]);
  const [suggest, setSuggest] = useState(null); // {type, items, start, end}
  const [sel, setSel] = useState(0);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const fetchSeq = useRef(0);
  const menuRef = useRef(null);
  const [tipTop, setTipTop] = useState(null);
  // Line the description bubble up with the highlighted command (offset from the menu's bottom).
  const placeTip = () => {
    const m = menuRef.current;
    const el = m?.children[sel];
    if (!m || !el) return setTipTop(null);
    setTipTop(el.offsetTop + el.offsetHeight - m.scrollTop - m.clientHeight);
  };
  useLayoutEffect(placeTip, [sel, suggest]); // eslint-disable-line react-hooks/exhaustive-deps
  const refsRef = useRef({}); // "@chat:name" -> session id
  const knownRef = useRef(new Set()); // mention tokens picked from suggestions, shown as chips even without a / or .
  const caretRef = useRef(null);
  // Put the caret after an inserted suggestion before the next keystroke lands.
  useLayoutEffect(() => {
    if (caretRef.current == null) return;
    const pos = caretRef.current;
    caretRef.current = null;
    taRef.current?.focus();
    taRef.current?.setSelectionRange(pos, pos);
  }, [text]);
  useEffect(() => {
    menuRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel, suggest]);

  useEffect(() => {
    try {
      text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);

  useEffect(() => {
    if (!isTouch) taRef.current?.focus();
  }, []);
  useEffect(() => {
    if (quote && !isTouch) taRef.current?.focus();
  }, [quote]);
  // Edit on a queued message: it comes back into the box (after anything already typed).
  useEffect(() => {
    if (!insert) return;
    setText((t) => (t.trim() ? `${t}\n\n${insert.text}` : insert.text));
    // Its pictures come back too.
    if (insert.images?.length)
      Promise.all(insert.images.map((u) => fetch(u).then((r) => (r.ok ? r.blob() : null)).then((b) => b && readFile(new File([b], 'image', { type: b.type })))).map((p) => p.catch(() => null)))
        .then((read) => setImages((im) => [...im, ...read.filter(Boolean)].slice(0, 10)));
    taRef.current?.focus();
  }, [insert]);

  // Close an open menu on an outside click.
  const barRef = useRef(null);
  useDismiss(!!menu, () => (setMenu(null), setSub(null)), barRef);

  // Work out what to suggest from the text around the cursor: /commands at the start, @files anywhere.
  const updateSuggest = (value, cursor) => {
    const before = value.slice(0, cursor);
    const slash = /^\/([^\s]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const starts = (c) => c.name.toLowerCase().startsWith(q) || (c.aliases || []).some((a) => a.toLowerCase().startsWith(q));
      const items = [...commands.filter(starts), ...commands.filter((c) => !starts(c) && `${c.name} ${(c.aliases || []).join(' ')}`.toLowerCase().includes(q))]
        .slice(0, 80)
        .map((c) => ({ label: c.name, insert: `/${c.name} `, type: 'cmd', desc: c.description, hint: c.argumentHint }));
      setSuggest(items.length ? { type: 'cmd', items, start: 0, end: cursor } : null);
      setSel(0);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const q = at[2];
      const start = cursor - q.length - 1;
      const seq = ++fetchSeq.current;
      // Other chats first (mention one to give Claude its conversation), then files.
      const nq = q.toLowerCase().replace(/^chat:/, '');
      const chatItems = (chats || [])
        .filter((c) => !nq || c.name.toLowerCase().includes(nq.replace(/-/g, ' ')) || chatToken(c).toLowerCase().includes(nq))
        .slice(0, q ? 6 : 4)
        .map((c) => ({ label: c.name, insert: `@${chatToken(c)} `, type: 'chat', id: c.id, hint: c.project }));
      if (chatItems.length) setSuggest({ type: 'file', items: chatItems, start, end: cursor });
      api(`/api/files?session=${sessionId}&q=${encodeURIComponent(q)}`)
        .then(({ files }) => {
          if (seq !== fetchSeq.current) return;
          const items = [...chatItems, ...files.map((f) => ({ label: f, insert: `@${f} `, type: 'file' }))];
          setSuggest(items.length ? { type: 'file', items, start, end: cursor } : null);
          setSel(0);
        })
        .catch(() => {});
      return;
    }
    fetchSeq.current++;
    setSuggest(null);
  };

  const applySuggestion = (item) => {
    const s = suggest;
    if (item.type === 'chat') refsRef.current[item.insert.trim()] = item.id;
    if (item.type !== 'cmd') knownRef.current.add(item.insert.trim());
    const next = text.slice(0, s.start) + item.insert + text.slice(s.end);
    setText(next);
    setSuggest(null);
    caretRef.current = s.start + item.insert.length;
  };

  // Images go inline to Claude; any other file is uploaded to the server and referenced by path.
  const upload = async (file) => {
    const tmp = { name: file.name, uploading: true, key: Math.random() };
    setAttachments((a) => [...a, tmp]);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/upload`, {
        method: 'POST',
        headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
        body: file,
        credentials: 'same-origin',
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
      setAttachments((a) => a.map((x) => (x === tmp ? { ...j, key: tmp.key } : x)));
    } catch (e) {
      setAttachments((a) => a.filter((x) => x !== tmp));
      onError(e);
    }
  };

  const addFiles = async (files) => {
    const all = [...files];
    // Pictures go to Claude inline (scaled down when too big); anything else is uploaded as a file.
    const ready = await Promise.all(all.map((f) => (f.type.startsWith('image/') ? sendableImage(f) : null)));
    const imgs = ready.filter(Boolean);
    const others = all.filter((f, i) => !ready[i]);
    if (others.some((f) => f.size > 50 * 1024 * 1024)) return onError(new Error('Files must be under 50 MB each'));
    others.forEach(upload);
    if (imgs.length) {
      const read = await Promise.all(imgs.map(readFile));
      setImages((im) => [...im, ...read].slice(0, 10));
    }
  };

  const toggleDictation = () => {
    if (listening) return recRef.current?.stop();
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    const base = text ? text.replace(/\s*$/, ' ') : '';
    let heard = '';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += e.results[i][0].transcript;
      setText(base + heard.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => (e.error !== 'aborted' && e.error !== 'no-speech' ? onError(new Error(`Dictation: ${e.error}`)) : null);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const openCommands = () => {
    const next = text.startsWith('/') ? text : '/' + text;
    setText(next);
    updateSuggest('/', 1);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(1, 1);
    });
  };

  const ready = attachments.filter((a) => a.path);
  const empty = !text.trim() && !images.length && !ready.length;
  const submit = () => {
    if (disabled || empty || attachments.some((a) => a.uploading)) return;
    recRef.current?.stop();
    const files = ready.length ? `${text.trim() ? '\n\n' : ''}Attached files:\n${ready.map((a) => `- ${a.path}`).join('\n')}` : '';
    const refs = [...new Set(Object.entries(refsRef.current).filter(([tok]) => text.includes(tok)).map(([, id]) => id))];
    if (onSend(withQuote(quote, text + files), images.map(({ media_type, data }) => ({ media_type, data })), refs)) {
      refsRef.current = {};
      onClearQuote?.();
      setText('');
      setImages([]);
      setAttachments([]);
      setSuggest(null);
    }
  };

  const [showGhost, setShowGhost] = useState(() => getPrefs().suggestions);
  useEffect(() => onPrefs((p) => setShowGhost(p.suggestions)), []);
  const ghost = showGhost && nextPrompt && !text && !quote && !images.length && !attachments.length ? nextPrompt : null;
  const takeGhost = () => {
    setText(ghost);
    caretRef.current = ghost.length;
    taRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      return fileRef.current?.click();
    }
    if (suggest) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setSel((i) => (i + 1) % suggest.items.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setSel((i) => (i - 1 + suggest.items.length) % suggest.items.length);
      if (e.key === 'Escape') return e.preventDefault(), setSuggest(null);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const item = suggest.items[sel];
        if (item && !(suggest.type === 'cmd' && text.trim() === item.insert.trim())) {
          e.preventDefault();
          applySuggestion(item);
          return;
        }
      }
    }
    // Tab in an empty box takes the suggested next message (shown as gray text).
    if (e.key === 'Tab' && !e.shiftKey && ghost) {
      e.preventDefault();
      return takeGhost();
    }
    const enterSends = getPrefs().sendOnEnter ? !e.shiftKey && !isTouch : e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && enterSends && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && busy) {
      onStop();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const cycle = ['default', 'auto', 'acceptEdits', 'plan'];
      onMode(cycle[(cycle.indexOf(mode) + 1) % cycle.length]);
    }
  };

  const modeInfo = MODES.find((m) => m.id === mode) || { label: mode, short: mode };
  const effortInfo = EFFORTS.find((x) => x.id === (effort || ''));
  const models = useModels();
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'm') (e.preventDefault(), setMenu((m) => (m === 'mode' ? null : 'mode')));
      else if (k === 'e') (e.preventDefault(), setMenu((m) => (m === 'effort' ? null : 'effort')));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [moreModels, setMoreModels] = useState(false);
  const modelEfforts = findModel(models, model, activeModel)?.efforts;
  const efforts = modelEfforts?.length ? EFFORTS.filter((x) => !x.id || modelEfforts.includes(x.id)) : EFFORTS;
  const pick = (fn) => (v) => {
    fn(v);
    setMenu(null);
  };

  return (
    <div className="composer-wrap">
      <div
        ref={barRef}
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {suggest && (
          <div role="listbox" className={`pop cmd-menu ${suggest.type === 'cmd' ? 'cmds' : ''}`} ref={menuRef} onScroll={placeTip}>
            {suggest.items.map((it, i) => (
              <button
                key={it.label}
                className={i === sel ? 'on' : ''}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(it);
                }}
              >
                <MenuIcon type={it.type || (suggest.type === 'cmd' ? 'cmd' : 'file')} />
                <span className="cm-label">{it.type === 'file' ? it.label.split('/').pop() : it.label}</span>
                <span className="cm-hint">{it.type === 'cmd' ? '' : it.type === 'chat' ? (it.hint || '').split(/[\\/]/).filter(Boolean).pop() : it.type === 'file' && it.label.includes('/') ? it.label.slice(0, it.label.lastIndexOf('/')) : ''}</span>
              </button>
            ))}
          </div>
        )}
        {suggest?.type === 'cmd' && suggest.items[sel]?.desc && tipTop != null && (
          <div className="cmd-tip" style={{ bottom: `calc(100% + 6px)`, transform: `translateY(${tipTop}px)` }}>
            {suggest.items[sel].hint && <code>{suggest.items[sel].hint}</code>} {suggest.items[sel].desc}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attach-row">
            {attachments.map((a) => (
              <span key={a.key || a.path} className={`attach ${a.uploading ? 'loading' : ''}`} title={a.path || 'Uploading…'}>
                📄 {a.name}
                {a.size != null && <span className="muted"> · {fmtSize(a.size)}</span>}
                {!a.uploading && (
                  <button onClick={() => setAttachments((x) => x.filter((y) => y !== a))} aria-label="Remove">
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="thumbs">
            {images.map((im, i) => (
              <div key={i} className="thumb">
                <img src={im.url} alt={im.name} />
                <button onClick={() => setImages((x) => x.filter((_, j) => j !== i))} aria-label="Remove">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {quote && (
          <div className="quote-chip">
            <QuoteMark />
            <span className="qc-text">{quote}</span>
            <button onClick={onClearQuote} aria-label="Remove quote" title="Remove quote">
              ✕
            </button>
          </div>
        )}
        {/^!\s*\S/.test(text) && <div className="shell-hint">Shell command: runs in the chat's folder, and Claude sees the output with your next message.</div>}
        <MentionInput
          ref={taRef}
          value={text}
          chats={chats}
          known={knownRef.current}
          className={ghost ? 'ghosted' : ''}
          placeholder={ghost || placeholder || (busy ? 'Queue a follow-up…' : isTouch ? 'Reply to Claude…' : 'Reply to Claude…  (@ to mention, / for commands, ! for shell)')}
          onChange={(value, caret) => {
            setText(value);
            updateSuggest(value, caret);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
        />
        {ghost && (
          <button type="button" className="ghost-take" onMouseDown={(e) => e.preventDefault()} onClick={takeGhost} title="Use this suggestion">
            {isTouch ? 'Use' : <kbd>Tab</kbd>}
          </button>
        )}
        <div className="composer-bar">
          <div className="menu-wrap">
            <button className="chip icon" title="Add files, skills, connectors and more" onClick={() => setMenu(menu === 'plus' ? null : 'plus')}>
              +
            </button>
            {menu === 'plus' && (
              <Menu place="up" className="plus-pop">
                <button onClick={() => (setMenu(null), fileRef.current?.click())}>
                  <span className="check">⎙</span> Upload or add files <kbd>Ctrl U</kbd>
                </button>
                <button onClick={() => (setMenu(null), onBrowser?.())}>
                  <span className="check">◎</span> Open the browser
                </button>
                <div className="sep" />
                <button className={sub === 'skills' ? 'on' : ''} onMouseEnter={() => setSub('skills')} onClick={() => setSub(sub === 'skills' ? null : 'skills')}>
                  <span className="check">✦</span> Skills and commands <span className="chev-r">›</span>
                </button>
                <button
                  className={sub === 'mcp' ? 'on' : ''}
                  onMouseEnter={() => (sub !== 'mcp' && onMcpRefresh?.(), setSub('mcp'))}
                  onClick={() => (sub !== 'mcp' && onMcpRefresh?.(), setSub(sub === 'mcp' ? null : 'mcp'))}
                >
                  <span className="check">⌗</span> Connectors
                  {(mcpServers || []).some((m) => m.status !== 'connected' && m.status !== 'pending') && <span className="pill accent warn-pill">⚠ {(mcpServers || []).filter((m) => m.status !== 'connected' && m.status !== 'pending').length}</span>}
                  <span className="chev-r">›</span>
                </button>
                <button onMouseEnter={() => setSub(null)} onClick={() => (setMenu(null), onSettings?.('plugins'))}>
                  <span className="check">⚒</span> Add plugins
                </button>
                {sub === 'skills' && (
                  <Menu place="sub">
                    {commands.length === 0 && <span className="pad muted">Shown after the first message</span>}
                    {commands.slice(0, 40).map(({ name: c, description }) => (
                      <button
                        key={c}
                        title={description || ''}
                        onClick={() => {
                          setMenu(null);
                          setSub(null);
                          setText(`/${c} `);
                          requestAnimationFrame(() => taRef.current?.focus());
                        }}
                      >
                        /{c}
                      </button>
                    ))}
                    <div className="sep" />
                    <button onClick={() => (setMenu(null), onSettings?.('skills'))}>Manage skills…</button>
                  </Menu>
                )}
                {sub === 'mcp' && (
                  <Menu place="sub">
                    {(mcpServers || []).length === 0 && <span className="pad muted">Checking…</span>}
                    {(mcpServers || []).map((m) => (
                      <div key={m.name} className="pad mcp-line">
                        <span className={`dot ${m.status === 'connected' ? 'on' : m.status === 'pending' ? 'busy' : 'err'}`} />
                        <span className="grow">{m.name}</span>
                        {needsSignIn(m) && onMcpSignIn ? (
                          <Button variant="primary" size="sm" className="mcp-signin" onClick={() => (setMenu(null), setSub(null), onMcpSignIn(m.name))}>
                            Sign in
                          </Button>
                        ) : (
                          <span className="muted">{m.status}</span>
                        )}
                      </div>
                    ))}
                    <div className="sep" />
                    <button onClick={() => (setMenu(null), onSettings?.('mcp'))}>Manage connectors…</button>
                  </Menu>
                )}
              </Menu>
            )}
          </div>
          <button className="chip icon hide-mobile" title="Slash commands" onClick={openCommands}>
            /
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          <div className="menu-wrap">
            <button className={`chip mode-${mode}`} onClick={() => setMenu(menu === 'mode' ? null : 'mode')} title="Permission mode (Shift+Tab)">
              {isTouch ? modeInfo.short : modeInfo.label} <span className="chev">▾</span>
            </button>
            {menu === 'mode' && (
              <Menu place="up">
                {MODES.map((m) => (
                  <button key={m.id} className={m.id === mode ? 'on' : ''} onClick={() => pick(onMode)(m.id)}>
                    <span className="check">{m.id === mode ? '✓' : ''}</span>
                    <span>
                      {m.label}
                      <span className="desc">{m.desc}</span>
                    </span>
                  </button>
                ))}
              </Menu>
            )}
          </div>
          <div className="menu-wrap">
            <button className="chip" onClick={() => setMenu(menu === 'model' ? null : 'model')} title={activeModel ? `Running ${activeModel}` : 'Model'}>
              {modelLabel(models, model, activeModel)} <span className="chev">▾</span>
            </button>
            {menu === 'model' && (
              <Menu place="up" className="model-pop">
                {(models.length ? models.filter((m) => !m.id.startsWith('claude-') || m.id === model) : [{ id: '', displayName: 'Default', description: '' }]).map((m) => (
                  <ModelItem key={m.id} m={m} on={m.id === (model || '')} onPick={() => pick(onModel)(m.id)} />
                ))}
                {models.some((m) => m.id.startsWith('claude-') && m.id !== model) && (
                  <>
                    <div className="sep" />
                    <button onClick={() => setMoreModels(!moreModels)}>
                      <span className="check" />
                      More models <span className="chev">{moreModels ? '▴' : '▾'}</span>
                    </button>
                    {moreModels &&
                      models
                        .filter((m) => m.id.startsWith('claude-') && m.id !== model)
                        .map((m) => <ModelItem key={m.id} m={m} on={false} onPick={() => pick(onModel)(m.id)} />)}
                  </>
                )}
                <div className="sep" />
                <button
                  onClick={async () => {
                    setMenu(null);
                    const v = await promptDialog('Model name or alias', model, { ok: 'Use model', placeholder: 'e.g. sonnet or claude-sonnet-5-5' });
                    if (v != null) onModel(v.trim());
                  }}
                >
                  <span className="check" />
                  Other model…
                </button>
              </Menu>
            )}
          </div>
          <div className="menu-wrap hide-mobile">
            <button className="chip" onClick={() => setMenu(menu === 'effort' ? null : 'effort')} title="Effort (how hard Claude thinks)">
              {effort ? `${effortInfo?.label} effort` : 'Effort'} <span className="chev">▾</span>
            </button>
            {menu === 'effort' && (
              <Menu place="up">
                {efforts.map((x) => (
                  <button key={x.id} className={x.id === (effort || '') ? 'on' : ''} onClick={() => pick(onEffort)(x.id)}>
                    <span className="check">{x.id === (effort || '') ? '✓' : ''}</span>
                    {x.label}
                  </button>
                ))}
                <div className="sep" />
                <span className="pad muted">Applies from the next message</span>
              </Menu>
            )}
          </div>
          <span className="footer-info">{footer}</span>
          <UsageButton usage={usage} />
          <ContextRing used={context?.used} window={context?.window} compactWindow={context?.compactWindow} model={context?.model} onCompact={onCompact} />
          {SpeechRec && (
            <button className={`chip icon ${listening ? 'rec' : ''}`} title={listening ? 'Stop dictation' : 'Dictate'} onClick={toggleDictation}>
              {listening ? '●' : '🎙'}
            </button>
          )}
          {busy && (
            <button className="send stop" onClick={onStop} title="Stop (Esc)">
              ■
            </button>
          )}
          <button className="send" disabled={disabled || empty} onClick={submit} title="Send (Enter)">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
