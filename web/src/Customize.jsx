import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const RESTART_NOTE = 'Changes apply to new chats, and to open chats after their next restart.';

export function ProjectPicker({ projects, value, onChange, allowNone = true }) {
  const options = [...new Set([value, ...projects.projects.map((p) => p.path)].filter(Boolean))];
  return (
    <select className="proj-pick" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">No project (user settings)</option>}
      {options.map((p) => (
        <option key={p} value={p}>
          {p.split(/[\\/]/).filter(Boolean).pop()} — {p}
        </option>
      ))}
    </select>
  );
}

function Toggle({ value, onChange, disabled }) {
  return <button className={`toggle ${value ? 'on' : ''}`} role="switch" aria-checked={value} disabled={disabled} onClick={() => onChange(!value)} />;
}

function useAction(onError, reload) {
  const [busy, setBusy] = useState('');
  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
      await reload?.();
      return true;
    } catch (e) {
      onError(e);
      return false;
    } finally {
      setBusy('');
    }
  };
  return [busy, run];
}

// ---------- MCP servers ----------
function serverSummary(c) {
  if (c.url) return `${c.type || 'http'} · ${c.url}`;
  return [c.command, ...(c.args || [])].join(' ');
}

function AddServer({ cwd, onDone, onError }) {
  const [f, setF] = useState({ name: '', transport: 'stdio', command: '', url: '', env: '', headers: '', scope: cwd ? 'local' : 'user' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pairs = (txt, sep) =>
    Object.fromEntries(
      txt
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(sep);
          return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  const submit = async (e) => {
    e.preventDefault();
    let server;
    if (f.transport === 'stdio') {
      const parts = f.command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
      if (!parts.length) return onError(new Error('Enter the command to run'));
      server = { type: 'stdio', command: parts[0].replace(/^["']|["']$/g, ''), args: parts.slice(1).map((a) => a.replace(/^["']|["']$/g, '')) };
      if (f.env.trim()) server.env = pairs(f.env, '=');
    } else {
      if (!f.url.trim()) return onError(new Error('Enter the server URL'));
      server = { type: f.transport, url: f.url.trim() };
      if (f.headers.trim()) server.headers = pairs(f.headers, ':');
    }
    setBusy(true);
    try {
      await api('/api/claude/mcp-servers/add', { method: 'POST', body: { cwd, name: f.name.trim(), scope: f.scope, server } });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-form" onSubmit={submit}>
      <div className="form-grid">
        <label>Name</label>
        <input value={f.name} onChange={set('name')} placeholder="github" required />
        <label>Type</label>
        <select value={f.transport} onChange={set('transport')}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote (HTTP)</option>
          <option value="sse">Remote (SSE)</option>
        </select>
        {f.transport === 'stdio' ? (
          <>
            <label>Command</label>
            <input value={f.command} onChange={set('command')} placeholder="npx -y @modelcontextprotocol/server-filesystem /path" />
            <label>Environment</label>
            <textarea rows={2} value={f.env} onChange={set('env')} placeholder={'API_KEY=…\nOne per line'} />
          </>
        ) : (
          <>
            <label>URL</label>
            <input value={f.url} onChange={set('url')} placeholder="https://mcp.example.com/mcp" />
            <label>Headers</label>
            <textarea rows={2} value={f.headers} onChange={set('headers')} placeholder={'Authorization: Bearer …\nOne per line'} />
          </>
        )}
        <label>Available in</label>
        <select value={f.scope} onChange={set('scope')}>
          <option value="user">All projects (user)</option>
          <option value="local" disabled={!cwd}>
            This project, just me (local)
          </option>
          <option value="project" disabled={!cwd}>
            This project, shared in .mcp.json (project)
          </option>
        </select>
      </div>
      <div className="row end">
        <button type="button" className="btn small" onClick={onDone}>
          Cancel
        </button>
        <button className="btn small primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add server'}
        </button>
      </div>
      <p className="muted set-note">Servers that need a browser sign-in (OAuth) finish it with “claude mcp login” in a terminal session.</p>
    </form>
  );
}

export function McpTab({ projects, activeCwd, onError }) {
  const [cwd, setCwd] = useState(activeCwd || '');
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api(`/api/claude/mcp-servers${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
      .then(setData)
      .catch((e) => (setData({ servers: [] }), onError(e)));
  useEffect(() => {
    setData(null);
    load();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, run] = useAction(onError, load);
  const post = (action, body) => api(`/api/claude/mcp-servers/${action}`, { method: 'POST', body: { cwd, ...body } });
  return (
    <>
      <div className="tab-top">
        <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
        {!adding && (
          <button className="btn small primary" onClick={() => setAdding(true)}>
            + Add server
          </button>
        )}
      </div>
      {adding && (
        <AddServer
          cwd={cwd}
          onError={onError}
          onDone={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      <p className="muted set-note">{RESTART_NOTE} Every chat also gets the built-in sessions and browser servers.</p>
      {!data && <div className="muted">Checking servers… (they are health-checked, which can take a few seconds)</div>}
      {data?.servers.length === 0 && <div className="empty-box">No MCP servers yet.</div>}
      <div className="item-list">
        {data?.servers.map((s) => (
          <div key={s.scope + s.name} className="item">
            <span className={`dot ${/connected|✓/i.test(s.status) ? 'on' : /disabled/.test(s.status) ? 'off' : /pending|needs/i.test(s.status) ? 'busy' : 'err'}`} />
            <div className="item-main">
              <div className="item-title">
                {s.name} <span className="tag">{s.scope}</span>
              </div>
              <div className="item-sub" title={serverSummary(s.config)}>
                {serverSummary(s.config)}
              </div>
              <div className="item-sub">{s.status}</div>
            </div>
            <Toggle value={s.enabled} disabled={!cwd || busy === s.name} onChange={(v) => run(s.name, () => post('toggle', { name: s.name, enabled: v }))} />
            <button
              className="icon-btn"
              title="Remove"
              disabled={busy === s.name}
              onClick={() => window.confirm(`Remove the MCP server "${s.name}" (${s.scope})?`) && run(s.name, () => post('remove', { name: s.name, scope: s.scope }))}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
      {!cwd && data?.servers.length > 0 && <p className="muted set-note">Pick a project to turn servers on or off for it.</p>}
    </>
  );
}

// ---------- plugins ----------
export function PluginsTab({ onError }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState('installed');
  const [mkt, setMkt] = useState('');
  const load = () =>
    api('/api/claude/plugins-full')
      .then(setData)
      .catch((e) => (setData({ installed: [], available: [], marketplaces: [] }), onError(e)));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, run] = useAction(onError, load);
  const act = (action, id, scope) => run(id, () => api('/api/claude/plugins/action', { method: 'POST', body: { action, id, scope } }));
  const installedIds = new Set((data?.installed || []).map((p) => p.pluginId || p.id || p.name));
  const shown = useMemo(() => {
    const list = view === 'installed' ? data?.installed || [] : (data?.available || []).filter((p) => !installedIds.has(p.pluginId));
    const n = q.toLowerCase();
    return list.filter((p) => !n || `${p.name} ${p.pluginId || p.id} ${p.description || ''}`.toLowerCase().includes(n)).slice(0, 80);
  }, [data, q, view]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="tab-top">
        <div className="seg">
          <button className={view === 'installed' ? 'on' : ''} onClick={() => setView('installed')}>
            Installed{data ? ` (${data.installed.length})` : ''}
          </button>
          <button className={view === 'browse' ? 'on' : ''} onClick={() => setView('browse')}>
            Browse
          </button>
          <button className={view === 'marketplaces' ? 'on' : ''} onClick={() => setView('marketplaces')}>
            Marketplaces
          </button>
        </div>
        {view !== 'marketplaces' && <input className="search-in" placeholder="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      <p className="muted set-note">{RESTART_NOTE}</p>
      {!data && <div className="muted">Loading plugins…</div>}
      {data?.error && <pre className="set-pre">{data.error}</pre>}
      {view === 'marketplaces' ? (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              run('mkt', () => api('/api/claude/marketplaces/action', { method: 'POST', body: { action: 'add', source: mkt } })).then((ok) => ok && setMkt(''));
            }}
          >
            <input className="search-in" style={{ flex: 1 }} value={mkt} onChange={(e) => setMkt(e.target.value)} placeholder="owner/repo, git URL or local path" />
            <button className="btn small primary" disabled={!mkt.trim() || busy === 'mkt'}>
              {busy === 'mkt' ? 'Adding…' : 'Add marketplace'}
            </button>
          </form>
          <div className="item-list">
            {(data?.marketplaces || []).map((m) => {
              const name = m.name || m.id || String(m);
              return (
                <div key={name} className="item">
                  <div className="item-main">
                    <div className="item-title">{name}</div>
                    <div className="item-sub">{m.source ? JSON.stringify(m.source) : m.url || m.path || ''}</div>
                  </div>
                  <button className="btn small" disabled={!!busy} onClick={() => run(name, () => api('/api/claude/marketplaces/action', { method: 'POST', body: { action: 'update', name } }))}>
                    Update
                  </button>
                  <button className="icon-btn" title="Remove" onClick={() => window.confirm(`Remove marketplace ${name}?`) && run(name, () => api('/api/claude/marketplaces/action', { method: 'POST', body: { action: 'remove', name } }))}>
                    🗑
                  </button>
                </div>
              );
            })}
            {data && !data.marketplaces?.length && <div className="empty-box">No extra marketplaces. The built-in plugin directory is always available under Browse.</div>}
          </div>
        </>
      ) : (
        <div className="item-list">
          {data && shown.length === 0 && <div className="empty-box">{view === 'installed' ? 'No plugins installed yet. Find some under Browse.' : 'No matches.'}</div>}
          {shown.map((p) => {
            const id = p.pluginId || p.id || p.name;
            const enabled = p.enabled !== false;
            return (
              <div key={id + (p.scope || '')} className="item">
                <div className="item-main">
                  <div className="item-title">
                    {p.name || id} {p.version && <span className="tag">v{p.version}</span>} {p.scope && <span className="tag">{p.scope}</span>}
                  </div>
                  <div className="item-sub wrap">{p.description || id}</div>
                </div>
                {view === 'installed' ? (
                  <>
                    <Toggle value={enabled} disabled={busy === id} onChange={(v) => act(v ? 'enable' : 'disable', id, p.scope)} />
                    <button className="btn small" disabled={busy === id} onClick={() => act('update', id)}>
                      Update
                    </button>
                    <button className="icon-btn" title="Uninstall" disabled={busy === id} onClick={() => window.confirm(`Uninstall ${p.name || id}?`) && act('uninstall', id, p.scope)}>
                      🗑
                    </button>
                  </>
                ) : (
                  <button className="btn small primary" disabled={busy === id} onClick={() => act('install', id, 'user')}>
                    {busy === id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- skills ----------
const TEMPLATE = (name) => `---
name: ${name}
description: One line on when Claude should use this skill.
---

# ${name}

Steps Claude should follow…
`;

export function SkillsTab({ projects, activeCwd, onError }) {
  const [cwd, setCwd] = useState(activeCwd || '');
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // {scope,id,content,create}
  const load = () =>
    api(`/api/claude/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
      .then((r) => setList(r.skills))
      .catch((e) => (setList([]), onError(e)));
  useEffect(() => {
    load();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, run] = useAction(onError, load);
  const post = (action, body) => api(`/api/claude/skills/${action}`, { method: 'POST', body: { cwd, ...body } });

  if (edit)
    return (
      <div className="skill-edit">
        <div className="tab-top">
          {edit.create ? (
            <>
              <input className="search-in" value={edit.id} placeholder="skill-name" onChange={(e) => setEdit({ ...edit, id: e.target.value.replace(/[^\w.-]/g, '-') })} />
              <select className="proj-pick" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}>
                <option value="user">All projects</option>
                <option value="project" disabled={!cwd}>
                  This project
                </option>
              </select>
            </>
          ) : (
            <b style={{ flex: 1 }}>
              {edit.id} <span className="tag">{edit.scope}</span>
            </b>
          )}
        </div>
        <textarea className="skill-text" value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} spellCheck={false} />
        <div className="row end">
          <button className="btn small" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <button
            className="btn small primary"
            disabled={!edit.id || busy === 'save'}
            onClick={() => run('save', () => post('save', edit)).then((ok) => ok && setEdit(null))}
          >
            Save skill
          </button>
        </div>
      </div>
    );

  return (
    <>
      <div className="tab-top">
        <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
        <button className="btn small primary" onClick={() => setEdit({ scope: 'user', id: '', content: TEMPLATE('my-skill'), create: true })}>
          + New skill
        </button>
      </div>
      <p className="muted set-note">Skills are folders with a SKILL.md in ~/.claude/skills (all projects) or .claude/skills (one project). Plugin skills are managed under Plugins. {RESTART_NOTE}</p>
      {!list && <div className="muted">Loading…</div>}
      {list?.length === 0 && <div className="empty-box">No skills yet.</div>}
      <div className="item-list">
        {list?.map((s) => (
          <div key={s.scope + s.id} className="item">
            <div className="item-main">
              <div className="item-title">
                {s.name} <span className="tag">{s.scope}</span>
              </div>
              <div className="item-sub wrap">{s.description}</div>
            </div>
            <Toggle value={s.enabled} disabled={busy === s.id} onChange={(v) => run(s.id, () => post('toggle', { scope: s.scope, id: s.id, enabled: v }))} />
            <button className="btn small" onClick={() => post('get', { scope: s.scope, id: s.id }).then((r) => setEdit({ scope: s.scope, id: s.id, content: r.content })).catch(onError)}>
              Edit
            </button>
            <button className="icon-btn" title="Delete" onClick={() => window.confirm(`Delete the skill "${s.name}"? It's moved to a .trash folder next to it.`) && run(s.id, () => post('delete', { scope: s.scope, id: s.id }))}>
              🗑
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
