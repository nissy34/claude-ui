import React, { useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';
import { getThemePref, setThemePref } from './theme.js';
import { EnvironmentDialog, ClonePanel, envSummary, FolderIcon, EnvIcon, GitIcon } from './Environments.jsx';

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

export default function Sidebar({ sessions, activeId, onSelect, onCreate, onNewChat, onHistory, onSettings, onArtifacts, onScheduled, onCustomize, onLogout, onClose, onCollapse, onError }) {
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
  const rowAction = (s, action) => {
    setMenu(null);
    if (action === 'pin') patch(s, { pinned: !s.pinned });
    else if (action === 'unread') patch(s, { unread: true });
    else if (action === 'archive') patch(s, { archived: !s.archived });
    else if (action === 'rename') {
      const name = window.prompt('Rename chat', s.name);
      if (name) patch(s, { name });
    } else if (action === 'delete') {
      if (!window.confirm(`Delete "${s.name}"? Claude keeps its own transcript, so you can resume it later from Past conversations.`)) return;
      api(`/api/sessions/${s.id}`, { method: 'DELETE' })
        .then(() => s.id === activeId && onSelect(null))
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
        <button className="icon-btn" title="More" onClick={() => setMenu(menu === 'row:' + keyPrefix + s.id ? null : 'row:' + keyPrefix + s.id)}>
          ⋯
        </button>
        {menu === 'row:' + keyPrefix + s.id && (
          <div className="pop down">
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
          </div>
        )}
      </span>
    </div>
  );

  React.useEffect(() => {
    if (!menu) return;
    const onDown = (e) => !e.target.closest?.('.menu-wrap') && setMenu(null);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

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

      <nav className="side-nav">
        <button onClick={onNewChat} title="New chat (Ctrl+K)">
          <span className="nico">＋</span> New chat
        </button>
        <div className="side-search">
          <span className="s-ico">⌕</span>
          <input ref={searchRef} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
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
        {groups.length > 0 && !q && <div className="section-head">Projects</div>}
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
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={onSettings}>
          ⚙ <span className="lbl">Settings</span>
        </button>
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

const NO_FOLDER = '__none__';
const LAST_KEY = 'cw.lastFolder';

function lastFolder() {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

const ChatIcon = () => (
  <svg className="pl-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
const ENV = 'env:';

export function NewChatDialog({ projects, onCreate, onClose, onReloadProjects, onError, onHistory }) {
  const all = projects.projects;
  const [envs, setEnvs] = useState(null);
  const [q, setQ] = useState('');
  // Start on the folder or environment used last time (or "No folder"), else the most recently used folder.
  const [sel, setSel] = useState(() => {
    const last = lastFolder();
    if (last === NO_FOLDER || last?.startsWith(ENV) || (last && all.some((p) => p.path === last))) return last;
    return all.find((p) => p.lastUsed)?.path || NO_FOLDER;
  });
  const [worktree, setWorktree] = useState(false);
  const [newName, setNewName] = useState(null);
  const [cloning, setCloning] = useState(false);
  const [editEnv, setEditEnv] = useState(null); // {} for new, env object to edit
  React.useEffect(() => {
    api('/api/environments')
      .then((r) => setEnvs(r.environments))
      .catch(() => setEnvs([]));
  }, []);
  // A remembered environment that was deleted falls back to the newest folder.
  React.useEffect(() => {
    if (envs && sel?.startsWith(ENV) && !envs.some((e) => ENV + e.id === sel)) setSel(all.find((p) => p.lastUsed)?.path || NO_FOLDER);
  }, [envs]);
  const needle = q.trim().toLowerCase();
  const list = all.filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const envList = (envs || []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
  const showNone = !needle || 'no folder'.includes(needle);
  const showSearch = all.length + (envs?.length || 0) > 6;
  const selProject = all.find((x) => x.path === sel);
  const selEnv = sel?.startsWith(ENV) ? envs?.find((e) => ENV + e.id === sel) : null;
  const noFolder = sel === NO_FOLDER;

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

  const remember = (p) => {
    try {
      localStorage.setItem(LAST_KEY, p);
    } catch {}
  };

  const start = (p = sel) => {
    if (!p || (p.startsWith(ENV) && !envs)) return;
    remember(p);
    if (p === NO_FOLDER) onCreate({ noFolder: true, kind: 'chat' });
    else if (p.startsWith(ENV)) onCreate({ envId: p.slice(ENV.length), kind: 'chat' });
    else onCreate({ cwd: p, kind: 'chat', worktree: worktree && !!all.find((x) => x.path === p)?.git });
    onClose();
  };

  const cloned = async (path) => {
    await onReloadProjects();
    remember(path);
    onCreate({ cwd: path, kind: 'chat' });
    onClose();
  };

  const envSaved = (env) => {
    setEnvs((l) => [...(l || []).filter((e) => e.id !== env.id), env].sort((a, b) => a.name.localeCompare(b.name)));
    setSel(ENV + env.id);
    setEditEnv(null);
  };

  const onSearchKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (needle && envList.length) start(ENV + envList[0].id);
    else if (needle && list.length) start(list[0].path);
    else if (needle && showNone) start(NO_FOLDER);
    else start();
  };

  const historyDir = noFolder ? projects.scratch : selEnv ? selEnv.folders[0] || projects.scratch : sel;

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card new-chat" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">New chat</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="label">Where should Claude work?</span>
          {showSearch && <input className="field" autoFocus placeholder="Search folders and environments" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} />}
          <div className="pick-list" role="listbox" aria-label="Folder">
            {showNone && (
              <button role="option" aria-selected={noFolder} className={noFolder ? 'on' : ''} onClick={() => setSel(NO_FOLDER)} onDoubleClick={() => start(NO_FOLDER)} autoFocus={!showSearch}>
                <ChatIcon />
                <span className="pl-name">
                  No folder
                  <span className="pl-sub">Just chat. Claude works in a scratch folder.</span>
                </span>
                <span className="pl-check">{noFolder ? '✓' : ''}</span>
              </button>
            )}
            {envList.length > 0 && (
              <>
                {showNone && <div className="pl-sep" />}
                <div className="pl-group">Environments</div>
                {envList.map((e) => {
                  const on = sel === ENV + e.id;
                  return (
                    <div key={e.id} className={`pl-env ${on ? 'on' : ''}`}>
                      <button role="option" aria-selected={on} className={on ? 'on' : ''} onClick={() => setSel(ENV + e.id)} onDoubleClick={() => start(ENV + e.id)}>
                        <EnvIcon />
                        <span className="pl-name">
                          {e.name}
                          <span className="pl-sub">{envSummary(e)}</span>
                        </span>
                        <span className="pl-check">{on ? '✓' : ''}</span>
                      </button>
                      <button className="pl-edit" onClick={() => setEditEnv(e)} aria-label={`Edit ${e.name}`} title="Edit environment">
                        ✎
                      </button>
                    </div>
                  );
                })}
                {list.length > 0 && <div className="pl-group">Folders</div>}
              </>
            )}
            {showNone && envList.length === 0 && list.length > 0 && <div className="pl-sep" />}
            {list.map((p) => (
              <button key={p.path} role="option" aria-selected={sel === p.path} className={sel === p.path ? 'on' : ''} onClick={() => setSel(p.path)} onDoubleClick={() => start(p.path)}>
                <FolderIcon />
                <span className="pl-name">{p.name}</span>
                {p.git && <span className="tag">git</span>}
                {p.lastUsed > 0 && <span className="pl-when">{timeAgo(p.lastUsed)}</span>}
                <span className="pl-check">{sel === p.path ? '✓' : ''}</span>
              </button>
            ))}
            {list.length === 0 && envList.length === 0 && !showNone && <div className="pad muted">Nothing matches</div>}
          </div>
          <div className="pl-foot">
            <span className="muted" title={projects.root}>
              {all.length === 0 ? 'No folders yet in ' : 'Folders in '}
              {projects.root}
            </span>
          </div>
          {!cloning && newName === null && (
            <div className="pl-actions">
              <button className="btn small" onClick={() => setNewName('')}>
                <FolderIcon /> New folder
              </button>
              <button className="btn small" onClick={() => setCloning(true)}>
                <GitIcon /> Clone from git
              </button>
              <button className="btn small" onClick={() => setEditEnv({})}>
                <EnvIcon /> New environment
              </button>
            </div>
          )}
          {newName !== null && (
            <form className="row" onSubmit={create}>
              <input className="field" autoFocus placeholder="new-project" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNewName(null))} />
              <button type="button" className="btn small" onClick={() => setNewName(null)}>
                Cancel
              </button>
              <button className="btn small">Create</button>
            </form>
          )}
          {cloning && <ClonePanel root={projects.root} onDone={cloned} onCancel={() => setCloning(false)} />}
          {projects.rootCaseHint && (
            <div className="pl-warn">
              The projects folder is set as <code>{projects.root}</code>, but your home folder is spelled with different capitals. Set <code>CW_PROJECTS_ROOT={projects.rootCaseHint}</code> in <code>.env</code> and restart, so these chats line up with Claude on your computer.
            </div>
          )}
          {selProject?.git && !cloning && (
            <div className="wt-row">
              <div className="wt-text">
                <div>Isolated worktree</div>
                <div className="desc">Claude works on its own branch, so your checkout stays untouched</div>
              </div>
              <button type="button" className={`toggle ${worktree ? 'on' : ''}`} role="switch" aria-checked={worktree} aria-label="Isolated worktree" onClick={() => setWorktree((w) => !w)} />
            </div>
          )}
        </div>
        <div className="modal-foot">
          {sel && historyDir && (
            <button className="btn ghost" onClick={() => (onClose(), onHistory(historyDir))}>
              Resume a past conversation…
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sel || cloning} onClick={() => start()}>
            Start chat
          </button>
        </div>
      </div>
      {editEnv && (
        <EnvironmentDialog
          env={editEnv.id ? editEnv : null}
          projects={projects}
          onSaved={envSaved}
          onDeleted={(id) => (setEnvs((l) => l.filter((e) => e.id !== id)), setEditEnv(null), sel === ENV + id && setSel(NO_FOLDER))}
          onClose={() => setEditEnv(null)}
          onError={onError}
        />
      )}
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
