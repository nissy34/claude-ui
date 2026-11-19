import React, { useEffect, useState } from 'react';
import { api, timeAgo } from './api.js';
import { Button, IconButton, Segmented } from './ui/index.jsx';
import { confirmDialog } from './ui/dialogs.jsx';
import { copyText } from './ui/clipboard.js';

const copy = (text) => copyText(text);

const isWin = /win/i.test(navigator.platform || navigator.userAgent);

function Connect({ onError }) {
  const [info, setInfo] = useState(null);
  const [show, setShow] = useState(false);
  const [host, setHost] = useState(() => (/^(localhost|127\.|\[::1\])/.test(location.hostname) ? '' : location.host));
  const [via, setVia] = useState(() => {
    try {
      return localStorage.getItem('cw.desktopVia') || 'code';
    } catch {
      return 'code';
    }
  });
  const pickVia = (v) => {
    setVia(v);
    try {
      localStorage.setItem('cw.desktopVia', v);
    } catch {}
  };
  const [where, setWhere] = useState(isWin ? 'C:\\Users\\<you>\\claude-ui-bridge.mjs' : '/Users/<you>/claude-ui-bridge.mjs');
  useEffect(() => {
    api('/api/desktop-mcp')
      .then((i) => {
        setInfo(i);
        if (i.publicUrl) setHost(i.publicUrl);
        else if (!host && i.hostname) setHost(`${i.hostname}:${i.port}`);
      })
      .catch(onError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return <div className="muted">Loading…</div>;
  if (!info.enabled) return <p className="muted set-note">The handoff server is turned off (CW_DESKTOP_MCP=0).</p>;
  const url = /^https?:\/\//i.test(host) ? `${host}/mcp` : `${location.protocol}//${host || location.host}/mcp`;
  const token = info.token;
  const server = (t) =>
    via === 'code'
      ? { type: 'http', url, headers: { Authorization: `Bearer ${t}` } }
      : via === 'uvx'
      ? { command: 'uvx', args: ['mcp-proxy', '--transport', 'streamablehttp', '-H', 'Authorization', `Bearer ${t}`, url] }
      : { command: 'node', args: [where, url], env: { CLAUDE_UI_TOKEN: t } };
  const cfg = JSON.stringify({ mcpServers: { 'claude-ui': server(show ? token : '<token>') } }, null, 2);
  const cfgCopy = JSON.stringify({ mcpServers: { 'claude-ui': server(token) } }, null, 2);
  const addCmd = (t) => `claude mcp add --scope user --transport http claude-ui ${url} --header "Authorization: Bearer ${t}"`;
  const rotate = async () => {
    if (!(await confirmDialog('Make a new token? Claude Desktop stops connecting until you put the new one in its config.', { ok: 'Make new token' }))) return;
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
      {info.inDocker && !info.publicUrl && (
        <p className="set-note warn-note">
          This server runs in Docker, so it can't tell which address other computers use to reach it. Type it below, or set CW_PUBLIC_URL (e.g. http://myserver:8787) in .env and restart to fill it in for you.
        </p>
      )}
      <h4 className="set-h">1. Pick where you use Claude</h4>
      <Segmented
        className="seg-inline"
        value={via}
        onChange={pickVia}
        options={[
          ['code', 'Claude Code (HTTP)'],
          ['uvx', 'Desktop chat, uvx'],
          ['node', 'Desktop chat, Node'],
        ]}
      />
      {via === 'code' ? (
        <p className="muted set-note">
          Claude Code (in the Desktop app's Code tab, the terminal or an IDE) connects to HTTP MCP servers directly, so nothing else is needed.
        </p>
      ) : (
        <p className="muted set-note">
          The Desktop chat's config file only starts local servers, and its custom connectors connect from Anthropic's cloud, which can't reach your network. So the chat reaches this server through a small local proxy.{' '}
          {via === 'uvx' ? (
            <>
              With uvx it runs the open-source mcp-proxy package, downloaded on first start. Needs{' '}
              <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noreferrer">
                uv
              </a>{' '}
              on that computer.
            </>
          ) : (
            <>
              The Node bridge is one script with no dependencies (needs Node 18 or newer).{' '}
              <a href="/mcp/bridge.mjs" download="claude-ui-bridge.mjs">
                Download claude-ui-bridge.mjs
              </a>
            </>
          )}
        </p>
      )}
      <h4 className="set-h">2. Add it</h4>
      <p className="muted set-note">
        {via === 'code'
          ? 'Run this once on the computer where you use Claude Code (--scope user makes it available in every project), or put the JSON below in a project\'s .mcp.json. Then start a new session.'
          : 'In Claude Desktop open Settings, Developer, Edit Config, and add this to claude_desktop_config.json (merge it into "mcpServers" if you already have one). Then quit and reopen Claude Desktop.'}
      </p>
      <div className="desk-fields">
        <label>
          Address Claude uses to reach this server
          <input className="field sm search-in" value={host} onChange={(e) => setHost(e.target.value.trim().replace(/^(https?:\/\/)?([^/]*).*$/i, '$1$2'))} placeholder="192.168.1.20:8787" />
        </label>
        {via === 'node' && (
          <label>
            Where you saved the bridge
            <input className="field sm search-in" value={where} onChange={(e) => setWhere(e.target.value)} />
          </label>
        )}
      </div>
      {via === 'code' && (
        <div className="copy-block">
          <pre className="set-pre">{addCmd(show ? token : '<token>')}</pre>
          <Button size="sm" onClick={() => copy(addCmd(token))}>
            Copy
          </Button>
        </div>
      )}
      <div className="copy-block">
        <pre className="set-pre">{cfg}</pre>
        <Button size="sm" onClick={() => copy(cfgCopy)}>
          Copy
        </Button>
      </div>
      <h4 className="set-h">Token</h4>
      <div className="token-row">
        <code className="token">{show ? token : '•'.repeat(24)}</code>
        <Button size="sm" onClick={() => setShow(!show)}>
          {show ? 'Hide' : 'Show'}
        </Button>
        <Button size="sm" onClick={() => copy(token)}>
          Copy
        </Button>
        {!info.fromEnv && (
          <Button variant="danger" size="sm" onClick={rotate}>
            New token
          </Button>
        )}
      </div>
      <p className="muted set-note">Anyone with the token can start chats on this computer, like the password. Making a new one disconnects the old.</p>
    </>
  );
}

function NoteScope({ projects, value, onChange }) {
  const options = [...new Set([value, ...(projects?.projects || []).map((p) => p.path)].filter(Boolean))];
  return (
    <select className="field sm proj-pick" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">Global notes (every project)</option>
      {options.map((p) => (
        <option key={p} value={p}>
          {p.split(/[\\/]/).filter(Boolean).pop()} — project memory
        </option>
      ))}
    </select>
  );
}

function Notes({ onError, projects, activeCwd }) {
  const [project, setProject] = useState(activeCwd || '');
  const [list, setList] = useState(null);
  const [dir, setDir] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // full note
  const [edit, setEdit] = useState(null); // {id?, title, content}
  const qs = (extra = {}) => {
    const p = new URLSearchParams({ ...(project ? { project } : {}), ...extra });
    const t = p.toString();
    return t ? `?${t}` : '';
  };
  const load = () =>
    api(`/api/notes${qs(q ? { q } : {})}`)
      .then((r) => {
        setList(project ? r.projectNotes.concat(r.globalNotes) : r.notes);
        setDir(r.memoryDir || '');
      })
      .catch(onError);
  useEffect(() => {
    setOpen(null);
    load();
  }, [q, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeQs = (n) => (n.scope === 'project' ? qs() : '');
  const key = (n) => `${n.scope}:${n.id}`;
  const view = async (n) => {
    if (open?.key === key(n)) return setOpen(null);
    try {
      setOpen({ ...(await api(`/api/notes/${encodeURIComponent(n.id)}${scopeQs(n)}`)), key: key(n) });
    } catch (e) {
      onError(e);
    }
  };
  const del = async (n) => {
    if (!(await confirmDialog(`Delete the note "${n.title}"?${n.scope === 'project' ? ' It is removed from this project\'s Claude Code memory.' : ''}`, { ok: 'Delete', danger: true }))) return;
    try {
      await api(`/api/notes/${encodeURIComponent(n.id)}${scopeQs(n)}`, { method: 'DELETE' });
      if (open?.key === key(n)) setOpen(null);
      load();
    } catch (e) {
      onError(e);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/api/notes', { method: 'POST', body: { ...edit, project: edit.scope === 'global' ? undefined : project || undefined } });
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
        <NoteScope projects={projects} value={project} onChange={setProject} />
        <input className="field sm search-in" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        {!edit && (
          <Button variant="primary" size="sm" onClick={() => setEdit({ title: '', content: '', scope: project ? 'project' : 'global' })}>
            + New note
          </Button>
        )}
      </div>
      <p className="muted set-note">
        {project
          ? `This project's notes are its Claude Code memory${dir ? ` (${dir})` : ''}: every Claude Code session in the project loads them, including what Claude chose to remember itself. Global notes are listed below them.`
          : 'Global notes are shared by every project, Claude Desktop and every chat. Pick a project to see its own notes.'}
      </p>
      {edit && (
        <form className="add-form card sunken fields sm" onSubmit={save}>
          <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title" required disabled={!!edit.id} />
          <textarea rows={6} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Markdown" />
          <div className="row end">
            <Button type="button" size="sm" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm">Save {edit.scope === 'global' ? 'global note' : 'to project memory'}</Button>
          </div>
        </form>
      )}
      {list?.length === 0 && <div className="empty-box">{q ? 'No matching notes.' : 'No notes yet.'}</div>}
      <div className="item-list">
        {list?.map((n) => (
          <div key={key(n)} className="item card note-item">
            <div className="item-main" onClick={() => view(n)} style={{ cursor: 'pointer' }}>
              <div className="item-title">
                {n.title} {project && <span className="tag">{n.scope === 'project' ? 'project' : 'global'}</span>}
                {n.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
              <div className="item-sub">
                {n.source} · {timeAgo(Date.parse(n.updated))}
              </div>
              {open?.key === key(n) ? <pre className="set-pre">{open.content}</pre> : <div className="item-sub">{(n.description || n.preview).slice(0, 140)}</div>}
            </div>
            <IconButton
              
              title="Edit"
              onClick={() =>
                api(`/api/notes/${encodeURIComponent(n.id)}${scopeQs(n)}`)
                  .then((f) => setEdit({ id: f.id, title: f.title, content: f.content, scope: n.scope }))
                  .catch(onError)
              }
            >
              ✎
            </IconButton>
            <IconButton title="Delete" onClick={() => del(n)}>
              🗑
            </IconButton>
          </div>
        ))}
      </div>
    </>
  );
}

export default function DesktopTab({ onError, projects, activeCwd }) {
  const [view, setView] = useState('connect');
  return (
    <>
      <Segmented className="seg-block" value={view} onChange={setView} options={[['connect', 'Connect'], ['notes', 'Notes']]} />
      {view === 'connect' ? <Connect onError={onError} /> : <Notes onError={onError} projects={projects} activeCwd={activeCwd} />}
    </>
  );
}
