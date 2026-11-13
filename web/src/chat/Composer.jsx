import React, { useEffect, useRef, useState } from 'react';

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export const MODES = [
  { id: 'default', label: 'Ask before edits', short: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits', short: 'Edits' },
  { id: 'plan', label: 'Plan mode', short: 'Plan' },
  { id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass' },
];

const MODELS = [
  { id: '', label: 'Default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const [, data] = String(r.result).split(',');
      resolve({ media_type: file.type, data, url: r.result, name: file.name });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Composer({ disabled, busy, onSend, onStop, mode, onMode, model, activeModel, onModel, commands, footer, draftKey, onError }) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || '';
    } catch {
      return '';
    }
  });
  const [images, setImages] = useState([]);
  const [menu, setMenu] = useState(null); // 'mode' | 'model'
  const [cmdIndex, setCmdIndex] = useState(0);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    try {
      text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);

  // Auto-grow the textarea.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, [text]);

  useEffect(() => {
    if (!isTouch) taRef.current?.focus();
  }, []);

  const slash = text.startsWith('/') && !text.includes(' ') && !text.includes('\n') ? text.slice(1).toLowerCase() : null;
  const matches = slash !== null ? commands.filter((c) => c.toLowerCase().includes(slash)).slice(0, 8) : [];

  const addFiles = async (files) => {
    const list = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!list.length) return;
    if (list.some((f) => f.size > 5 * 1024 * 1024)) return onError(new Error('Images must be under 5 MB each'));
    const read = await Promise.all(list.map(readFile));
    setImages((im) => [...im, ...read].slice(0, 10));
  };

  const submit = () => {
    if (disabled) return;
    if (!text.trim() && !images.length) return;
    if (onSend(text, images.map(({ media_type, data }) => ({ media_type, data })))) {
      setText('');
      setImages([]);
    }
  };

  const onKeyDown = (e) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setCmdIndex((i) => (i + 1) % matches.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setCmdIndex((i) => (i - 1 + matches.length) % matches.length);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && `/${matches[cmdIndex]}` !== text)) {
        e.preventDefault();
        setText(`/${matches[cmdIndex]} `);
        setCmdIndex(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && busy) {
      onStop();
    } else if (e.key === 'Tab' && e.shiftKey) {
      // Shift+Tab cycles permission modes, like the CLI.
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === mode);
      onMode(MODES[(i + 1) % 3].id);
    }
  };

  const modeInfo = MODES.find((m) => m.id === mode) || { label: mode, short: mode };

  return (
    <div className="composer-wrap">
      {matches.length > 0 && (
        <div className="cmd-menu">
          {matches.map((c, i) => (
            <button
              key={c}
              className={i === cmdIndex ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(`/${c} `);
                taRef.current?.focus();
              }}
            >
              /{c}
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
          placeholder={busy ? 'Queue a follow-up…' : 'Reply to Claude…'}
          onChange={(e) => {
            setText(e.target.value);
            setCmdIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
        />
        <div className="composer-bar">
          <button className="chip" title="Attach image" onClick={() => fileRef.current?.click()}>
            ＋
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          <div className="chip-wrap">
            <button className={`chip mode-${mode}`} onClick={() => setMenu(menu === 'mode' ? null : 'mode')} title="Permission mode (Shift+Tab)">
              {isTouch ? modeInfo.short : modeInfo.label} ▾
            </button>
            {menu === 'mode' && (
              <div className="pop" onMouseLeave={() => setMenu(null)}>
                {MODES.map((m) => (
                  <button key={m.id} className={m.id === mode ? 'on' : ''} onClick={() => (onMode(m.id), setMenu(null))}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chip-wrap">
            <button className="chip" onClick={() => setMenu(menu === 'model' ? null : 'model')} title={activeModel || ''}>
              {MODELS.find((m) => m.id === model)?.label || model || 'Model'} ▾
            </button>
            {menu === 'model' && (
              <div className="pop" onMouseLeave={() => setMenu(null)}>
                {MODELS.map((m) => (
                  <button key={m.id} className={m.id === model ? 'on' : ''} onClick={() => (onModel(m.id), setMenu(null))}>
                    {m.label}
                    {m.id === '' && activeModel ? <span className="muted"> ({activeModel})</span> : null}
                  </button>
                ))}
                <button
                  onClick={() => {
                    const v = window.prompt('Model name or alias', model);
                    if (v != null) onModel(v);
                    setMenu(null);
                  }}
                >
                  Custom…
                </button>
              </div>
            )}
          </div>
          <span className="footer-info muted">{footer}</span>
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
