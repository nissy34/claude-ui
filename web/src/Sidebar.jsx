import React, { useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';

function dotState(s) {
  if (s.kind === 'chat') {
    if (s.state === 'waiting' || s.attention) return ['attn', s.state === 'waiting' ? 'Waiting for you' : 'New activity'];
    if (s.state === 'busy') return ['busy', 'Working'];
    return s.live ? ['on', 'Idle'] : ['off', 'Sleeping (resumes on next message)'];
  }
  if (s.status !== 'running') return ['off', 'Exited'];
  return s.attention ? ['attn', 'Needs attention'] : ['on', 'Running'];
}

function isActive(s) {
  return s.kind === 'chat' ? s.state !== 'idle' || s.attention || s.live : s.status === 'running';
}

function StatusDot({ s }) {
  const [cls, title] = dotState(s);
  return <span className={`dot ${cls}`} title={title} />;
}

export default function Sidebar({ sessions, projects, activeId, onSelect, onCreate, onReloadProjects, onError, onLogout, onClose }) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('cw.expanded') || '{}');
    } catch {
      return {};
    }
  });
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState({}); // path -> {loading, items}
  const [newProject, setNewProject] = useState(null);
  const [openPath, setOpenPath] = useState('');

  const toggle = (p) => {
    const next = { ...expanded, [p]: !expanded[p] };
    setExpanded(next);
    try {
      localStorage.setItem('cw.expanded', JSON.stringify(next));
    } catch {}
  };

  const byCwd = useMemo(() => {
    const m = {};
    for (const s of sessions) (m[s.cwd] ||= []).push(s);
    return m;
  }, [sessions]);

  const running = sessions.filter(isActive);

  const list = projects.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  const loadHistory = async (path) => {
    if (history[path]?.items) {
      setHistory((h) => ({ ...h, [path]: null }));
      return;
    }
    setHistory((h) => ({ ...h, [path]: { loading: true } }));
    try {
      const { conversations } = await api(`/api/history?cwd=${encodeURIComponent(path)}`);
      setHistory((h) => ({ ...h, [path]: { items: conversations } }));
    } catch (e) {
      setHistory((h) => ({ ...h, [path]: null }));
      onError(e);
    }
  };

  const createProject = async (e) => {
    e.preventDefault();
    try {
      const { path } = await api('/api/projects', { method: 'POST', body: { name: newProject } });
      setNewProject(null);
      onReloadProjects();
      setExpanded((x) => ({ ...x, [path]: true }));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand">
          <span className="logo-sm">&gt;_</span> Claude Web
        </div>
        <button className="icon-btn" title="New project folder" onClick={() => setNewProject(newProject === null ? '' : null)}>
          ＋
        </button>
        <button className="icon-btn close-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {newProject !== null && (
        <form className="inline-form" onSubmit={createProject}>
          <input autoFocus placeholder="new-project-name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
          <button className="btn small primary">Create</button>
        </form>
      )}

      {running.length > 0 && (
        <div className="section">
          <div className="section-title">Active</div>
          {running.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={onSelect} showProject />
          ))}
        </div>
      )}

      <div className="section grow">
        <div className="section-title">
          Projects
          <input className="filter" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="project-list">
          {list.map((p) => {
            const open = !!expanded[p.path];
            const ss = byCwd[p.path] || [];
            const h = history[p.path];
            return (
              <div key={p.path} className={`project ${open ? 'open' : ''}`}>
                <button className="project-row" onClick={() => toggle(p.path)}>
                  <span className="chev">{open ? '▾' : '▸'}</span>
                  <span className="pname">{p.name}</span>
                  {ss.some(isActive) && <span className="dot on small" />}
                  {ss.length > 0 && <span className="count">{ss.length}</span>}
                </button>
                {open && (
                  <div className="project-body">
                    <div className="actions">
                      <button className="btn small primary" onClick={() => onCreate({ cwd: p.path, kind: 'chat' })}>
                        New chat
                      </button>
                      <button className="btn small" title="Resume the most recent conversation here" onClick={() => onCreate({ cwd: p.path, kind: 'chat', resume: 'continue' })}>
                        Continue
                      </button>
                      <button className="btn small" title="The interactive claude TUI in a terminal" onClick={() => onCreate({ cwd: p.path, kind: 'claude' })}>
                        Terminal
                      </button>
                      <button className="btn small" onClick={() => onCreate({ cwd: p.path, kind: 'shell' })}>
                        Shell
                      </button>
                      <button className={`btn small ${h?.items ? 'on' : ''}`} onClick={() => loadHistory(p.path)}>
                        History
                      </button>
                    </div>
                    {ss.map((s) => (
                      <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={onSelect} />
                    ))}
                    {h?.loading && <div className="muted pad">Loading…</div>}
                    {h?.items && (
                      <div className="history">
                        {h.items.length === 0 && <div className="muted pad">No past conversations</div>}
                        {h.items.map((c) => (
                          <button
                            key={c.id}
                            className="history-row"
                            title={`Resume ${c.id}`}
                            onClick={() => onCreate({ cwd: p.path, kind: 'chat', resume: c.id, name: c.title.slice(0, 60) })}
                          >
                            <span className="htitle">{c.title}</span>
                            <span className="muted">{timeAgo(c.mtime)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {list.length === 0 && <div className="muted pad">No folders in {projects.root}</div>}
        </div>
      </div>

      <form
        className="inline-form open-path"
        onSubmit={(e) => {
          e.preventDefault();
          if (openPath.trim()) onCreate({ cwd: openPath.trim(), kind: 'chat' });
        }}
      >
        <input placeholder="Open path (relative to root)…" value={openPath} onChange={(e) => setOpenPath(e.target.value)} />
        <button className="btn small">Go</button>
      </form>

      <div className="side-foot">
        <span className="muted" title={projects.root}>
          {projects.root}
        </span>
        <button className="btn small ghost" onClick={onLogout}>
          Log out
        </button>
      </div>
    </aside>
  );
}

function SessionRow({ s, active, onSelect, showProject }) {
  const project = s.cwd.split('/').filter(Boolean).pop();
  return (
    <button className={`session-row ${active ? 'active' : ''}`} onClick={() => onSelect(s.id)}>
      <StatusDot s={s} />
      <span className="sname">
        {s.kind === 'shell' && <span className="tag">sh</span>}
        {s.kind === 'claude' && <span className="tag">tty</span>}
        {s.name}
        {showProject && s.name !== project && <span className="muted"> · {project}</span>}
      </span>
      <span className="muted when">{timeAgo(s.lastActivity)}</span>
    </button>
  );
}
