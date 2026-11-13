import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl } from '../api.js';
import { buildItems, lastTodos } from './model.js';
import { renderMarkdown } from './markdown.js';
import ToolCard, { Todos, ToolGroup } from './ToolCard.jsx';
import Permission from './Permission.jsx';
import Composer from './Composer.jsx';
import { getPrefs } from '../prefs.js';
import SidePanel from './SidePanel.jsx';
import { ChatCtx } from './ctx.js';
import SideChat from './SideChat.jsx';
import TerminalView from '../TerminalView.jsx';

const AUTH_RE = /oauth|authenticat|\/login|not logged in|invalid api key|credentials/i;

function notify(title, body) {
  if (!getPrefs().notifications || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: 'claude-web' });
  } catch {}
}

function copy(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function Markdown({ text, streaming }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thinking({ text, streaming }) {
  const { verbose } = React.useContext(ChatCtx);
  const [open, setOpen] = useState(verbose);
  useEffect(() => setOpen(verbose), [verbose]);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        {streaming ? <span className="spinner" /> : '✳'} {streaming ? 'Thinking…' : 'Thought process'} <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Messages sent with file attachments end with a list of uploaded paths; show those as chips.
function splitAttachments(text) {
  const m = /(?:^|\n\n)Attached files:\n((?:- .+(?:\n|$))+)$/.exec(text || '');
  if (!m) return [text, []];
  return [text.slice(0, m.index), m[1].trim().split('\n').map((l) => l.slice(2))];
}

function UserMessage({ item, canEdit, onEdit, onFork }) {
  const [body, attached] = splitAttachments(item.text);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  if (editing) {
    return (
      <div className="msg user editing">
        <div className="edit-box">
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>
              Later messages are removed and files are restored to this point.
            </span>
            <button className="btn small" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn small primary"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                onEdit(item.index, draft);
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg user">
      <div className="bubble">
        {item.images > 0 && <div className="img-note">🖼 {item.images} image{item.images > 1 ? 's' : ''}</div>}
        {body}
        {item.refs?.length > 0 && (
          <div className="attach-row in-bubble">
            {item.refs.map((r) => (
              <span key={r.id} className="attach" title="Claude got this chat's conversation as context">
                💬 {r.name}
              </span>
            ))}
          </div>
        )}
        {attached.length > 0 && (
          <div className="attach-row in-bubble">
            {attached.map((f) => (
              <span key={f} className="attach" title={f}>
                📄 {f.split(/[\\/]/).pop()}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="msg-actions">
        {item.ts && <span className="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>}
        <button className="icon-btn" title="Copy" onClick={() => copy(item.text)}>
          ⧉
        </button>
        {onFork && (
          <button className="icon-btn" title="Fork: continue this conversation from here in a new chat" onClick={() => onFork(item.index)}>
            ⑂ <span className="lbl">Fork</span>
          </button>
        )}
        {canEdit && (
          <button
            className="icon-btn"
            title="Edit and resend"
            onClick={() => {
              setDraft(item.text);
              setEditing(true);
            }}
          >
            ✎ <span className="lbl">Edit</span>
          </button>
        )}
      </div>
    </div>
  );
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n) {
  if (!n) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

function InfoDialog({ meta, onClose }) {
  const rl = meta.rateLimit?.unifiedWindows || {};
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">Session info</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="info-grid">
            <span className="k">Folder</span>
            <span className="v">{meta.cwd}</span>
            {meta.worktree && (
              <>
                <span className="k">Worktree branch</span>
                <span className="v">{meta.worktree.branch}</span>
              </>
            )}
            <span className="k">Model</span>
            <span className="v">{meta.activeModel || meta.model || 'default'}</span>
            <span className="k">Permission mode</span>
            <span className="v">{meta.permissionMode || 'default'}</span>
            <span className="k">Effort</span>
            <span className="v">{meta.effort || 'default'}</span>
            <span className="k">Context</span>
            <span className="v">{meta.contextTokens ? `${fmtTokens(meta.contextTokens)} tokens` : '–'}</span>
            <span className="k">Session cost</span>
            <span className="v">{meta.totalCost ? `$${meta.totalCost.toFixed(2)} (API-equivalent estimate)` : '–'}</span>
            <span className="k">Claude Code</span>
            <span className="v">{meta.cliVersion || '–'}</span>
            <span className="k">Conversation id</span>
            <span className="v" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              {meta.claudeSessionId || '–'}
            </span>
          </div>
          {Object.keys(rl).length > 0 && (
            <>
              <span className="label">Usage limits</span>
              {Object.entries(rl).map(([k, w]) => (
                <div key={k}>
                  <div className="row" style={{ fontSize: 13 }}>
                    <span style={{ flex: 1 }}>{k.replace('_', '-').replace('hour', 'hour window').replace('day', 'day window')}</span>
                    <span className="muted">
                      {Math.round((w.utilization || 0) * 100)}%{w.resetsAt ? ` · resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ''}
                    </span>
                  </div>
                  <div className="meter">
                    <span style={{ width: `${Math.min(100, (w.utilization || 0) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </>
          )}
          <span className="label">MCP servers</span>
          {(meta.mcpServers || []).length === 0 && <span className="muted" style={{ fontSize: 13 }}>Shown after the first message.</span>}
          {(meta.mcpServers || []).map((m) => (
            <div key={m.name} className="mcp-row">
              <span className={`dot ${m.status === 'connected' ? 'on' : m.status === 'pending' ? 'busy' : 'off'}`} />
              <span style={{ flex: 1 }}>{m.name}</span>
              <span className="muted">{m.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ChatView({ session, sessions, onSelect, onCreate, onMenu, onError, onDeleted, onSettings }) {
  const [events, setEvents] = useState([]);
  const [offset, setOffset] = useState(0);
  const [deltas, setDeltas] = useState({});
  const [meta, setMeta] = useState(session);
  const [state, setState] = useState(session.state || 'idle');
  const [turns, setTurns] = useState(0);
  const [conn, setConn] = useState('connecting');
  const [status, setStatus] = useState(null);
  const [stick, setStick] = useState(true);
  const [showTodos, setShowTodos] = useState(true);
  const [panel, setPanel] = useState(() => (window.matchMedia('(min-width: 1200px)').matches && localStorage.getItem('cw.panel') === 'open' ? 'changes' : null));
  const [files, setFiles] = useState([]);
  const [wide, setWide] = useState(false);
  const [changesKey, setChangesKey] = useState(0);
  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [side, setSide] = useState(null); // { q } while the side chat is open
  const [verbose, setVerbose] = useState(() => localStorage.getItem('cw.verbose') === '1');
  const wsRef = useRef(null);
  const listRef = useRef(null);
  const deltaOrder = useRef(0);
  const reconnectRef = useRef(null);

  const send = useCallback(
    (msg) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      onError(new Error('Not connected to the server yet'));
      return false;
    },
    [onError]
  );

  useEffect(() => {
    let closed = false;
    let retry = 500;
    let timer;
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/ws?id=${session.id}`));
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'chat') {
          setEvents(m.events);
          setOffset(m.truncated || 0);
          setMeta(m.meta);
          setState(m.state);
          setTurns(m.turns || 0);
          setDeltas({});
          setConn('open');
          retry = 500;
        } else if (m.t === 'ev') {
          const e = m.ev;
          setEvents((list) => [...list, e]);
          // Like Desktop: show the browser when Claude uses it, and new pages/images it writes.
          if (e.k === 'block' && e.block?.type === 'tool_use' && !e.parent) {
            const { name, input } = e.block;
            if (/^mcp__browser__(navigate|click|type)$/.test(name)) ctxRef.current?.openBrowser();
            else if (name === 'Write' && /\.(html?|svg)$/i.test(input?.file_path || '')) setTimeout(() => ctxRef.current?.openArtifact(input.file_path), 400);
          }
          if (e.k === 'block' || e.k === 'result') {
            setDeltas((d) => {
              if (e.k === 'result') return {};
              const next = { ...d };
              for (const key of Object.keys(next)) if (next[key].msgId === e.msgId) delete next[key];
              return next;
            });
          }
          if (e.k === 'tool_result' || e.k === 'result') setChangesKey((k) => k + 1);
          if (e.k === 'perm') notify('Claude needs your permission', `${e.tool} in ${session.name}`);
          if (e.k === 'result') notify(e.isError ? 'Claude stopped with an error' : 'Claude finished', session.name);
          if (e.k === 'result' || e.k === 'error') setStatus(null);
        } else if (m.t === 'delta') {
          const key = `${m.msgId}:${m.index}`;
          setDeltas((d) => ({
            ...d,
            [key]: { key, msgId: m.msgId, kind: m.kind, parent: m.parent, order: d[key]?.order ?? deltaOrder.current++, text: (d[key]?.text || '') + m.text },
          }));
        } else if (m.t === 'state') {
          setState(m.state);
          setTurns(m.turns || 0);
          setMeta({ ...m.meta, live: m.live });
        } else if (m.t === 'status') setStatus(m.status);
        else if (m.t === 'reload') ws.close(4000, 'reload');
        else if (m.t === 'error') onError(new Error(m.error));
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4004) return setConn('gone');
        setConn(ev.code === 4000 ? 'open' : 'reconnecting');
        timer = setTimeout(connect, ev.code === 4000 ? 0 : retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    reconnectRef.current = connect;
    connect();
    const onVis = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        retry = 500;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      wsRef.current?.close();
    };
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => buildItems(events, deltas, offset), [events, deltas, offset]);
  // Fold runs of quiet tool calls (reads, searches, commands) into one summary row.
  const rows = useMemo(() => {
    const QUIET = new Set(['Read', 'Grep', 'Glob', 'LS', 'Bash', 'BashOutput', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead', 'KillShell']);
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) out.push({ type: 'group', tools: run, key: run[0].id });
      else out.push(...run);
      run = [];
    };
    for (const it of items) {
      if (!verbose && it.type === 'tool' && QUIET.has(it.name) && !(it.perm && !it.perm.done) && !it.result?.isError) run.push(it);
      else {
        flush();
        out.push(it);
      }
    }
    flush();
    return out;
  }, [items, verbose]);
  const todos = useMemo(() => lastTodos(events), [events]);
  const pendingPerms = items.filter((i) => i.type === 'tool' && i.perm && !i.perm.done).length + items.filter((i) => i.type === 'perm' && !i.done).length;
  const busy = state === 'busy' || state === 'waiting';
  // Resume shows on an exit error only while it is the latest thing in the chat.
  const lastResumable = busy ? -1 : rows.findLastIndex((r) => ['error', 'user', 'text', 'tool', 'group'].includes(r.type));
  const queued = Math.max(0, turns - 1);
  // Commands with descriptions when the CLI gave them, plus any other names it listed.
  const commandList = useMemo(() => {
    const info = meta.commandInfo || [];
    const known = new Set(info.flatMap((c) => [c.name, ...(c.aliases || [])]));
    const list = [...info, ...(meta.commands || []).filter((n) => !known.has(n)).map((name) => ({ name }))].filter((c) => c.name !== 'btw');
    // Handled here: opens the side chat.
    return [{ name: 'btw', description: 'Ask a side question without adding it to the conversation (Ctrl/⌘ ;)', argumentHint: '<question>' }, ...list];
  }, [meta.commandInfo, meta.commands]);
  const mentionable = useMemo(() => sessions.filter((x) => x.kind === 'chat' && x.id !== session.id && !x.archived).sort((a, b) => b.lastActivity - a.lastActivity), [sessions, session.id]);
  const lastError = [...items].reverse().find((i) => i.type === 'error' || i.type === 'result');
  const authProblem = lastError && (lastError.type === 'error' || lastError.isError) && AUTH_RE.test(lastError.text || '');
  const parent = meta.parentId && sessions.find((s) => s.id === meta.parentId);
  const children = sessions.filter((s) => s.parentId === session.id && s.kind === 'chat');
  const drawerSession = sessions.find((s) => s.parentId === session.id && s.kind === 'shell');

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [items, stick]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const answer = (a) => send({ t: 'perm', ...a });
  const setMode = (mode) => send({ t: 'mode', mode });
  const submit = (text, images, refs) => {
    const btw = /^\/btw(?:\s+([\s\S]*))?$/.exec((text || '').trim());
    if (btw && !images?.length) {
      setSide({ q: btw[1] || '', key: Date.now() });
      return true;
    }
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    setStick(true);
    return send({ t: 'send', text, images, refs });
  };

  const openPanel = (tab) => {
    setPanel(tab);
    try {
      localStorage.setItem('cw.panel', 'open');
    } catch {}
  };
  const ctx = useMemo(
    () => ({
      openFile: (p) => {
        const rel = p.startsWith(meta.cwd + '/') ? p.slice(meta.cwd.length + 1) : p;
        setFiles((f) => (f.includes(rel) ? f : [...f, rel].slice(-6)));
        openPanel(rel);
      },
      openArtifact: (p) => {
        const abs = /^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${meta.cwd}/${p}`;
        const key = 'art:' + abs;
        setFiles((f) => (f.includes(key) ? f : [...f, key].slice(-6)));
        openPanel(key);
      },
      openBrowser: () => openPanel('browser'),
      openSession: (id) => onSelect(id),
      verbose,
    }),
    [meta.cwd, onSelect, verbose]
  );
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ';') {
        e.preventDefault();
        setSide((v) => (v ? null : { q: '', key: Date.now() }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Opened from the Artifacts gallery: #s=<id>&a=<path>
  useEffect(() => {
    const check = () => {
      const m = /[&#]a=([^&]+)/.exec(location.hash);
      if (m && meta.cwd) {
        ctxRef.current.openArtifact(decodeURIComponent(m[1]));
        history.replaceState(null, '', `#s=${session.id}`);
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [meta.cwd, session.id]);

  const rename = () => {
    setMenu(false);
    const name = window.prompt('Rename chat', meta.name);
    if (name) api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { name } }).catch(onError);
  };
  const archive = () => {
    setMenu(false);
    api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { archived: !meta.archived } }).catch(onError);
  };
  const remove = () => {
    setMenu(false);
    if (!window.confirm('Delete this chat? Claude keeps its own transcript, so you can resume it later from "Past conversations".')) return;
    api(`/api/sessions/${session.id}`, { method: 'DELETE' }).then(onDeleted).catch(onError);
  };
  const fork = async (index) => {
    try {
      const { session: s } = await api(`/api/sessions/${session.id}/fork`, { method: 'POST', body: Number.isInteger(index) ? { index } : {} });
      onSelect(s.id, s);
    } catch (e) {
      onError(e);
    }
  };
  const toggleVerbose = () =>
    setVerbose((v) => {
      try {
        localStorage.setItem('cw.verbose', v ? '0' : '1');
      } catch {}
      return !v;
    });
  const exportChat = () => {
    const out = [`# ${meta.name}`, '', `Folder: ${meta.cwd}`, ''];
    for (const it of items) {
      if (it.type === 'user') out.push('## You', '', it.text, '');
      else if (it.type === 'text') out.push('## Claude', '', it.text, '');
      else if (it.type === 'tool') out.push(`> Tool: ${it.name}${it.summary ? ` ${it.summary}` : ''}`, '');
      else if (it.type === 'shell') out.push('```', `$ ${it.cmd}`, it.text || '', '```', '');
    }
    const blob = new Blob([out.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(meta.name || 'chat').replace(/[^\w.-]+/g, '-').slice(0, 60)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Desktop shortcuts inside a chat: Ctrl+O view mode, Ctrl+` terminal, Ctrl/⌘+Shift+D changes, Ctrl/⌘+Shift+B browser.
  const keysRef = useRef({});
  keysRef.current = { toggleVerbose, toggleTerminal: () => toggleTerminal(), panel };
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = keysRef.current;
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') (e.preventDefault(), k.toggleVerbose());
      else if (e.ctrlKey && e.key === '`') (e.preventDefault(), k.toggleTerminal());
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'd') (e.preventDefault(), k.panel && k.panel !== 'browser' ? setPanel(null) : openPanel('changes'));
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') (e.preventDefault(), k.panel === 'browser' ? setPanel(null) : openPanel('browser'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTerminal = async () => {
    if (!terminal && !drawerSession) {
      const s = await onCreate({ cwd: meta.cwd, kind: 'shell', parentId: session.id, name: `${meta.name} terminal` }, { navigate: false });
      if (!s) return;
    }
    setTerminal((t) => !t);
  };
  const openTui = async () => {
    setMenu(false);
    try {
      const { session: t } = await api(`/api/sessions/${session.id}/terminal`, { method: 'POST' });
      onSelect(t.id);
    } catch (e) {
      onError(e);
    }
  };
  const relogin = () => onCreate({ cwd: meta.cwd, kind: 'claude', name: 'Log in to Claude', login: true });

  const project = (meta.project || meta.cwd)?.split(/[\\/]/).filter(Boolean).pop();
  const rate = meta.rateLimit?.unifiedWindows?.five_hour;

  return (
    <ChatCtx.Provider value={ctx}>
      <div className="chat-shell">
        <div className="chat-view">
          {side && <SideChat key={side.key} sessionId={session.id} initial={side.q} onClose={() => setSide(null)} />}
          <div className="topbar">
            <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu">
              ☰
            </button>
            <div className="title" onClick={rename} title="Rename">
              <span className="tname">{meta.name}</span>
              <span className="muted tcwd">{project}</span>
              {meta.worktree && <span className="pill branch hide-mobile">⎇ {meta.worktree.branch}</span>}
            </div>
            {parent && (
              <button className="parent-link hide-mobile" onClick={() => onSelect(parent.id)}>
                ↰ {parent.name.slice(0, 30)}
              </button>
            )}
            {conn === 'reconnecting' && <span className="pill warn">reconnecting…</span>}
            <div className="tools">
              <button className={`icon-btn ${terminal ? 'on' : ''}`} title="Terminal" onClick={toggleTerminal}>
                ›_
              </button>
              <button className={`icon-btn ${panel ? 'on' : ''}`} title="Changes and files" onClick={() => (panel && panel !== 'browser' ? setPanel(null) : openPanel('changes'))}>
                ± <span className="lbl hide-mobile">Changes</span>
              </button>
              <button className={`icon-btn ${panel === 'browser' ? 'on' : ''}`} title="Browser" onClick={() => (panel === 'browser' ? setPanel(null) : openPanel('browser'))}>
                ◎ <span className="lbl hide-mobile">Browser</span>
              </button>
              <div className="menu-wrap">
                <button className="icon-btn" title="More" onClick={() => setMenu((m) => !m)}>
                  ⋯
                </button>
                {menu && (
                  <div className="pop down">
                    <button onClick={() => (setMenu(false), setInfo(true))}>Session info and usage</button>
                    <button onClick={openTui}>Open in Claude's terminal</button>
                    <button onClick={rename}>Rename</button>
                    <button onClick={() => (setMenu(false), fork())}>Fork chat</button>
                    <button onClick={() => (setMenu(false), exportChat())}>Export as Markdown</button>
                    <button onClick={() => (setMenu(false), toggleVerbose())}>
                      {verbose ? 'Normal view' : 'Verbose view'} <kbd>Ctrl O</kbd>
                    </button>
                    <button onClick={archive}>{meta.archived ? 'Unarchive' : 'Archive'}</button>
                    {meta.live && <button onClick={() => (setMenu(false), send({ t: 'stop' }))}>Stop Claude process</button>}
                    <button onClick={() => (setMenu(false), relogin())}>Log in to Claude again</button>
                    <div className="sep" />
                    <button className="danger" onClick={remove} style={{ color: 'var(--red)' }}>
                      Delete chat
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="messages" ref={listRef} onScroll={onScroll}>
            <div className="messages-inner">
              {items.length === 0 && conn === 'open' && (
                <div className="welcome">
                  <span className="mark">&gt;_</span>
                  <h2>What are we building in {project}?</h2>
                  <div className="wsub">{meta.cwd}</div>
                </div>
              )}
              {rows.map((it, n) => {
                switch (it.type) {
                  case 'group':
                    return <ToolGroup key={it.key} tools={it.tools} cwd={meta.cwd} />;
                  case 'user':
                    return <UserMessage key={`u${it.index}`} item={it} canEdit={!busy && conn === 'open'} onEdit={(index, text) => send({ t: 'edit', index, text })} onFork={busy ? null : fork} />;
                  case 'text':
                    return (
                      <div key={it.key || n} className="msg assistant">
                        <Markdown text={it.text} streaming={it.streaming} />
                        {!it.streaming && (
                          <div className="msg-actions">
                            <button className="icon-btn" title="Copy" onClick={() => copy(it.text)}>
                              ⧉ <span className="lbl">Copy</span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  case 'thinking':
                    return <Thinking key={it.key || n} text={it.text} streaming={it.streaming} />;
                  case 'tool':
                    return (
                      <ToolCard key={it.id} item={it} cwd={meta.cwd}>
                        {it.perm && <Permission perm={it.perm} cwd={meta.cwd} onAnswer={answer} onMode={setMode} showBody={false} />}
                      </ToolCard>
                    );
                  case 'perm':
                    return <Permission key={it.reqId} perm={it} cwd={meta.cwd} onAnswer={answer} onMode={setMode} />;
                  case 'result':
                    return (
                      <div key={n} className={`turn-end ${it.isError ? 'err' : ''}`}>
                        {it.isError ? it.text || `Stopped (${it.subtype})` : null}
                        {!it.isError && <span className="muted">{[fmtDuration(it.durationMs), it.cost ? `$${it.cost.toFixed(3)}` : ''].filter(Boolean).join(' · ')}</span>}
                      </div>
                    );
                  case 'error':
                    return (
                      <div key={n} className="sys-error-wrap">
                        <pre className="sys-error">{it.text}</pre>
                        {it.resumable && n === lastResumable && (
                          <button className="btn small primary" disabled={conn !== 'open'} onClick={() => send({ t: 'resume' })}>
                            ↻ Resume
                          </button>
                        )}
                      </div>
                    );
                  case 'shell':
                    return (
                      <div key={n} className="shell-run">
                        <div className="shell-cmd">
                          <span className="muted">$</span> {it.cmd}
                          {it.code ? <span className="shell-code">exit {it.code}</span> : null}
                        </div>
                        {it.text && <pre>{it.text}</pre>}
                        <div className="muted shell-note">Claude sees this with your next message.</div>
                      </div>
                    );
                  case 'notice':
                    return (
                      <div key={n} className="notice">
                        {it.text}
                      </div>
                    );
                  default:
                    return null;
                }
              })}
              {authProblem && !busy && (
                <div className="perm">
                  <div className="perm-title">
                    <b>Claude is logged out on the server.</b> Open a terminal session, type <code>/login</code>, finish the sign-in, then come back and send your message again.
                  </div>
                  <div className="perm-actions">
                    <button className="btn primary" onClick={relogin}>
                      Log in again
                    </button>
                  </div>
                </div>
              )}
              {children.length > 0 && (
                <div className="notice" style={{ gap: 6 }}>
                  Child sessions:
                  {children.map((c) => (
                    <button key={c.id} className="link-btn" onClick={() => onSelect(c.id)}>
                      {c.name.slice(0, 30)}
                      {c.state !== 'idle' ? ` (${c.state})` : ''}
                    </button>
                  ))}
                </div>
              )}
              {busy && (
                <div className="working">
                  <span className="spark">✳</span>
                  {pendingPerms ? 'Waiting for your approval' : status === 'compacting' ? 'Compacting…' : 'Working…'}
                </div>
              )}
            </div>
          </div>

          {!stick && (
            <button className="jump" onClick={() => setStick(true)}>
              ↓ Latest
            </button>
          )}

          {todos && todos.some((t) => t.status !== 'completed') && (
            <div className="todo-dock">
              <button className="todo-head" onClick={() => setShowTodos((s) => !s)}>
                ☑ Tasks {todos.filter((t) => t.status === 'completed').length}/{todos.length} <span className="chev">{showTodos ? '▾' : '▸'}</span>
              </button>
              {showTodos && <Todos todos={todos} />}
            </div>
          )}

          <Composer
            sessionId={session.id}
            disabled={conn !== 'open'}
            busy={busy}
            onSend={submit}
            onStop={() => send({ t: 'interrupt' })}
            mode={meta.permissionMode || 'default'}
            onMode={setMode}
            model={meta.model || ''}
            activeModel={meta.activeModel}
            onModel={(model) => send({ t: 'model', model })}
            effort={meta.effort || ''}
            onEffort={(effort) => send({ t: 'effort', effort })}
            commands={commandList}
            footer=""
            usage={meta.rateLimit?.unifiedWindows}
            mcpServers={meta.mcpServers}
            onSettings={onSettings}
            onBrowser={() => openPanel('browser')}
            chats={mentionable}
            context={{ used: meta.contextTokens, window: meta.contextWindow }}
            onCompact={() => submit('/compact', [])}
            queued={queued}
            onError={onError}
          />

          {terminal && drawerSession && (
            <div className="term-drawer">
              <div className="term-drawer-head">
                ›_ Terminal · {meta.cwd}
                <span className="spacer" />
                <button className="icon-btn" title="Close" onClick={() => setTerminal(false)}>
                  ✕
                </button>
              </div>
              <TerminalView key={drawerSession.id} session={drawerSession} onMenu={() => {}} onError={onError} onDeleted={() => setTerminal(false)} />
            </div>
          )}
        </div>
        {panel && (
          <SidePanel
            sessionId={session.id}
            tab={panel}
            files={files}
            onTab={setPanel}
            onCloseFile={(f) => {
              setFiles((list) => list.filter((x) => x !== f));
              if (panel === f) setPanel('changes');
            }}
            onClose={() => {
              setPanel(null);
              try {
                localStorage.setItem('cw.panel', 'closed');
              } catch {}
            }}
            refreshKey={changesKey}
            onOpenFile={ctx.openFile}
            onPrompt={(t) => submit(t, [])}
            busy={busy}
            onError={onError}
            wide={wide}
            onWide={() => setWide((w) => !w)}
          />
        )}
        {info && <InfoDialog meta={meta} onClose={() => setInfo(false)} />}
      </div>
    </ChatCtx.Provider>
  );
}
