import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getPrefs } from '../prefs.js';

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export const MODES = [
  { id: 'default', label: 'Ask before edits', short: 'Ask', desc: 'Claude asks before changing files or running commands' },
  { id: 'auto', label: 'Auto mode', short: 'Auto', desc: 'A safety classifier approves or blocks each action, so Claude rarely needs to ask' },
  { id: 'acceptEdits', label: 'Accept edits', short: 'Edits', desc: 'File edits are applied automatically' },
  { id: 'plan', label: 'Plan mode', short: 'Plan', desc: 'Claude explores and proposes a plan before changing anything' },
  { id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', desc: 'Everything runs without asking. Use with care' },
];

const MODELS = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
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
function ContextRing({ used, window: win, onCompact }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!used) return null;
  const pct = Math.min(1, used / (win || 200000));
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
        <div className="pop up right">
          <div className="pad">
            <b>{Math.round(pct * 100)}% of context used</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {used.toLocaleString()} of {(win || 200000).toLocaleString()} tokens. Claude compacts automatically when it gets full.
            </div>
          </div>
          <div className="sep" />
          <button onClick={() => (setOpen(false), onCompact())}>
            <span className="check" />
            Compact now
          </button>
        </div>
      )}
    </div>
  );
}

const WINDOW_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
function windowName(k) {
  return WINDOW_NAMES[k] || k.replace(/_/g, ' ').replace(/^seven day/, 'Weekly').replace(/^five hour/, '5-hour');
}
function fmtReset(sec) {
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
        {Math.round(main * 100)}% used
      </button>
      {open && (
        <div className="pop up right usage-pop">
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
        </div>
      )}
    </div>
  );
}

