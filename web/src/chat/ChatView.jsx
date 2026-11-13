import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl } from '../api.js';
import { buildItems, lastTodos } from './model.js';
import { renderMarkdown } from './markdown.js';
import ToolCard, { Todos } from './ToolCard.jsx';
import Permission from './Permission.jsx';
import Composer from './Composer.jsx';

function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: 'claude-web' });
  } catch {}
}

function Markdown({ text, streaming }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thinking({ text, streaming }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        {streaming ? <span className="spinner" /> : '✻'} {streaming ? 'Thinking…' : 'Thought process'} <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n) {
  if (!n) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

export default function ChatView({ session, onMenu, onError, onDeleted }) {
  const [events, setEvents] = useState([]);
  const [deltas, setDeltas] = useState({});
  const [meta, setMeta] = useState(session);
  const [state, setState] = useState(session.state || 'idle');
  const [conn, setConn] = useState('connecting');
  const [status, setStatus] = useState(null);
  const [stick, setStick] = useState(true);
  const [showTodos, setShowTodos] = useState(true);
  const wsRef = useRef(null);
  const listRef = useRef(null);
  const deltaOrder = useRef(0);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    onError(new Error('Not connected to the server yet'));
    return false;
  }, [onError]);

  useEffect(() => {
    let closed = false;
    let retry = 500;
    let timer;
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/ws?id=${session.id}`));
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'chat') {
          setEvents(m.events);
          setMeta(m.meta);
          setState(m.state);
          setDeltas({});
          setConn('open');
          retry = 500;
        } else if (m.t === 'ev') {
          const e = m.ev;
          setEvents((list) => [...list, e]);
          if (e.k === 'block' || e.k === 'result') {
            setDeltas((d) => {
              if (e.k === 'result') return {};
              const next = { ...d };
              for (const key of Object.keys(next)) if (next[key].msgId === e.msgId) delete next[key];
              return next;
            });
          }
          if (e.k === 'perm') notify('Claude needs your permission', `${e.tool} in ${session.name}`);
          if (e.k === 'result') notify(e.isError ? 'Claude stopped with an error' : 'Claude finished', session.name);
          if (e.k === 'result' || e.k === 'error') setStatus(null);
        } else if (m.t === 'delta') {
          const key = `${m.msgId}:${m.index}`;
          setDeltas((d) => ({
            ...d,
            [key]: { key, msgId: m.msgId, kind: m.kind, parent: m.parent, order: d[key]?.order ?? deltaOrder.current++, text: (d[key]?.text || '') + m.text },
          }));
        } else if (m.t === 'state') {
          setState(m.state);
          setMeta(m.meta);
        } else if (m.t === 'status') {
          setStatus(m.status);
        } else if (m.t === 'error') onError(new Error(m.error));
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4004) return setConn('gone');
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
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      wsRef.current?.close();
    };
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => buildItems(events, deltas), [events, deltas]);
  const todos = useMemo(() => lastTodos(events), [events]);
  const pendingPerms = items.filter((i) => i.type === 'tool' && i.perm && !i.perm.done).length + items.filter((i) => i.type === 'perm' && !i.done).length;
  const busy = state === 'busy' || state === 'waiting';

  // Keep the view pinned to the bottom unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [items, stick]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const answer = (a) => send({ t: 'perm', ...a });
  const setMode = (mode) => send({ t: 'mode', mode });
  const setModel = (model) => send({ t: 'model', model });

  const submit = (text, images) => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    setStick(true);
    return send({ t: 'send', text, images });
  };

  const rename = () => {
    const name = window.prompt('Rename chat', meta.name);
    if (name) api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { name } }).catch(onError);
  };
  const remove = () => {
    if (!window.confirm('Delete this chat from the list? Claude keeps its own transcript, so you can resume it from History.')) return;
    api(`/api/sessions/${session.id}`, { method: 'DELETE' }).then(onDeleted).catch(onError);
  };

  const project = meta.cwd?.split('/').filter(Boolean).pop();
  const rate = meta.rateLimit?.unifiedWindows?.five_hour;

  return (
    <div className="chat-view">
      <div className="topbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </button>
        <div className="title" onClick={rename} title="Rename">
          <span className="tname">{meta.name}</span>
          <span className="muted tcwd">{project}</span>
        </div>
        {conn === 'reconnecting' && <span className="pill warn">reconnecting…</span>}
        {session.clients > 1 && <span className="pill hide-mobile">{session.clients} devices</span>}
        <div className="tools">
          {meta.live && (
            <button className="icon-btn" title="Stop the Claude process (the chat can continue later)" onClick={() => send({ t: 'stop' })}>
              ⏻
            </button>
          )}
          <button className="icon-btn danger" title="Delete chat" onClick={remove}>
            🗑
          </button>
        </div>
      </div>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        <div className="messages-inner">
          {items.length === 0 && conn === 'open' && (
            <div className="welcome">
              <div className="logo">✻</div>
              <h2>What are we working on in {project}?</h2>
              <p className="muted">{meta.cwd}</p>
            </div>
          )}
          {items.map((it, n) => {
            switch (it.type) {
              case 'user':
                return (
                  <div key={n} className="msg user">
                    <div className="bubble">
                      {it.images > 0 && <div className="img-note">🖼 {it.images} image{it.images > 1 ? 's' : ''}</div>}
                      {it.text}
                    </div>
                  </div>
                );
              case 'text':
                return (
                  <div key={it.key || n} className="msg assistant">
                    <Markdown text={it.text} streaming={it.streaming} />
                  </div>
                );
              case 'thinking':
                return <Thinking key={it.key || n} text={it.text} streaming={it.streaming} />;
              case 'tool':
                return (
                  <ToolCard key={it.id} item={it} cwd={meta.cwd}>
                    {it.perm && <Permission perm={it.perm} cwd={meta.cwd} onAnswer={answer} onMode={setMode} showBody={false} />}
                  </ToolCard>
                );
              case 'perm':
                return <Permission key={it.reqId} perm={it} cwd={meta.cwd} onAnswer={answer} onMode={setMode} />;
              case 'result':
                return (
                  <div key={n} className={`turn-end ${it.isError ? 'err' : ''}`}>
                    {it.isError ? it.text || `Stopped (${it.subtype})` : null}
                    <span className="muted">
                      {[fmtDuration(it.durationMs), it.cost ? `$${it.cost.toFixed(3)}` : ''].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                );
              case 'error':
                return (
                  <pre key={n} className="sys-error">
                    {it.text}
                  </pre>
                );
              case 'notice':
                return (
                  <div key={n} className="notice">
                    {it.text}
                  </div>
                );
              default:
                return null;
            }
          })}
          {busy && (
            <div className="working">
              <span className="spark">✻</span>
              {pendingPerms ? 'Waiting for your approval' : status === 'compacting' ? 'Compacting…' : 'Working…'}
            </div>
          )}
        </div>
      </div>

      {!stick && (
        <button className="jump" onClick={() => setStick(true)}>
          ↓ Latest
        </button>
      )}

      {todos && todos.some((t) => t.status !== 'completed') && (
        <div className="todo-dock">
          <button className="todo-head" onClick={() => setShowTodos((s) => !s)}>
            ☑ Tasks {todos.filter((t) => t.status === 'completed').length}/{todos.length} <span className="chev">{showTodos ? '▾' : '▸'}</span>
          </button>
          {showTodos && <Todos todos={todos} />}
        </div>
      )}

      <Composer
        disabled={conn !== 'open'}
        busy={busy}
        onSend={submit}
        onStop={() => send({ t: 'interrupt' })}
        mode={meta.permissionMode || 'default'}
        onMode={setMode}
        model={meta.model || ''}
        activeModel={meta.activeModel}
        onModel={setModel}
        commands={meta.commands || []}
        footer={[
          meta.contextTokens ? `${fmtTokens(meta.contextTokens)} context` : '',
          rate ? `5h limit ${Math.round(rate.utilization * 100)}%` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        draftKey={`cw.draft.${session.id}`}
        onError={onError}
      />
    </div>
  );
}
