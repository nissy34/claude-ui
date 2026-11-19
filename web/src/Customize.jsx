import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { McpLogins, PasteCallback } from './chat/McpAuth.jsx';

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

const SECRET_KEY = /pass|secret|token|key|auth|cred|pwd|pin/i;
const toRows = (obj) => Object.entries(obj || {}).map(([k, v]) => ({ k, v: String(v ?? '') }));
const fromRows = (rows) => Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
const quoteArg = (a) => (/[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a);
const b64 = (txt) => btoa(String.fromCharCode(...new TextEncoder().encode(txt)));
const unb64 = (txt) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(txt), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

// Pull a "Authorization: Basic/Bearer" header out into the sign-in fields so it can be edited as a username + password.
function splitAuth(headers) {
  const rows = toRows(headers);
  const i = rows.findIndex((r) => r.k.toLowerCase() === 'authorization');
  if (i < 0) return { rows, auth: { kind: 'none', user: '', pass: '', token: '' } };
  const v = rows[i].v.trim();
  const basic = /^basic\s+(.+)$/i.exec(v);
  const bearer = /^bearer\s+(.+)$/i.exec(v);
  const dec = basic && unb64(basic[1]);
  if (dec != null && dec.includes(':')) {
    rows.splice(i, 1);
    return { rows, auth: { kind: 'basic', user: dec.slice(0, dec.indexOf(':')), pass: dec.slice(dec.indexOf(':') + 1), token: '' } };
  }
  if (bearer) {
    rows.splice(i, 1);
    return { rows, auth: { kind: 'bearer', user: '', pass: '', token: bearer[1] } };
  }
  return { rows, auth: { kind: 'none', user: '', pass: '', token: '' } };
}

function SecretInput({ value, onChange, placeholder, secret = true, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <span className="secret-in">
      <input type={secret && !show ? 'password' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete || 'off'} spellCheck={false} />
      <button type="button" className="icon-btn" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} style={secret ? undefined : { visibility: 'hidden' }} tabIndex={secret ? 0 : -1}>
        {show ? '🙈' : '👁'}
      </button>
    </span>
  );
}

function KeyValueRows({ rows, onChange, keyPlaceholder, addLabel }) {
  const upd = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv-rows">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input value={r.k} onChange={(e) => upd(i, { k: e.target.value })} placeholder={keyPlaceholder} spellCheck={false} />
          <SecretInput value={r.v} onChange={(v) => upd(i, { v })} placeholder="value" secret={SECRET_KEY.test(r.k)} />
          <button type="button" className="icon-btn danger" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn small kv-add" onClick={() => onChange([...rows, { k: '', v: '' }])}>
        + {addLabel}
      </button>
    </div>
  );
}

function initForm(cwd, edit) {
  const c = edit?.config || {};
  const remote = !!c.url;
  const { rows, auth } = splitAuth(c.headers);
  return {
    name: edit?.name || '',
    transport: remote ? c.type || 'http' : 'stdio',
    command: remote ? '' : [c.command, ...(c.args || [])].filter(Boolean).map(quoteArg).join(' '),
    url: c.url || '',
    env: toRows(c.env),
    headers: rows,
    auth,
    scope: edit?.scope || (cwd ? 'local' : 'user'),
  };
}

