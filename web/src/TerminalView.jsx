import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, wsUrl } from './api.js';
import KeyBar from './KeyBar.jsx';

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

const THEME = {
  background: '#1a1915',
  foreground: '#e8e6dc',
  cursor: '#d97757',
  cursorAccent: '#1a1915',
  selectionBackground: '#d9775755',
  black: '#262624',
  red: '#e06c6c',
  green: '#8fbf7f',
  yellow: '#e5c07b',
  blue: '#6fa8dc',
  magenta: '#c49bd6',
  cyan: '#6fc1c1',
  white: '#d4d2c8',
  brightBlack: '#6b6a64',
  brightRed: '#f08080',
  brightGreen: '#a8d896',
  brightYellow: '#f0d08f',
  brightBlue: '#8cbdf0',
  brightMagenta: '#d8b2e8',
  brightCyan: '#8fd8d8',
  brightWhite: '#faf9f5',
};

function loadFontSize() {
  const v = parseInt(localStorage.getItem('cw.fontSize') || '', 10);
  return Number.isFinite(v) ? v : isTouch ? 11 : 13;
}

export default function TerminalView({ session, onMenu, onError, onDeleted }) {
  const holderRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const serverSize = useRef({ cols: 0, rows: 0 });
  const ctrlRef = useRef(false);
  const [conn, setConn] = useState('connecting');
  const [ctrl, setCtrl] = useState(false);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [compose, setCompose] = useState(isTouch);
  const [text, setText] = useState('');
  const [textView, setTextView] = useState(null);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const t = termRef.current;
    // The device you type on takes over the pty size.
    if (t && (serverSize.current.cols !== t.cols || serverSize.current.rows !== t.rows)) {
      ws.send(JSON.stringify({ t: 'resize', cols: t.cols, rows: t.rows }));
      serverSize.current = { cols: t.cols, rows: t.rows };
    }
    ws.send(JSON.stringify({ t: 'i', d: data }));
  }, []);

  const armCtrl = useCallback((v) => {
    ctrlRef.current = v;
    setCtrl(v);
  }, []);

  // Create the terminal and connect.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: loadFontSize(),
      theme: THEME,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(holderRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {}

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      return true;
    });

    term.onData((d) => {
      if (ctrlRef.current && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
        armCtrl(false);
      }
      send(d);
    });

    let closed = false;
    let retry = 500;
    let timer;
    const connect = () => {
      setConn((c) => (c === 'connecting' ? c : 'reconnecting'));
      const ws = new WebSocket(wsUrl(`/ws?id=${session.id}&cols=${term.cols}&rows=${term.rows}`));
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 500;
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'o') term.write(msg.d);
        else if (msg.t === 'snapshot') {
          serverSize.current = { cols: msg.cols, rows: msg.rows };
          term.reset();
          term.write(msg.d);
          setConn('open');
        } else if (msg.t === 'size') serverSize.current = { cols: msg.cols, rows: msg.rows };
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4004) {
          setConn('gone');
          return;
        }
        setConn('reconnecting');
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();

    const onVis = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        retry = 500;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    let rt;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && (serverSize.current.cols !== term.cols || serverSize.current.rows !== term.rows)) {
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
          serverSize.current = { cols: term.cols, rows: term.rows };
        }
      }, 80);
    });
    ro.observe(holderRef.current);

    if (!isTouch) term.focus();

    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(rt);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      wsRef.current?.close();
      term.dispose();
    };
  }, [session.id, send, armCtrl]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = fontSize;
    try {
      localStorage.setItem('cw.fontSize', String(fontSize));
    } catch {}
    try {
      fitRef.current.fit();
    } catch {}
  }, [fontSize]);

  const sendKey = (seq) => {
    const t = termRef.current;
    if (t?.modes.applicationCursorKeysMode && /^\x1b\[[ABCD]$/.test(seq)) seq = '\x1bO' + seq[2];
    send(seq);
  };

  const submitCompose = (e) => {
    e?.preventDefault();
    if (!text) {
      send('\r');
      return;
    }
    const body = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    send(body);
    // Give the TUI a moment to take the text before pressing Enter.
    setTimeout(() => send('\r'), 30);
    setText('');
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) send(clip.includes('\n') ? `\x1b[200~${clip}\x1b[201~` : clip);
    } catch {
      onError(new Error('Clipboard read blocked by the browser. Long-press the compose box to paste instead.'));
    }
  };

  const showText = () => {
    const t = termRef.current;
    if (!t) return;
    const buf = t.buffer.active;
    const lines = [];
    const start = Math.max(0, buf.length - 2000);
    for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    setTextView(lines.join('\n'));
  };

  const rename = async () => {
    const name = window.prompt('Rename session', session.name);
    if (!name) return;
    api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { name } }).catch(onError);
  };
  const restart = () => api(`/api/sessions/${session.id}/restart`, { method: 'POST' }).catch(onError);
  const kill = () => {
    if (window.confirm('Stop this session? The conversation can be resumed later.')) api(`/api/sessions/${session.id}/kill`, { method: 'POST' }).catch(onError);
  };
  const remove = () => {
    if (!window.confirm('Delete this session from the list? (Claude keeps its own transcript.)')) return;
    api(`/api/sessions/${session.id}`, { method: 'DELETE' }).then(onDeleted).catch(onError);
  };

  const running = session.status === 'running';

  return (
    <div className="term-view">
      <div className="topbar bordered">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </button>
        <div className="title" onClick={rename} title="Rename">
          <span className={`dot ${running ? (session.attention ? 'attn' : 'on') : 'off'}`} />
          <span className="tname">{session.name}</span>
          <span className="muted tcwd">{session.cwd}</span>
        </div>
        {conn === 'reconnecting' && <span className="pill warn">reconnecting…</span>}
        {session.clients > 1 && <span className="pill" title="Other devices attached">{session.clients} viewers</span>}
        <div className="tools">
          <button className="icon-btn" title="Smaller text" onClick={() => setFontSize((f) => Math.max(8, f - 1))}>
            A−
          </button>
          <button className="icon-btn" title="Larger text" onClick={() => setFontSize((f) => Math.min(24, f + 1))}>
            A+
          </button>
          <button className={`icon-btn ${compose ? 'on' : ''}`} title="Compose box" onClick={() => setCompose((c) => !c)}>
            ✎
          </button>
          <button className="icon-btn" title="View as text (for copying)" onClick={showText}>
            ⧉
          </button>
          {running ? (
            <button className="icon-btn" title="Stop" onClick={kill}>
              ■
            </button>
          ) : (
            <button className="icon-btn" title="Resume" onClick={restart}>
              ▶
            </button>
          )}
          <button className="icon-btn danger" title="Delete" onClick={remove}>
            🗑
          </button>
        </div>
      </div>

      <div className="term-wrap">
        <div className="term-holder" ref={holderRef} />
        {!running && conn !== 'gone' && (
          <div className="ended">
            Session ended{session.exitCode != null ? ` (exit ${session.exitCode})` : ''}.
            <button className="btn small primary" onClick={restart}>
              Resume
            </button>
          </div>
        )}
        {conn === 'connecting' && <div className="overlay-msg">Connecting…</div>}
        {conn === 'gone' && <div className="overlay-msg">Session was deleted.</div>}
      </div>

      <KeyBar onKey={sendKey} ctrl={ctrl} onCtrl={() => armCtrl(!ctrl)} onPaste={paste} />

      {compose && (
        <form className="compose" onSubmit={submitCompose}>
          <textarea
            rows={1}
            value={text}
            placeholder="Message Claude…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isTouch) submitCompose(e);
            }}
            autoCapitalize="sentences"
          />
          <button className="btn primary">Send</button>
        </form>
      )}

      {textView !== null && (
        <div className="modal" onClick={() => setTextView(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Terminal text</span>
              <button className="btn small" onClick={() => navigator.clipboard?.writeText(textView).catch(() => {})}>
                Copy all
              </button>
              <button className="icon-btn" onClick={() => setTextView(null)}>
                ✕
              </button>
            </div>
            <pre className="modal-text">{textView}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
