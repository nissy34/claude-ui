import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Live view of the chat's built-in browser tab (the same one Claude drives). Click, type and
// scroll on the picture to use the page yourself.
export default function BrowserView({ sessionId, onError }) {
  const [st, setSt] = useState(null);
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [frame, setFrame] = useState(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef(null);
  const base = `/api/sessions/${sessionId}/browser`;
  const visible = useRef(true);

  const refreshState = useCallback(
    () =>
      api(base)
        .then((s) => {
          setSt(s);
          if (!editing && s.url) setUrl(s.url === 'about:blank' ? '' : s.url);
          return s;
        })
        .catch(() => null),
    [base, editing]
  );

  // Poll the picture while the panel is open and the tab is visible.
  useEffect(() => {
    let stop = false;
    let timer;
    let lastUrl = null;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) {
        const s = await refreshState();
        if (s?.open) {
          const img = new Image();
          const next = `${base}/frame?t=${Date.now()}`;
          await new Promise((r) => {
            img.onload = img.onerror = r;
            img.src = next;
          });
          if (!stop && img.naturalWidth) {
            if (lastUrl) URL.revokeObjectURL?.(lastUrl);
            setFrame(next);
          }
        }
      }
      timer = setTimeout(tick, document.hidden ? 3000 : 900);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [base, refreshState]);

  const act = async (op, body = {}) => {
    setBusy(true);
    try {
      const r = await api(`${base}/${op}`, { method: 'POST', body });
      if (r.state) setSt(r.state);
      if (r.url) setUrl(r.url);
      setFrame(`${base}/frame?t=${Date.now()}`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const go = (e) => {
    e?.preventDefault();
    setEditing(false);
    if (url.trim()) act('navigate', { url: url.trim() });
  };

  const point = (e) => {
    const img = imgRef.current;
    const r = img.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * img.naturalWidth), y: Math.round(((e.clientY - r.top) / r.height) * img.naturalHeight) };
  };

  const onKey = (e) => {
    if (e.metaKey || (e.ctrlKey && !['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase()))) return;
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey) act('type', { text: e.key });
    else {
      const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift'].filter(Boolean);
      act('press', { key: [...mods, e.key === ' ' ? 'Space' : e.key].join('+') });
    }
  };

  const wheel = useRef(0);
  const onWheel = (e) => {
    wheel.current += e.deltaY;
    clearTimeout(wheel.t);
    wheel.t = setTimeout(() => {
      const dy = wheel.current;
      wheel.current = 0;
      act('scroll', { dy });
    }, 120);
  };

  if (st && !st.available)
    return (
      <div className="panel-empty">
        The built-in browser needs Playwright on the server. In the claude-ui folder run <code>npm install playwright-core</code> and <code>npx playwright install chromium</code>, then restart. You can also point <code>CW_BROWSER_PATH</code> at an installed Chrome or Edge.
      </div>
    );

  return (
    <div className="browser">
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="icon-btn" title="Back" disabled={!st?.open} onClick={() => act('back')}>
          ←
        </button>
        <button type="button" className="icon-btn" title="Forward" disabled={!st?.open} onClick={() => act('forward')}>
          →
        </button>
        <button type="button" className="icon-btn" title="Reload" disabled={!st?.open} onClick={() => act('reload')}>
          {busy ? <span className="spinner" /> : '↻'}
        </button>
        <input
          className="browser-url"
          value={url}
          placeholder="Enter a URL, e.g. localhost:3000"
          onFocus={(e) => (setEditing(true), e.target.select())}
          onBlur={() => setEditing(false)}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          className="art-zoom"
          title="Viewport"
          disabled={!st?.open}
          value={st?.width && st.width < 600 ? 'phone' : st?.width && st.width < 1000 ? 'tablet' : 'desktop'}
          onChange={(e) => act('resize', { desktop: { width: 1280, height: 800 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } }[e.target.value])}
        >
          <option value="desktop">Desktop</option>
          <option value="tablet">Tablet</option>
          <option value="phone">Phone</option>
        </select>
      </form>
      {st?.open && frame ? (
        <div className="browser-view" tabIndex={0} onKeyDown={onKey} onWheel={onWheel}>
          <img ref={imgRef} src={frame} alt={st.title || 'Browser'} draggable={false} onClick={(e) => (e.currentTarget.parentElement.focus(), act('click', point(e)))} />
        </div>
      ) : (
        <div className="panel-empty">
          <div style={{ fontSize: 28, marginBottom: 8 }}>◎</div>
          This chat's browser runs on the server, so it can open your dev servers on localhost. Claude can use it too: ask it to open your app and test it, and you'll see it here.
          <div style={{ marginTop: 12 }}>
            <button className="btn small primary" onClick={() => act('navigate', { url: url.trim() || 'about:blank' })}>
              Open browser
            </button>
          </div>
        </div>
      )}
      {st?.open && <div className="browser-foot muted">{st.title || st.url} · click, type and scroll on the page to use it</div>}
    </div>
  );
}
