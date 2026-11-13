import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, wsUrl } from './api.js';
import Login from './Login.jsx';
import Sidebar, { NewChatDialog, HistoryDialog } from './Sidebar.jsx';
import TerminalView from './TerminalView.jsx';
import ChatView from './chat/ChatView.jsx';
import Settings, { Shortcuts } from './Settings.jsx';
import { newChatDefaults } from './prefs.js';
import ArtifactsGallery from './ArtifactsGallery.jsx';

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
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('cw.sidebar') === 'hidden';
    } catch {
      return false;
    }
  });
  const [dialog, setDialog] = useState(null); // {type:'new'} | {type:'history', path} | {type:'settings'} | {type:'keys'}
  const [toast, setToast] = useState('');
  const eventsRef = useRef(null);

  const showError = useCallback((e) => {
    if (e?.status === 401) return setAuthed(false);
    setToast(e?.message || String(e));
    setTimeout(() => setToast(''), 5000);
  }, []);

  useEffect(() => {
    api('/api/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));
  }, []);

  const loadProjects = useCallback(() => api('/api/projects').then(setProjects).catch(showError), [showError]);

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
        const again = () => {
          timer = setTimeout(connect, retry);
          retry = Math.min(retry * 2, 10000);
        };
        api('/api/me')
          .then((r) => (r.authed ? again() : setAuthed(false)))
          .catch(again);
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
    async (opts, { navigate = true } = {}) => {
      try {
        const { session } = await api('/api/sessions', { method: 'POST', body: newChatDefaults(opts) });
        setSessions((list) => [session, ...list.filter((s) => s.id !== session.id)]);
        if (navigate) select(session.id);
        return session;
      } catch (e) {
        showError(e);
        return null;
      }
    },
    [select, showError]
  );

  const setSidebarHidden = (v) => {
    setCollapsed(v);
    try {
      localStorage.setItem('cw.sidebar', v ? 'hidden' : 'shown');
    } catch {}
  };

  // Ctrl/Cmd+K: new chat, Ctrl/Cmd+B: toggle sidebar, Ctrl/Cmd+,: settings, Ctrl/Cmd+/: shortcuts.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && dialog && (dialog.type === 'settings' || dialog.type === 'keys')) return setDialog(null);
      // Alt+↑/↓: previous or next chat in the sidebar order (Ctrl+Tab belongs to the browser).
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = sessions.filter((x) => !x.archived && x.kind !== 'shell');
        const i = list.findIndex((x) => x.id === activeId);
        const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
        if (next) (e.preventDefault(), select(next.id));
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ',') {
        e.preventDefault();
        setDialog({ type: 'settings' });
      } else if (e.key === '/') {
        e.preventDefault();
        setDialog({ type: 'keys' });
      } else if (e.key === 'k') {
        e.preventDefault();
        setDialog({ type: 'new' });
      } else if (e.key === 'b') {
        e.preventDefault();
        setSidebarHidden(!collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, dialog, sessions, activeId, select]);

  const active = sessions.find((s) => s.id === activeId) || null;

  useEffect(() => {
    const waiting = sessions.filter((s) => s.state === 'waiting' || s.attention).length;
    document.title = `${waiting ? `(${waiting}) ` : ''}${active ? active.name + ' · ' : ''}Claude Web`;
  }, [active, sessions]);

  if (authed === null) return <div className="splash" />;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const openMenu = () => (window.matchMedia('(max-width: 860px)').matches ? setDrawer(true) : setSidebarHidden(false));
  const common = { onMenu: openMenu, onError: showError, onDeleted: () => select(null) };

  return (
    <div className={`app ${drawer ? 'drawer-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={select}
        onCreate={createSession}
        onNewChat={() => setDialog({ type: 'new' })}
        onHistory={(path) => setDialog({ type: 'history', path })}
        onSettings={() => (setDrawer(false), setDialog({ type: 'settings' }))}
        onCustomize={() => (setDrawer(false), setDialog({ type: 'settings', tab: 'plugins' }))}
        onArtifacts={() => (setDrawer(false), setDialog({ type: 'artifacts' }))}
        onError={showError}
        onLogout={async () => {
          await api('/api/logout', { method: 'POST' }).catch(() => {});
          setAuthed(false);
        }}
        onClose={() => setDrawer(false)}
        onCollapse={() => setSidebarHidden(true)}
      />
      <div className="scrim" onClick={() => setDrawer(false)} />
      <main className="main">
        {active && active.kind === 'chat' ? (
          <ChatView key={active.id} session={active} sessions={sessions} onSelect={select} onCreate={createSession} onSettings={(tab) => setDialog({ type: 'settings', tab })} {...common} />
        ) : active ? (
          <TerminalView key={active.id} session={active} onCreate={createSession} onSelect={select} {...common} />
        ) : (
          <Empty onMenu={openMenu} onNew={() => setDialog({ type: 'new' })} missing={!!activeId && sessions.length > 0} />
        )}
      </main>
      {dialog?.type === 'new' && (
        <NewChatDialog
          projects={projects}
          onCreate={createSession}
          onClose={() => setDialog(null)}
          onReloadProjects={loadProjects}
          onError={showError}
          onHistory={(path) => setDialog({ type: 'history', path })}
        />
      )}
      {dialog?.type === 'history' && <HistoryDialog path={dialog.path} onCreate={createSession} onClose={() => setDialog(null)} onError={showError} />}
      {dialog?.type === 'settings' && <Settings initialTab={dialog.tab} projects={projects} activeCwd={active?.cwd} onClose={() => setDialog(null)} onError={showError} onKeys={() => setDialog({ type: 'keys' })} />}
      {dialog?.type === 'keys' && <Shortcuts onClose={() => setDialog(null)} />}
      {dialog?.type === 'artifacts' && (
        <ArtifactsGallery
          onClose={() => setDialog(null)}
          onError={showError}
          onOpen={(a) => {
            setDialog(null);
            location.hash = `s=${a.sessionId}&a=${encodeURIComponent(a.path)}`;
            setActiveId(a.sessionId);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Empty({ onMenu, onNew, missing }) {
  return (
    <div className="empty">
      <div className="topbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </button>
      </div>
      <div className="empty-body">
        <span className="mark">&gt;_</span>
        <h2>{missing ? 'That chat no longer exists' : greeting()}</h2>
        <p>Start a chat in one of your projects. Claude keeps working on the server when you close this tab, and you can pick it up from any device.</p>
        <button className="btn primary" onClick={onNew}>
          New chat
        </button>
      </div>
    </div>
  );
}
