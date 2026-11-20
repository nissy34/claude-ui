import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, wsUrl } from './api.js';
import Login from './Login.jsx';
import Sidebar, { HistoryDialog } from './Sidebar.jsx';
import NewChat from './NewChat.jsx';
import TerminalView from './TerminalView.jsx';
import ChatView from './chat/ChatView.jsx';
import Settings, { Shortcuts } from './Settings.jsx';
import { newChatDefaults } from './prefs.js';
import ArtifactsGallery from './ArtifactsGallery.jsx';
import SigninWindow from './SigninWindow.jsx';
import { setBrowserAvailable } from './chat/McpAuth.jsx';
import Scheduled from './Scheduled.jsx';
import ProjectView, { MoveToProjectDialog, ThreadBar, ThreadConversation } from './project/ProjectView.jsx';
import { NewProjectDialog } from './project/ProjectSettings.jsx';

function readHash() {
  const m = location.hash.match(/s=([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
// #p=<project id>[&tab=overview|settings]: a Project (coordinator chat + threads).
function readProjectHash() {
  const m = location.hash.match(/p=(prj_[\w]+)/);
  const t = location.hash.match(/tab=(\w+)/);
  const th = location.hash.match(/[&#]t=([\w-]+)/);
  return m ? { id: m[1], tab: t ? t[1] : null, thread: th ? th[1] : null } : null;
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState({ root: '', projects: [] });
  const [activeId, setActiveId] = useState(readHash);
  const [projectRoute, setProjectRoute] = useState(readProjectHash);
  const [cprojects, setCprojects] = useState([]);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('cw.sidebar') === 'hidden';
    } catch {
      return false;
    }
  });
  const [signin, setSignin] = useState(null); // { open, active } for the sign-in window
  const [signinPages, setSigninPages] = useState([]);
  const [signinInfos, setSigninInfos] = useState({});
  const closeSignin = useCallback(() => setSignin(null), []);
  useEffect(() => {
    const show = () => {
      api('/api/signin-pages')
        .then((r) => setSigninPages(r.pages || []))
        .catch(() => {});
      setSignin((s) => ({ open: true, active: s?.active }));
    };
    window.addEventListener('cw-show-signin', show);
    return () => window.removeEventListener('cw-show-signin', show);
  }, []);
  const [dialog, setDialog] = useState(null); // {type:'new'} | {type:'history', path} | {type:'settings'} | {type:'keys'}
  const [toast, setToast] = useState('');
  const [newKey, setNewKey] = useState(0); // bumps to focus the New chat composer
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
        else if (msg.t === 'cprojects') {
          setCprojects(msg.projects);
          if (msg.changed?.length) window.dispatchEvent(new CustomEvent('cw-cproject-changed', { detail: msg.changed }));
        } else if (msg.t === 'cproject-notify') notifyUser(msg.title, msg.body || '');
        else if (msg.t === 'signin-page') {
          setSigninInfos((m) => ({ ...m, [msg.id]: msg }));
          setSignin({ open: true, active: msg.id });
          notifyUser('Sign-in page opened', `${msg.server || msg.host}${msg.from ? ` · ${msg.from.name}` : ''}`);
        } else if (msg.t === 'signin-pages') setSigninPages(msg.pages || []); else if (msg.t === 'error') showError(new Error(msg.error));
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
    api('/api/config')
      .then((c) => setBrowserAvailable(!!c.browser))
      .catch(() => {});
    return () => {
      closed = true;
      clearTimeout(timer);
      eventsRef.current?.close();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [authed, loadProjects]);

  useEffect(() => {
    const onHash = () => {
      setActiveId(readHash());
      setProjectRoute(readProjectHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((id) => {
    location.hash = id ? `s=${id}` : '';
    setActiveId(id);
    setProjectRoute(null);
    setDrawer(false);
  }, []);
  const openProject = useCallback((id, tab) => {
    location.hash = `p=${id}${tab ? `&tab=${tab}` : ''}`;
    setProjectRoute({ id, tab: tab || null });
    setActiveId(null);
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

  // New chat is the home page (composer with the folder/environment picker under it).
  const newChat = useCallback(() => {
    setDialog(null);
    select(null);
    setNewKey((k) => k + 1);
  }, [select]);

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
        const list = sessions.filter((x) => !x.archived && x.kind !== 'shell' && !x.cproject);
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
        newChat();
      } else if (e.key === 'b') {
        e.preventDefault();
        setSidebarHidden(!collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, dialog, sessions, activeId, select, newChat]);

  const active = sessions.find((s) => s.id === activeId) || null;

  useEffect(() => {
    const waiting = sessions.filter((s) => !s.cproject && (s.state === 'waiting' || s.attention)).length + cprojects.reduce((n, p) => n + (p.attention || 0), 0);
    document.title = `${waiting ? `(${waiting}) ` : ''}${active ? active.name + ' · ' : ''}Claude Web`;
  }, [active, sessions, cprojects]);

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
        onNewChat={newChat}
        onHistory={(path) => setDialog({ type: 'history', path })}
        onSettings={() => (setDrawer(false), setDialog({ type: 'settings' }))}
        onCustomize={() => (setDrawer(false), setDialog({ type: 'settings', tab: 'plugins' }))}
        onArtifacts={() => (setDrawer(false), setDialog({ type: 'artifacts' }))}
        onScheduled={() => (setDrawer(false), setDialog({ type: 'scheduled' }))}
        cprojects={cprojects}
        activeProjectId={projectRoute?.id}
        onOpenProject={(id, tab) => openProject(id, tab)}
        onNewProject={() => (setDrawer(false), setDialog({ type: 'new-project' }))}
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
        {projectRoute && !active ? (
          <ProjectView key={projectRoute.id} projectId={projectRoute.id} tab={projectRoute.tab} thread={projectRoute.thread} projects={projects} onSelect={select} onCreate={createSession} onMenu={openMenu} onError={showError} onDeleted={() => select(null)} />
        ) : active && active.kind === 'chat' ? (
          <ChatView
            key={active.id}
            session={active}
            sessions={sessions}
            onSelect={select}
            onCreate={createSession}
            onSettings={(tab) => setDialog({ type: 'settings', tab })}
            projectBar={active.cproject ? ({ view, setView }) => <ThreadBar session={active} onSelect={select} onError={showError} view={view} setView={active.role === 'thread' ? setView : null} /> : null}
            projectConversation={active.cproject && active.role === 'thread' ? <ThreadConversation session={active} onSelect={select} onError={showError} /> : null}
            onMoveToProject={active.cproject ? null : () => setDialog({ type: 'move-project', session: active })}
            {...common}
          />
        ) : active ? (
          <TerminalView key={active.id} session={active} onCreate={createSession} onSelect={select} {...common} />
        ) : (
          <NewChat
            projects={projects}
            sessions={sessions}
            onCreate={createSession}
            onReloadProjects={loadProjects}
            onError={showError}
            onHistory={(path) => setDialog({ type: 'history', path })}
            onMenu={openMenu}
            missing={!!activeId && sessions.length > 0}
            focusKey={newKey}
          />
        )}
      </main>
      {signin?.open && (
        <SigninWindow pages={signinPages} active={signin.active} infos={signinInfos} onPick={(id) => setSignin({ open: true, active: id })} onClose={closeSignin} onError={showError} />
      )}
      {dialog?.type === 'history' && <HistoryDialog path={dialog.path} onCreate={createSession} onClose={() => setDialog(null)} onError={showError} />}
      {dialog?.type === 'settings' && <Settings initialTab={dialog.tab} projects={projects} activeCwd={active?.cwd} onClose={() => setDialog(null)} onError={showError} onKeys={() => setDialog({ type: 'keys' })} />}
      {dialog?.type === 'keys' && <Shortcuts onClose={() => setDialog(null)} />}
      {dialog?.type === 'move-project' && <MoveToProjectDialog session={dialog.session} onClose={() => setDialog(null)} onError={showError} onMoved={() => setDialog(null)} />}
      {dialog?.type === 'new-project' && (
        <NewProjectDialog
          projects={projects}
          defaultFolder={active?.project && !active.noFolder ? active.project : ''}
          onClose={() => setDialog(null)}
          onError={showError}
          onCreated={(p) => {
            setDialog(null);
            openProject(p.id);
          }}
        />
      )}
      {dialog?.type === 'artifacts' && (
        <ArtifactsGallery
          onClose={() => setDialog(null)}
          onError={showError}
          onOpen={(a) => {
            setDialog(null);
            location.hash = `s=${a.sessionId}&a=${encodeURIComponent(a.path)}`;
            setActiveId(a.sessionId);
          }}
          onOpenChat={(a) => {
            setDialog(null);
            select(a.sessionId);
          }}
        />
      )}
      {dialog?.type === 'scheduled' && (
        <Scheduled
          projects={projects}
          defaultCwd={active?.project || active?.cwd}
          onClose={() => setDialog(null)}
          onError={showError}
          onOpen={(id) => {
            setDialog(null);
            select(id);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function notifyUser(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
  } catch {}
}
