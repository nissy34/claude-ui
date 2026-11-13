import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, wsUrl } from './api.js';
import Login from './Login.jsx';
import Sidebar from './Sidebar.jsx';
import TerminalView from './TerminalView.jsx';
import ChatView from './chat/ChatView.jsx';

function readHash() {
  const m = location.hash.match(/s=([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState({ root: '', projects: [] });
  const [activeId, setActiveId] = useState(readHash);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState('');
  const eventsRef = useRef(null);

  const showError = useCallback((e) => {
    if (e?.status === 401) return setAuthed(false);
    setToast(e?.message || String(e));
    setTimeout(() => setToast(''), 4000);
  }, []);

  useEffect(() => {
    api('/api/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));
  }, []);

  const loadProjects = useCallback(() => {
    api('/api/projects').then(setProjects).catch(showError);
  }, [showError]);

  // Live session list over a websocket, with reconnect.
  useEffect(() => {
    if (!authed) return;
    loadProjects();
    let closed = false;
    let retry = 500;
    let timer;
    const connect = () => {
      const ws = new WebSocket(wsUrl('/ws/events'));
      eventsRef.current = ws;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'sessions') setSessions(msg.sessions);
        retry = 500;
      };
      ws.onclose = () => {
        if (closed) return;
        api('/api/me')
          .then((r) => {
            if (!r.authed) return setAuthed(false);
            timer = setTimeout(connect, retry);
            retry = Math.min(retry * 2, 10000);
          })
          .catch(() => {
            timer = setTimeout(connect, retry);
            retry = Math.min(retry * 2, 10000);
          });
      };
    };
    connect();
    const onVis = () => {
      if (document.visibilityState === 'visible' && eventsRef.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      closed = true;
      clearTimeout(timer);
      eventsRef.current?.close();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [authed, loadProjects]);

  useEffect(() => {
    const onHash = () => setActiveId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((id) => {
    location.hash = id ? `s=${id}` : '';
    setActiveId(id);
    setDrawer(false);
  }, []);

  const createSession = useCallback(
    async (opts) => {
      try {
        const { session } = await api('/api/sessions', { method: 'POST', body: opts });
        setSessions((list) => [session, ...list.filter((s) => s.id !== session.id)]);
        select(session.id);
        loadProjects();
      } catch (e) {
        showError(e);
      }
    },
    [select, showError, loadProjects]
  );

  const active = sessions.find((s) => s.id === activeId) || null;

  useEffect(() => {
    document.title = active ? `${active.attention ? '● ' : ''}${active.name} · Claude Web` : 'Claude Web';
  }, [active]);

  if (authed === null) return <div className="splash" />;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className={`app ${drawer ? 'drawer-open' : ''}`}>
      <Sidebar
        sessions={sessions}
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={createSession}
        onReloadProjects={loadProjects}
        onError={showError}
        onLogout={async () => {
          await api('/api/logout', { method: 'POST' }).catch(() => {});
          setAuthed(false);
        }}
        onClose={() => setDrawer(false)}
      />
      <div className="scrim" onClick={() => setDrawer(false)} />
      <main className="main">
        {active && active.kind === 'chat' ? (
          <ChatView key={active.id} session={active} onMenu={() => setDrawer(true)} onError={showError} onDeleted={() => select(null)} />
        ) : active ? (
          <TerminalView
            key={active.id}
            session={active}
            onMenu={() => setDrawer(true)}
            onError={showError}
            onDeleted={() => select(null)}
          />
        ) : (
          <Empty onMenu={() => setDrawer(true)} hasSessions={sessions.length > 0} missing={!!activeId && sessions.length > 0} />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Empty({ onMenu, hasSessions, missing }) {
  return (
    <div className="empty">
      <div className="topbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </button>
        <div className="title">Claude Web</div>
      </div>
      <div className="empty-body">
        <div className="logo">&gt;_</div>
        <h2>{missing ? 'That session no longer exists' : 'No session selected'}</h2>
        <p>
          {hasSessions
            ? 'Pick a session from the sidebar, or start a new one in a project.'
            : 'Open a project in the sidebar and start a new chat. Claude keeps working on the server when you close this tab.'}
        </p>
        <button className="btn primary mobile-only" onClick={onMenu}>
          Open projects
        </button>
      </div>
    </div>
  );
}