function ServerForm({ cwd, edit, onDone, onError }) {
  const [f, setF] = useState(() => initForm(cwd, edit));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const put = (k, v) => setF({ ...f, [k]: v });
  const setAuth = (patch) => setF({ ...f, auth: { ...f.auth, ...patch } });
  const submit = async (e) => {
    e.preventDefault();
    // Keep settings this form doesn't show (timeouts, oauth, …) when editing.
    const { command, args, env, url, headers, type, ...rest } = edit?.config || {};
    let server;
    if (f.transport === 'stdio') {
      const parts = f.command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
      if (!parts.length) return onError(new Error('Enter the command to run'));
      server = { ...rest, type: 'stdio', command: parts[0].replace(/^["']|["']$/g, ''), args: parts.slice(1).map((a) => a.replace(/^["']|["']$/g, '')) };
      const envObj = fromRows(f.env);
      if (Object.keys(envObj).length) server.env = envObj;
    } else {
      if (!f.url.trim()) return onError(new Error('Enter the server URL'));
      server = { ...rest, type: f.transport, url: f.url.trim() };
      const h = fromRows(f.headers.filter((r) => !(f.auth.kind !== 'none' && r.k.trim().toLowerCase() === 'authorization')));
      if (f.auth.kind === 'basic') {
        if (!f.auth.user) return onError(new Error('Enter the username'));
        h.Authorization = `Basic ${b64(`${f.auth.user}:${f.auth.pass}`)}`;
      } else if (f.auth.kind === 'bearer') {
        if (!f.auth.token.trim()) return onError(new Error('Enter the token'));
        h.Authorization = `Bearer ${f.auth.token.trim()}`;
      }
      if (Object.keys(h).length) server.headers = h;
    }
    setBusy(true);
    try {
      await api(`/api/claude/mcp-servers/${edit ? 'update' : 'add'}`, { method: 'POST', body: { cwd, name: f.name.trim(), scope: f.scope, server } });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-form" onSubmit={submit} autoComplete="off">
      {edit && <div className="item-title">Edit {edit.name}</div>}
      <div className="form-grid">
        <label>Name</label>
        <input value={f.name} onChange={set('name')} placeholder="github" required disabled={!!edit} />
        <label>Type</label>
        <select value={f.transport} onChange={set('transport')}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote (HTTP)</option>
          <option value="sse">Remote (SSE)</option>
        </select>
        {f.transport === 'stdio' ? (
          <>
            <label>Command</label>
            <input value={f.command} onChange={set('command')} placeholder="npx -y @modelcontextprotocol/server-filesystem /path" spellCheck={false} />
            <label className="top">Environment</label>
            <div>
              <KeyValueRows rows={f.env} onChange={(v) => put('env', v)} keyPlaceholder="USERNAME" addLabel="Add variable" />
              <div className="muted form-hint">Usernames, passwords and API keys the server reads from its environment. Values for names like PASSWORD or TOKEN are hidden.</div>
            </div>
          </>
        ) : (
          <>
            <label>URL</label>
            <input value={f.url} onChange={set('url')} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
            <label>Sign-in</label>
            <select value={f.auth.kind} onChange={(e) => setAuth({ kind: e.target.value })}>
              <option value="none">None, or OAuth in a browser</option>
              <option value="basic">Username and password</option>
              <option value="bearer">API key / bearer token</option>
            </select>
            {f.auth.kind === 'basic' && (
              <>
                <label>Username</label>
                <input value={f.auth.user} onChange={(e) => setAuth({ user: e.target.value })} autoComplete="off" spellCheck={false} />
                <label>Password</label>
                <SecretInput value={f.auth.pass} onChange={(pass) => setAuth({ pass })} autoComplete="new-password" />
              </>
            )}
            {f.auth.kind === 'bearer' && (
              <>
                <label>Token</label>
                <SecretInput value={f.auth.token} onChange={(token) => setAuth({ token })} />
              </>
            )}
            <label className="top">Headers</label>
            <KeyValueRows rows={f.headers} onChange={(v) => put('headers', v)} keyPlaceholder="X-Api-Key" addLabel="Add header" />
          </>
        )}
        <label>Available in</label>
        <select value={f.scope} onChange={set('scope')} disabled={!!edit}>
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
          {busy ? 'Saving…' : edit ? 'Save' : 'Add server'}
        </button>
      </div>
      <p className="muted set-note">
        Saved in Claude Code’s own config ({f.scope === 'project' ? '.mcp.json in the project, which may be committed' : '~/.claude.json'}), the same place `claude mcp add` writes. Servers that need a browser sign-in (OAuth) can be signed in under Logins below, or from a chat’s + menu under Connectors.
      </p>
    </form>
  );
}

export function McpTab({ projects, activeCwd, onError }) {
  const [cwd, setCwd] = useState(activeCwd || '');
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
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
        {!adding && !editing && (
          <button className="btn small primary" onClick={() => setAdding(true)}>
            + Add server
          </button>
        )}
      </div>
      {(adding || editing) && (
        <ServerForm
          key={editing ? editing.scope + editing.name : 'new'}
          cwd={cwd}
          edit={editing}
          onError={onError}
          onDone={() => {
            setAdding(false);
            setEditing(null);
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
              title="Edit: command, URL, username and password, environment, headers"
              disabled={busy === s.name || (s.scope !== 'user' && !cwd)}
              onClick={() => {
                setAdding(false);
                setEditing(s);
                window.scrollTo?.({ top: 0, behavior: 'smooth' });
              }}
            >
              ✎
            </button>
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
      <McpLogins cwd={cwd} onError={onError} onChange={load} />
      <PasteCallback onError={onError} />
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