export default function Composer({ sessionId, disabled, busy, onSend, onStop, mode, onMode, model, activeModel, onModel, effort, onEffort, commands, footer, onError, placeholder, context, onCompact, queued, usage, mcpServers, onSettings, onBrowser }) {
  const draftKey = `cw.draft.${sessionId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || '';
    } catch {
      return '';
    }
  });
  const [images, setImages] = useState([]);
  const [attachments, setAttachments] = useState([]); // {name, path, size} | {name, uploading:true}
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const [menu, setMenu] = useState(null); // 'mode' | 'model' | 'effort' | 'plus'
  const [sub, setSub] = useState(null);
  const [suggest, setSuggest] = useState(null); // {type, items, start, end}
  const [sel, setSel] = useState(0);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    try {
      text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  }, [text]);

  useEffect(() => {
    if (!isTouch) taRef.current?.focus();
  }, []);

  // Close an open menu on an outside click.
  const barRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => {
      if (!e.target.closest?.('.menu-wrap')) (setMenu(null), setSub(null));
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  // Work out what to suggest from the text around the cursor: /commands at the start, @files anywhere.
  const updateSuggest = (value, cursor) => {
    const before = value.slice(0, cursor);
    const slash = /^\/([^\s]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 10).map((c) => ({ label: `/${c}`, insert: `/${c} ` }));
      setSuggest(items.length ? { type: 'cmd', items, start: 0, end: cursor } : null);
      setSel(0);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const q = at[2];
      const start = cursor - q.length - 1;
      const seq = ++fetchSeq.current;
      api(`/api/files?session=${sessionId}&q=${encodeURIComponent(q)}`)
        .then(({ files }) => {
          if (seq !== fetchSeq.current) return;
          const items = files.map((f) => ({ label: f, insert: `@${f} `, type: 'file' }));
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
    const next = text.slice(0, s.start) + item.insert + text.slice(s.end);
    setText(next);
    setSuggest(null);
    const pos = s.start + item.insert.length;
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
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
    const imgs = all.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.size <= 5 * 1024 * 1024);
    const others = all.filter((f) => !imgs.includes(f));
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
    if (onSend(text + files, images.map(({ media_type, data }) => ({ media_type, data })))) {
      setText('');
      setImages([]);
      setAttachments([]);
      setSuggest(null);
    }
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
  const pick = (fn) => (v) => {
    fn(v);
    setMenu(null);
  };

  return (
    <div className="composer-wrap">
      {suggest && (
        <div className="cmd-menu">
          {suggest.items.map((it, i) => (
            <button
              key={it.label}
              className={i === sel ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(it);
              }}
            >
              {it.label}
              <span className="ctype">{suggest.type === 'file' ? 'file' : 'command'}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {queued > 0 && <div className="queued-note">{queued} message{queued > 1 ? 's' : ''} queued. Claude reads {queued > 1 ? 'them' : 'it'} when the current step finishes.</div>}
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
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder || (busy ? 'Queue a follow-up…' : isTouch ? 'Reply to Claude…' : 'Reply to Claude…  (@ to mention a file, / for commands)')}
          onChange={(e) => {
            setText(e.target.value);
            updateSuggest(e.target.value, e.target.selectionStart);
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
        <div className="composer-bar">
          <div className="menu-wrap">
            <button className="chip icon" title="Add files, skills, connectors and more" onClick={() => setMenu(menu === 'plus' ? null : 'plus')}>
              +
            </button>
            {menu === 'plus' && (
              <div className="pop up plus-pop">
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
                <button className={sub === 'mcp' ? 'on' : ''} onMouseEnter={() => setSub('mcp')} onClick={() => setSub(sub === 'mcp' ? null : 'mcp')}>
                  <span className="check">⌗</span> Connectors
                  {(mcpServers || []).some((m) => m.status !== 'connected' && m.status !== 'pending') && <span className="warn-pill">⚠ {(mcpServers || []).filter((m) => m.status !== 'connected' && m.status !== 'pending').length}</span>}
                  <span className="chev-r">›</span>
                </button>
                <button onMouseEnter={() => setSub(null)} onClick={() => (setMenu(null), onSettings?.('plugins'))}>
                  <span className="check">⚒</span> Add plugins
                </button>
                {sub === 'skills' && (
                  <div className="pop sub">
                    {commands.length === 0 && <span className="pad muted">Shown after the first message</span>}
                    {commands.slice(0, 40).map((c) => (
                      <button
                        key={c}
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
                  </div>
                )}
                {sub === 'mcp' && (
                  <div className="pop sub">
                    {(mcpServers || []).length === 0 && <span className="pad muted">Shown after the first message</span>}
                    {(mcpServers || []).map((m) => (
                      <div key={m.name} className="pad mcp-line">
                        <span className={`dot ${m.status === 'connected' ? 'on' : m.status === 'pending' ? 'busy' : 'err'}`} />
                        <span style={{ flex: 1 }}>{m.name}</span>
                        <span className="muted">{m.status}</span>
                      </div>
                    ))}
                    <div className="sep" />
                    <button onClick={() => (setMenu(null), onSettings?.('mcp'))}>Manage connectors…</button>
                  </div>
                )}
              </div>
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
              <div className="pop up">
                {MODES.map((m) => (
                  <button key={m.id} className={m.id === mode ? 'on' : ''} onClick={() => pick(onMode)(m.id)}>
                    <span className="check">{m.id === mode ? '✓' : ''}</span>
                    <span>
                      {m.label}
                      <span className="desc">{m.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="menu-wrap">
            <button className="chip" onClick={() => setMenu(menu === 'model' ? null : 'model')} title={activeModel ? `Running ${activeModel}` : 'Model'}>
              {model ? MODELS.find((m) => m.id === model)?.label || model : activeModel?.replace(/^claude-/, '') || 'Model'} <span className="chev">▾</span>
            </button>
            {menu === 'model' && (
              <div className="pop up">
                {MODELS.map((m) => (
                  <button key={m.id} className={m.id === (model || '') ? 'on' : ''} onClick={() => pick(onModel)(m.id)}>
                    <span className="check">{m.id === (model || '') ? '✓' : ''}</span>
                    {m.label}
                    {m.id === '' && activeModel ? <span className="muted"> ({activeModel})</span> : null}
                  </button>
                ))}
                <div className="sep" />
                <button
                  onClick={() => {
                    const v = window.prompt('Model name or alias', model);
                    if (v != null) onModel(v);
                    setMenu(null);
                  }}
                >
                  <span className="check" />
                  Other model…
                </button>
              </div>
            )}
          </div>
          <div className="menu-wrap hide-mobile">
            <button className="chip" onClick={() => setMenu(menu === 'effort' ? null : 'effort')} title="Effort (how hard Claude thinks)">
              {effort ? `${effortInfo?.label} effort` : 'Effort'} <span className="chev">▾</span>
            </button>
            {menu === 'effort' && (
              <div className="pop up">
                {EFFORTS.map((x) => (
                  <button key={x.id} className={x.id === (effort || '') ? 'on' : ''} onClick={() => pick(onEffort)(x.id)}>
                    <span className="check">{x.id === (effort || '') ? '✓' : ''}</span>
                    {x.label}
                  </button>
                ))}
                <div className="sep" />
                <span className="pad muted">Applies from the next message</span>
              </div>
            )}
          </div>
          <span className="footer-info">{footer}</span>
          <UsageButton usage={usage} />
          <ContextRing used={context?.used} window={context?.window} onCompact={onCompact} />
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
