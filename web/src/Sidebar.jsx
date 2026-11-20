import React, { useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';
import { getThemePref, setThemePref } from './theme.js';
import { Button, IconButton, Menu, Modal, ModalHead, useDismiss } from './ui/index.jsx';
import { promptDialog } from './ui/dialogs.jsx';
import { deleteChat } from './chat/deleteChat.js';
import { ProjectList } from './project/ProjectView.jsx';

function dotState(s) {
  if (s.kind === 'chat') {
    if (s.state === 'waiting' || s.attention) return ['attn', s.state === 'waiting' ? 'Waiting for you' : 'New activity'];
    if (s.state === 'busy') return ['busy', 'Working'];
    return s.live ? ['on', 'Idle'] : ['off', 'Sleeping (resumes on next message)'];
  }
  if (s.status !== 'running') return ['off', 'Exited'];
  return s.attention ? ['attn', 'Needs attention'] : ['on', 'Running'];
}

function StatusDot({ s }) {
  const [cls, title] = dotState(s);
  return <span className={`dot ${cls}`} title={title} />;
}

export function baseName(p) {
  return (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
}

export default function Sidebar({ sessions, activeId, onSelect, onCreate, onNewChat, onHistory, onSettings, onArtifacts, onScheduled, onCustomize, onLogout, onClose, onCollapse, onError, cprojects = [], activeProjectId, onOpenProject, onNewProject }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('cw.collapsed') || '{}');
    } catch {
      return {};
    }
  });
  const [menu, setMenu] = useState(null);
  const [theme, setTheme] = useState(getThemePref);

  const toggleGroup = (p) => {
    const next = { ...collapsed, [p]: !collapsed[p] };
    setCollapsed(next);
    try {
      localStorage.setItem('cw.collapsed', JSON.stringify(next));
    } catch {}
  };

  // Group by project, newest first; child sessions nest under their parent.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const visible = sessions.filter((s) => {
      if (s.kind === 'shell' && s.parentId) return false; // a chat's terminal drawer
      if (s.cproject && !needle) return false; // a Project's coordinator and threads live under Projects
      if (!!s.archived !== showArchived) return false;
      if (needle && !`${s.name} ${s.cwd}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const ids = new Set(visible.map((s) => s.id));
    const byId = new Map(visible.map((s) => [s.id, s]));
    // A child sits in its top parent's group, even when it runs in another folder (e.g. a chat in
    // ~ that starts children in ~/GitHub/x); otherwise it would land in a group without its parent.
    const rootOf = (s) => {
      const seen = new Set();
      while (s.parentId && byId.has(s.parentId) && !seen.has(s.id)) (seen.add(s.id), (s = byId.get(s.parentId)));
      return s;
    };
    const byProject = new Map();
    for (const s of visible) {
      const r = rootOf(s);
      const p = r.project || r.cwd;
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p).push(s);
    }
    const out = [];
    for (const [p, list] of byProject) {
      const children = new Map();
      const roots = [];
      for (const s of list) {
        if (s.parentId && ids.has(s.parentId)) {
          if (!children.has(s.parentId)) children.set(s.parentId, []);
          children.get(s.parentId).push(s);
        } else roots.push(s);
      }
      const rows = [];
      const add = (s, depth) => {
        rows.push({ s, depth });
        (children.get(s.id) || []).sort((a, b) => a.createdAt - b.createdAt).forEach((c) => add(c, depth + 1));
      };
      roots.sort((a, b) => b.lastActivity - a.lastActivity).forEach((s) => add(s, 0));
      out.push({ path: p, name: list[0] && rootOf(list[0]).noFolder ? 'No folder' : baseName(p), rows, latest: Math.max(...list.map((s) => s.lastActivity)) });
    }
    return out.sort((a, b) => b.latest - a.latest);
  }, [sessions, q, showArchived]);

  const archivedCount = sessions.filter((s) => s.archived).length;
  const pinned = useMemo(() => (showArchived || q ? [] : sessions.filter((s) => s.pinned && !s.archived && !(s.kind === 'shell' && s.parentId)).sort((a, b) => b.lastActivity - a.lastActivity)), [sessions, showArchived, q]);
  const searchRef = React.useRef(null);

  const patch = (s, body) => api(`/api/sessions/${s.id}`, { method: 'PATCH', body }).catch(onError);
  const rowAction = async (s, action) => {
    setMenu(null);
    if (action === 'pin') patch(s, { pinned: !s.pinned });
    else if (action === 'unread') patch(s, { unread: true });
    else if (action === 'archive') patch(s, { archived: !s.archived });
    else if (action === 'rename') {
      const name = await promptDialog('Rename chat', s.name);
      if (name) patch(s, { name });
    } else if (action === 'delete') {
      deleteChat(s, { name: s.name })
        .then((done) => done && s.id === activeId && onSelect(null))
        .catch(onError);
    }
  };

  const Row = ({ s, depth = 0, keyPrefix = '' }) => (
    <div
      key={keyPrefix + s.id}
      role="button"
      tabIndex={0}
      className={`session-row ${s.id === activeId ? 'active' : ''} ${depth ? 'child' : ''} ${menu === 'row:' + keyPrefix + s.id ? 'menu-open' : ''}`}
      style={depth > 1 ? { paddingLeft: 26 + (depth - 1) * 14 } : undefined}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(s.id)}
      onContextMenu={(e) => (e.preventDefault(), setMenu('row:' + keyPrefix + s.id))}
      title={s.cwd}
    >
      <StatusDot s={s} />
      <span className="sname">
        {s.kind === 'shell' && <span className="tag">sh</span>}
        {s.kind === 'claude' && <span className="tag">tty</span>}
        {s.worktree && (
          <span className="tag" title={s.worktree.branch}>
            wt
          </span>
        )}
        {s.name}
      </span>
      <span className="when">{timeAgo(s.lastActivity)}</span>
      <span className="menu-wrap row-menu" onClick={(e) => e.stopPropagation()}>
        <IconButton title="More" onClick={() => setMenu(menu === 'row:' + keyPrefix + s.id ? null : 'row:' + keyPrefix + s.id)}>
          ⋯
        </IconButton>
        {menu === 'row:' + keyPrefix + s.id && (
          <Menu place="down">
            <button onClick={() => rowAction(s, 'unread')}>
              Mark as unread <kbd>U</kbd>
            </button>
            <button onClick={() => rowAction(s, 'pin')}>
              {s.pinned ? 'Unpin' : 'Pin'} <kbd>P</kbd>
            </button>
            <button onClick={() => rowAction(s, 'rename')}>
              Rename <kbd>R</kbd>
            </button>
            <div className="sep" />
            <button onClick={() => rowAction(s, 'archive')}>
              {s.archived ? 'Unarchive' : 'Archive'} <kbd>A</kbd>
            </button>
            <button className="danger" onClick={() => rowAction(s, 'delete')}>
              Delete <kbd>D</kbd>
            </button>
          </Menu>
        )}
      </span>
    </div>
  );

  const asideRef = React.useRef(null);
  useDismiss(!!menu, () => setMenu(null), asideRef);

  // Shortcut letters work while a row's menu is open, like the desktop app.
  React.useEffect(() => {
    if (!menu?.startsWith('row:')) return;
    const id = menu.replace(/^row:(pin:)?/, '');
    const s = sessions.find((x) => x.id === id);
    const onKey = (e) => {
      const a = { u: 'unread', p: 'pin', r: 'rename', a: 'archive', d: 'delete' }[e.key.toLowerCase()];
      if (e.key === 'Escape') setMenu(null);
      else if (a && s && !e.metaKey && !e.ctrlKey) (e.preventDefault(), rowAction(s, a));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const cap = (t) => t[0].toUpperCase() + t.slice(1);

  return (
    <aside className="sidebar" ref={asideRef}>
      <div className="side-head">
        <div className="brand">
          <span className="mark sm">&gt;_</span> Claude Web
        </div>
        <IconButton className="hide-mobile" title="Hide sidebar" onClick={onCollapse}>
          ⇤
        </IconButton>
        <IconButton className="close-btn" onClick={onClose} aria-label="Close">
          ✕
        </IconButton>
      </div>

      <nav className="side-nav">
        <button onClick={onNewChat} title="New chat (Ctrl+K)">
          <span className="nico">＋</span> New chat
        </button>
        <div className="side-search">
          <span className="s-ico">⌕</span>
          <input ref={searchRef} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.preventDefault(), setQ(''), e.currentTarget.blur())} />
        </div>
        <button onClick={onArtifacts}>
          <span className="nico">◇</span> Artifacts
        </button>
        <button onClick={onScheduled}>
          <span className="nico">◷</span> Scheduled
        </button>
        <button onClick={onCustomize}>
          <span className="nico">⚒</span> Customize
        </button>
      </nav>

      <div className="side-scroll">
        {pinned.length > 0 && (
          <div className="group">
            <div className="section-head">Pinned</div>
            {pinned.map((s) => (
              <Row key={'pin:' + s.id} s={s} keyPrefix="pin:" />
            ))}
          </div>
        )}
        {!q && !showArchived && <ProjectList projects={cprojects} activeId={activeProjectId} onOpen={onOpenProject} onNew={onNewProject} onError={onError} onDeleted={() => onSelect(null)} />}
        {groups.length > 0 && !q && <div className="section-head">Chats</div>}
        {groups.length === 0 && !(cprojects.length && !q && !showArchived) && <div className="side-empty">{q ? 'No matching chats' : showArchived ? 'No archived chats' : 'No chats yet. Start one with New chat.'}</div>}
        {groups.map((g) => (
          <div key={g.path} className="group">
            <div className="group-head">
              <span className="chev" onClick={() => toggleGroup(g.path)}>
                {collapsed[g.path] ? '▸' : '▾'}
              </span>
              <span className="gname" title={g.path} onClick={() => toggleGroup(g.path)}>
                {g.name}
              </span>
              <IconButton title={`New chat in ${g.name}`} onClick={() => onCreate({ cwd: g.path, kind: 'chat' })}>
                +
              </IconButton>
              <div className="menu-wrap">
                <IconButton className={`${menu === g.path ? 'keep' : ''}`} title="More" onClick={() => setMenu(menu === g.path ? null : g.path)}>
                  ⋯
                </IconButton>
                {menu === g.path && <ProjectMenu path={g.path} onClose={() => setMenu(null)} onCreate={onCreate} onHistory={onHistory} />}
              </div>
            </div>
            {!collapsed[g.path] &&
              g.rows.map(({ s, depth }) => (
                <Row key={s.id} s={s} depth={depth} />
              ))}
          </div>
        ))}
        {(archivedCount > 0 || showArchived) && (
          <button className="show-arch" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '← Back to chats' : `Archived (${archivedCount})`}
          </button>
        )}
      </div>

      <div className="side-foot">
        <div className="menu-wrap">
          <IconButton title="Theme" onClick={() => setMenu(menu === 'theme' ? null : 'theme')}>
            ◐ <span className="lbl">{cap(theme)}</span>
          </IconButton>
          {menu === 'theme' && (
            <Menu place="up">
              {['system', 'light', 'dark'].map((t) => (
                <button
                  key={t}
                  className={t === theme ? 'on' : ''}
                  onClick={() => {
                    setThemePref(t);
                    setTheme(t);
                    setMenu(null);
                  }}
                >
                  <span className="check">{t === theme ? '✓' : ''}</span>
                  {cap(t)}
                </button>
              ))}
            </Menu>
          )}
        </div>
        <IconButton title="Settings (Ctrl+,)" onClick={onSettings}>
          ⚙ <span className="lbl">Settings</span>
        </IconButton>
        <span className="spacer" />
        <Button variant="ghost" size="sm" onClick={onLogout}>
          Log out
        </Button>
      </div>
    </aside>
  );
}

function ProjectMenu({ path, onClose, onCreate, onHistory }) {
  const go = (fn) => () => {
    onClose();
    fn();
  };
  return (
    <Menu place="down">
      <button onClick={go(() => onCreate({ cwd: path, kind: 'chat' }))}>New chat</button>
      <button onClick={go(() => onCreate({ cwd: path, kind: 'chat', worktree: true }))}>
        <span>
          New chat in a worktree<span className="desc">Own branch and folder, so edits don't collide</span>
        </span>
      </button>
      <button onClick={go(() => onCreate({ cwd: path, kind: 'chat', resume: 'continue' }))}>Continue last conversation</button>
      <button onClick={go(() => onHistory(path))}>Past conversations…</button>
      <div className="sep" />
      <button onClick={go(() => onCreate({ cwd: path, kind: 'claude' }))}>Claude in a terminal</button>
      <button onClick={go(() => onCreate({ cwd: path, kind: 'shell' }))}>Shell</button>
    </Menu>
  );
}

export function HistoryDialog({ path, onCreate, onClose, onError }) {
  const [items, setItems] = useState(null);
  React.useEffect(() => {
    api(`/api/history?cwd=${encodeURIComponent(path)}`)
      .then((r) => setItems(r.conversations))
      .catch((e) => {
        onError(e);
        onClose();
      });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal onClose={onClose}>
      <ModalHead title={<>Past conversations · {baseName(path)}</>} onClose={onClose} />
      <div className="modal-body" style={{ padding: 6, gap: 0 }}>
        {!items && <div className="pad muted">Loading…</div>}
        {items?.length === 0 && <div className="pad muted">No past Claude Code conversations in this folder.</div>}
        {items?.map((c) => (
          <button
            key={c.id}
            className="history-row"
            onClick={() => {
              onCreate({ cwd: path, kind: 'chat', resume: c.id, name: c.title.slice(0, 60) });
              onClose();
            }}
          >
            <span className="sname">{c.title}</span>
            <span className="when">{timeAgo(c.mtime)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
