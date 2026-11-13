import React, { useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';
import { getThemePref, setThemePref } from './theme.js';

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

export default function Sidebar({ sessions, activeId, onSelect, onCreate, onNewChat, onHistory, onLogout, onClose, onCollapse }) {
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
      if (!!s.archived !== showArchived) return false;
      if (needle && !`${s.name} ${s.cwd}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const ids = new Set(visible.map((s) => s.id));
    const byProject = new Map();
    for (const s of visible) {
      const p = s.project || s.cwd;
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
      out.push({ path: p, name: baseName(p), rows, latest: Math.max(...list.map((s) => s.lastActivity)) });
    }
    return out.sort((a, b) => b.latest - a.latest);
  }, [sessions, q, showArchived]);

  const archivedCount = sessions.filter((s) => s.archived).length;
  const cap = (t) => t[0].toUpperCase() + t.slice(1);

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand">
          <span className="mark sm">&gt;_</span> Claude Web
        </div>
        <button className="icon-btn hide-mobile" title="Hide sidebar" onClick={onCollapse}>
          ⇤
        </button>
        <button className="icon-btn close-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <button className="side-new" onClick={onNewChat}>
        <span className="plus">+</span> New chat
      </button>
      <div className="side-search">
        <span className="s-ico">⌕</span>
        <input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="side-scroll">
        {groups.length === 0 && <div className="side-empty">{q ? 'No matching chats' : showArchived ? 'No archived chats' : 'No chats yet. Start one with New chat.'}</div>}
        {groups.map((g) => (
          <div key={g.path} className="group">
            <div className="group-head">
              <span className="chev" onClick={() => toggleGroup(g.path)}>
                {collapsed[g.path] ? '▸' : '▾'}
              </span>
              <span className="gname" title={g.path} onClick={() => toggleGroup(g.path)}>
                {g.name}
              </span>
              <button className="icon-btn" title={`New chat in ${g.name}`} onClick={() => onCreate({ cwd: g.path, kind: 'chat' })}>
                +
              </button>
              <div className="menu-wrap">
                <button className={`icon-btn ${menu === g.path ? 'keep' : ''}`} title="More" onClick={() => setMenu(menu === g.path ? null : g.path)}>
                  ⋯
                </button>
                {menu === g.path && <ProjectMenu path={g.path} onClose={() => setMenu(null)} onCreate={onCreate} onHistory={onHistory} />}
              </div>
            </div>
            {!collapsed[g.path] &&
              g.rows.map(({ s, depth }) => (
                <button
                  key={s.id}
                  className={`session-row ${s.id === activeId ? 'active' : ''} ${depth ? 'child' : ''}`}
                  style={depth > 1 ? { paddingLeft: 26 + (depth - 1) * 14 } : undefined}
                  onClick={() => onSelect(s.id)}
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
                </button>
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
          <button className="icon-btn" title="Theme" onClick={() => setMenu(menu === 'theme' ? null : 'theme')}>
            ◐ <span className="lbl">{cap(theme)}</span>
          </button>
          {menu === 'theme' && (
            <div className="pop up">
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
            </div>
          )}
        </div>
        <span className="spacer" />
        <button className="btn small ghost" onClick={onLogout}>
          Log out
        </button>
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
    <div className="pop down">
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
    </div>
  );
}

export function NewChatDialog({ projects, onCreate, onClose, onReloadProjects, onError, onHistory }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [worktree, setWorktree] = useState(false);
  const [newName, setNewName] = useState(null);
  const list = projects.projects.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const selProject = projects.projects.find((x) => x.path === sel);

  const create = async (e) => {
    e.preventDefault();
    try {
      const { path } = await api('/api/projects', { method: 'POST', body: { name: newName } });
      setNewName(null);
      await onReloadProjects();
      setSel(path);
    } catch (err) {
      onError(err);
    }
  };

  const start = (p = sel) => {
    if (!p) return;
    const git = projects.projects.find((x) => x.path === p)?.git;
    onCreate({ cwd: p, kind: 'chat', worktree: worktree && !!git });
    onClose();
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">New chat</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="label">Choose a folder</span>
          <input className="field" autoFocus placeholder={`Search ${projects.root}`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && list.length === 1 && start(list[0].path)} />
          <div className="pick-list">
            {list.map((p) => (
              <button key={p.path} className={sel === p.path ? 'on' : ''} onClick={() => setSel(p.path)} onDoubleClick={() => start(p.path)}>
                <span className="muted">▢</span>
                <span className="pl-name">{p.name}</span>
                {p.git && <span className="tag">git</span>}
              </button>
            ))}
            {list.length === 0 && <div className="pad muted">No folders match</div>}
          </div>
          {newName === null ? (
            <button className="link-btn" onClick={() => setNewName('')}>
              + Create a new folder
            </button>
          ) : (
            <form className="row" onSubmit={create}>
              <input className="field" autoFocus placeholder="new-project" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button className="btn small">Create</button>
            </form>
          )}
          <label className="toggle" style={selProject && !selProject.git ? { opacity: 0.5 } : undefined} title="Needs a git repository">
            <input type="checkbox" checked={worktree} disabled={selProject && !selProject.git} onChange={(e) => setWorktree(e.target.checked)} />
            Work in an isolated git worktree (own branch)
          </label>
        </div>
        <div className="modal-foot">
          {sel && (
            <button className="btn ghost" onClick={() => (onClose(), onHistory(sel))}>
              Resume a past conversation…
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sel} onClick={() => start()}>
            Start chat
          </button>
        </div>
      </div>
    </div>
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
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">Past conversations · {baseName(path)}</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
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
      </div>
    </div>
  );
}
