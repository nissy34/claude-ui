import React, { useEffect, useState } from 'react';
import { api, timeAgo } from './api.js';

function copy(text) {
  try {
    navigator.clipboard.writeText(text);
  } catch {}
}

const isWin = /win/i.test(navigator.platform || navigator.userAgent);

function Connect({ onError }) {
  const [info, setInfo] = useState(null);
  const [show, setShow] = useState(false);
  const [host, setHost] = useState(() => (/^(localhost|127\.|\[::1\])/.test(location.hostname) ? '' : location.host));
  const [where, setWhere] = useState(isWin ? 'C:\\Users\\<you>\\claude-ui-bridge.mjs' : '/Users/<you>/claude-ui-bridge.mjs');
  useEffect(() => {
    api('/api/desktop-mcp')
      .then((i) => {
        setInfo(i);
        if (!host && i.hostname) setHost(`${i.hostname}:${i.port}`);
      })
      .catch(onError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return <div className="muted">Loading…</div>;
  if (!info.enabled) return <p className="muted set-note">The handoff server is turned off (CW_DESKTOP_MCP=0).</p>;
  const url = `${location.protocol}//${host || location.host}/mcp`;
  const token = info.token;
  const cfg = JSON.stringify({ mcpServers: { 'claude-ui': { command: 'node', args: [where, url], env: { CLAUDE_UI_TOKEN: show ? token : '<token>' } } } }, null, 2);
  const cfgCopy = JSON.stringify({ mcpServers: { 'claude-ui': { command: 'node', args: [where, url], env: { CLAUDE_UI_TOKEN: token } } } }, null, 2);
  const rotate = async () => {
    if (!window.confirm('Make a new token? Claude Desktop stops connecting until you put the new one in its config.')) return;
    try {
      const r = await api('/api/desktop-mcp/token', { method: 'POST' });
      setInfo({ ...info, token: r.token });
    } catch (e) {
      onError(e);
    }
  };
  const localOnly = info.host === '127.0.0.1' || info.host === 'localhost';
  return (
    <>
      <p className="muted set-note">
        Add this server to the Claude Desktop app so the two can hand work to each other. From Desktop you can say "continue this tonight on my machine", ask "what did that chat do?", send a chat new instructions, and keep shared notes that chats here can read and write too.
      </p>
      {localOnly && (
        <p className="set-note warn-note">
          This server listens on {info.host} only, so only Claude Desktop on this same computer can reach it. To use Desktop on another computer, set CW_HOST=0.0.0.0 (or your LAN or Tailscale address).
        </p>
      )}
      <h4 className="set-h">1. Download the bridge</h4>
      <p className="muted set-note">
        Claude Desktop starts local servers from its config file, so it connects through a small script with no dependencies (needs Node 18 or newer on the Desktop computer).{' '}
        <a href="/mcp/bridge.mjs" download="claude-ui-bridge.mjs">
          Download claude-ui-bridge.mjs
        </a>
      </p>
      <h4 className="set-h">2. Add it to Claude Desktop</h4>
      <p className="muted set-note">
        In Claude Desktop open Settings, Developer, Edit Config, and add this to claude_desktop_config.json (merge it into "mcpServers" if you already have one). Then quit and reopen Claude Desktop.
      </p>
      <div className="desk-fields">
        <label>
          Address Desktop uses to reach this server
          <input className="search-in" value={host} onChange={(e) => setHost(e.target.value.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))} placeholder="192.168.1.20:8787" />
        </label>
        <label>
          Where you saved the bridge
          <input className="search-in" value={where} onChange={(e) => setWhere(e.target.value)} />
        </label>
      </div>
      <div className="copy-block">
        <pre className="set-pre">{cfg}</pre>
        <button className="btn small" onClick={() => copy(cfgCopy)}>
          Copy
        </button>
      </div>
      <h4 className="set-h">Token</h4>
      <div className="token-row">
        <code className="token">{show ? token : '•'.repeat(24)}</code>
        <button className="btn small" onClick={() => setShow(!show)}>
          {show ? 'Hide' : 'Show'}
        </button>
        <button className="btn small" onClick={() => copy(token)}>
          Copy
        </button>
        {!info.fromEnv && (
          <button className="btn small danger" onClick={rotate}>
            New token
          </button>
        )}
      </div>
      <p className="muted set-note">Anyone with the token can start chats on this computer, like the password. Making a new one disconnects the old.</p>
    </>
  );
}

function Notes({ onError }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // full note
  const [edit, setEdit] = useState(null); // {id?, title, content}
  const load = () =>
    api(`/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => setList(r.notes))
      .catch(onError);
  useEffect(() => {
    load();
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = async (id) => {
    if (open?.id === id) return setOpen(null);
    try {
      setOpen(await api(`/api/notes/${encodeURIComponent(id)}`));
    } catch (e) {
      onError(e);
    }
  };
  const del = async (n) => {
    if (!window.confirm(`Delete the note "${n.title}"?`)) return;
    try {
      await api(`/api/notes/${encodeURIComponent(n.id)}`, { method: 'DELETE' });
      if (open?.id === n.id) setOpen(null);
      load();
    } catch (e) {
      onError(e);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/api/notes', { method: 'POST', body: edit });
      setEdit(null);
      setOpen(null);
      load();
    } catch (err) {
      onError(err);
    }
  };
  return (
    <>
      <div className="tab-top">
        <input className="search-in" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        {!edit && (
          <button className="btn small primary" onClick={() => setEdit({ title: '', content: '' })}>
            + New note
          </button>
        )}
      </div>
      <p className="muted set-note">Shared between Claude Desktop and every chat here. Claude reads them when you refer to earlier work, and writes them when you ask it to remember something.</p>
      {edit && (
        <form className="add-form" onSubmit={save}>
          <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title" required />
          <textarea rows={6} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Markdown" />
          <div className="row end">
            <button type="button" className="btn small" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button className="btn small primary">Save</button>
          </div>
        </form>
      )}
      {list?.length === 0 && <div className="empty-box">{q ? 'No matching notes.' : 'No notes yet.'}</div>}
      <div className="item-list">
        {list?.map((n) => (
          <div key={n.id} className="item note-item">
            <div className="item-main" onClick={() => view(n.id)} style={{ cursor: 'pointer' }}>
              <div className="item-title">
                {n.title} {n.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
              <div className="item-sub">
                {n.source} · {timeAgo(Date.parse(n.updated))}
              </div>
              {open?.id === n.id ? <pre className="set-pre">{open.content}</pre> : <div className="item-sub">{n.preview.slice(0, 140)}</div>}
            </div>
            <button className="icon-btn" title="Edit" onClick={() => api(`/api/notes/${encodeURIComponent(n.id)}`).then((f) => setEdit({ id: f.id, title: f.title, content: f.content })).catch(onError)}>
              ✎
            </button>
            <button className="icon-btn" title="Delete" onClick={() => del(n)}>
              🗑
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

export default function DesktopTab({ onError }) {
  const [view, setView] = useState('connect');
  return (
    <>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={view === 'connect' ? 'on' : ''} onClick={() => setView('connect')}>
          Connect
        </button>
        <button className={view === 'notes' ? 'on' : ''} onClick={() => setView('notes')}>
          Shared notes
        </button>
      </div>
      {view === 'connect' ? <Connect onError={onError} /> : <Notes onError={onError} />}
    </>
  );
}
