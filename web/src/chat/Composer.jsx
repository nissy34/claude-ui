import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

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

export default function Composer({ sessionId, disabled, busy, onSend, onStop, mode, onMode, model, activeModel, onModel, effort, onEffort, commands, footer, onError, placeholder }) {
  const draftKey = `cw.draft.${sessionId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || '';
    } catch {
      return '';
    }
  });
  const [images, setImages] = useState([]);
  const [menu, setMenu] = useState(null); // 'mode' | 'model' | 'effort'
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

  const addFiles = async (files) => {
    const list = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!list.length) return;
    if (list.some((f) => f.size > 5 * 1024 * 1024)) return onError(new Error('Images must be under 5 MB each'));
    const read = await Promise.all(list.map(readFile));
    setImages((im) => [...im, ...read].slice(0, 10));
  };

  const submit = () => {
    if (disabled || (!text.trim() && !images.length)) return;
    if (onSend(text, images.map(({ media_type, data }) => ({ media_type, data })))) {
      setText('');
      setImages([]);
      setSuggest(null);
    }
  };

  const onKeyDown = (e) => {
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
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
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
          <button className="chip icon" title="Attach image" onClick={() => fileRef.current?.click()}>
            +
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
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
          {busy && (
            <button className="send stop" onClick={onStop} title="Stop (Esc)">
              ■
            </button>
          )}
          <button className="send" disabled={disabled || (!text.trim() && !images.length)} onClick={submit} title="Send (Enter)">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
