import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl } from '../api.js';
import { buildItems, lastTodos, isPublishTool, publishedPath, publishedTitle } from './model.js';
import { renderMarkdown } from './markdown.js';
import ToolCard, { Todos, ToolGroup } from './ToolCard.jsx';
import Permission from './Permission.jsx';
import { Elicitation, McpSignInBar, startSignIn, needsSignIn, deliverCallback, LOCAL_CALLBACK } from './McpAuth.jsx';
import Composer from './Composer.jsx';
import QuoteReply from './QuoteReply.jsx';
import { splitQuote } from './quote.js';
import Linkify from './Linkify.jsx';
import { getPrefs } from '../prefs.js';
import SidePanel from './SidePanel.jsx';
import { isLive as taskLive, BackgroundPill } from './BackgroundTasks.jsx';
import { ChatCtx } from './ctx.js';
import SideChat from './SideChat.jsx';
import TerminalView from '../TerminalView.jsx';
import { Button, IconButton, Menu, Modal, ModalHead, useDismiss } from '../ui/index.jsx';
import { promptDialog } from '../ui/dialogs.jsx';
import { deleteChat } from './deleteChat.js';
import { copyText } from '../ui/clipboard.js';

const AUTH_RE = /oauth|authenticat|\/login|not logged in|invalid api key|credentials/i;

function notify(title, body) {
  if (!getPrefs().notifications || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: 'claude-web' });
  } catch {}
}

const copy = (text) => copyText(text);

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
      {open && <div className="thinking-body"><Linkify text={text} /></div>}
    </div>
  );
}

// Placeholder transcript shown until the chat's history arrives from the server.
function LoadingTranscript() {
  return (
    <div className="chat-loading" role="status" aria-live="polite">
      <div className="chat-loading-label">
        <span className="spinner" /> Loading conversation…
      </div>
      <div className="sk-user">
        <span className="sk-bar" style={{ width: '70%' }} />
      </div>
      <div className="sk-assistant">
        <span className="sk-bar" style={{ width: '92%' }} />
        <span className="sk-bar" style={{ width: '84%' }} />
        <span className="sk-bar" style={{ width: '60%' }} />
      </div>
      <div className="sk-tool" />
      <div className="sk-user">
        <span className="sk-bar" style={{ width: '45%' }} />
      </div>
      <div className="sk-assistant">
        <span className="sk-bar" style={{ width: '88%' }} />
        <span className="sk-bar" style={{ width: '72%' }} />
      </div>
    </div>
  );
}

// Long chats render their latest rows first; older ones are added as you scroll up.
const PAGE_ROWS = 60;

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

const ROLE_NAME = { child: 'child chat', parent: 'parent chat' };
const KIND_NAME = { question: 'Question from', reply: 'Reply from' };

/** A message waiting for the current turn to end, shown in the chat like Claude Desktop does. */
function QueuedMessage({ item, busy, onNow, onEdit, onRemove, onOpen }) {
  const [quoted, body] = splitQuote(splitAttachments(item.text)[0]);
  const [open, setOpen] = useState(false);
  const long = item.text.length > 600 || item.text.split('\n').length > 8;
  return (
    <div className={`msg user queued ${item.mine ? '' : 'from-session'}`}>
      {!item.mine && (
        <div className="from-label">
          {item.role === 'desktop' ? (
            <>{item.kind === 'handoff' ? 'Handed off from' : 'From'} Claude Desktop</>
          ) : (
            <>
              {KIND_NAME[item.kind] || 'From'} {ROLE_NAME[item.role] || 'chat'}{' '}
              <button className="linklike" onClick={() => onOpen?.(item.from?.id)} title="Open that chat">
                {item.name}
              </button>
              {item.kind === 'question' && <span className="from-hint"> · it is waiting for a reply</span>}
            </>
          )}
        </div>
      )}
      <div className={`bubble ${long && !open ? 'clamped' : ''}`} onClick={long && !open ? () => setOpen(true) : undefined}>
        {quoted && <div className="bubble-quote">{quoted}</div>}
        {item.images > 0 && <div className="img-note">🖼 {item.images} image{item.images > 1 ? 's' : ''}</div>}
        <Linkify text={body} />
        {item.refs?.length > 0 && (
          <div className="attach-row in-bubble">
            {item.refs.map((r) => (
              <span key={r.id} className="attach">
                💬 {r.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="queued-row">
        <span className="queued-tag">{item.now ? 'Sending…' : busy ? 'Queued' : 'Waiting to send'}</span>
        {!item.now && (
          <>
            <Button size="sm" onClick={onNow} title={busy ? 'Stop what Claude is doing and send this now' : 'Send this now'}>
              Send now
            </Button>
            {item.mine && !item.images && (
              <IconButton onClick={onEdit} title="Edit (moves it back to the message box)" aria-label="Edit">
                ✎
              </IconButton>
            )}
            <IconButton onClick={onRemove} title="Remove from the queue" aria-label="Remove">
              ✕
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

function UserMessage({ item, canEdit, onEdit, onOpen, onFork }) {
  const [full, attached] = splitAttachments(item.text);
  const [quoted, body] = splitQuote(full);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  if (editing) {
    return (
      <div className="msg user editing">
        <div className="edit-box">
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <span className="muted text-sm" style={{ marginRight: 'auto' }}>
              Later messages are removed and files are restored to this point.
            </span>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary" size="sm"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                onEdit(item.index, draft);
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`msg user ${item.from ? 'from-session' : ''}`}>
      {item.from?.role === 'desktop' && (
        <div className="from-label">
          {item.from.kind === 'handoff' ? 'Handed off from' : 'From'} Claude Desktop
        </div>
      )}
      {item.from && item.from.role !== 'desktop' && (
        <div className="from-label">
          {KIND_NAME[item.from.kind] || 'From'} {ROLE_NAME[item.from.role] || 'chat'}{' '}
          <button className="linklike" onClick={() => onOpen?.(item.from.id)} title="Open that chat">
            {item.from.name}
          </button>
          {item.from.kind === 'question' && <span className="from-hint"> · it waited for a reply</span>}
          {item.from.kind === 'reply' && <span className="from-hint"> · answered the question Claude was waiting on</span>}
        </div>
      )}
      <div className="bubble">
        {quoted && <div className="bubble-quote">{quoted}</div>}
        {item.images > 0 && <div className="img-note">🖼 {item.images} image{item.images > 1 ? 's' : ''}</div>}
        <Linkify text={body} />
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
        <IconButton title="Copy" onClick={() => copy(item.text)}>
          ⧉
        </IconButton>
        {onFork && (
          <IconButton title="Fork: continue this conversation from here in a new chat" onClick={() => onFork(item.index)}>
            ⑂ <span className="lbl">Fork</span>
          </IconButton>
        )}
        {canEdit && (
          <IconButton
            
            title="Edit and resend"
            onClick={() => {
              setDraft(item.text);
              setEditing(true);
            }}
          >
            ✎ <span className="lbl">Edit</span>
          </IconButton>
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

function InfoDialog({ meta, onClose, onSignIn }) {
  const rl = meta.rateLimit?.unifiedWindows || {};
  return (
    <Modal onClose={onClose}>
      <ModalHead title="Session info" onClose={onClose} />
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
          <span className="v mono text-sm">
            {meta.claudeSessionId || '–'}
          </span>
        </div>
        {Object.keys(rl).length > 0 && (
          <>
            <span className="label">Usage limits</span>
            {Object.entries(rl).map(([k, w]) => (
              <div key={k}>
                <div className="row text-md">
                  <span className="grow">{k.replace('_', '-').replace('hour', 'hour window').replace('day', 'day window')}</span>
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
        {(meta.mcpServers || []).length === 0 && <span className="muted text-md">Shown after the first message.</span>}
        {(meta.mcpServers || []).map((m) => (
          <div key={m.name} className="mcp-row">
            <span className={`dot ${m.status === 'connected' ? 'on' : m.status === 'pending' ? 'busy' : 'off'}`} />
            <span className="grow">{m.name}</span>
            <span className="muted">{m.status}</span>
            {needsSignIn(m) && (
              <Button variant="primary" size="sm" className="mcp-signin" onClick={() => onSignIn(m.name)}>
                Sign in
              </Button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function ChatView({ session, sessions, onSelect, onCreate, onMenu, onError, onDeleted, onSettings }) {
  const [events, setEvents] = useState([]);
  const [offset, setOffset] = useState(0);
  const [deltas, setDeltas] = useState({});
  const [meta, setMeta] = useState(session);
  const [state, setState] = useState(session.state || 'idle');
  const [, setTurns] = useState(0);
  const [conn, setConn] = useState('connecting');
  const [loaded, setLoaded] = useState(false); // history received at least once
  const [hidden, setHidden] = useState(null); // rows not rendered yet at the top of a long chat
  const growRef = useRef(null); // scroll height before showing earlier rows, to keep the view in place
  const [status, setStatus] = useState(null);
  const [stick, setStick] = useState(true);
  const [showTodos, setShowTodos] = useState(true);
  const [panel, setPanel] = useState(() => (window.matchMedia('(min-width: 1200px)').matches && localStorage.getItem('cw.panel') === 'open' ? 'changes' : null));
  const [files, setFiles] = useState([]);
  const [wide, setWide] = useState(false);
  const [changesKey, setChangesKey] = useState(0);
  const pendingArtifacts = useRef(new Map());
  // Published artifacts' titles, for their side panel tabs (three report.html tabs look alike).
  const [artTitles, setArtTitles] = useState({});
  const [menu, setMenu] = useState(false);
  const moreRef = useRef(null);
  useDismiss(menu, () => setMenu(false), moreRef);
  const [info, setInfo] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [inbox, setInbox] = useState([]);
  const [waitingOn, setWaitingOn] = useState(null);
  const [oauth, setOauth] = useState(session.oauth || []);
  const [insert, setInsert] = useState(null); // {text, key}: put a queued message back in the box
  const [side, setSide] = useState(null); // { q } while the side chat is open
  const [verbose, setVerbose] = useState(() => localStorage.getItem('cw.verbose') === '1');
  const [quote, setQuote] = useState(null); // passage quoted into the main message box
  const [tasks, setTasks] = useState([]); // background shells, Monitor watches and agents
  const [taskFocus, setTaskFocus] = useState(null);
  // Tool call id -> its background task, for the "Running in background" tag on tool cards.
  // Keyed on a string so progress updates don't re-render every tool card.
  const bgKey = tasks.map((t) => (t.toolUseId ? `${t.toolUseId}|${t.id}|${taskLive(t) ? 1 : 0}` : '')).join(',');
  const bgTasks = useMemo(() => {
    const m = {};
    for (const s of bgKey.split(',')) {
      const [tool, id, live] = s.split('|');
      if (tool) m[tool] = { id, live: live === '1' };
    }
    return m;
  }, [bgKey]);
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
          setInbox(m.inbox || []);
          setWaitingOn(m.waitingOn || null);
          setOauth(m.oauth || []);
          setTasks(m.tasks || []);
          setDeltas({});
          setConn('open');
          setLoaded(true);
          retry = 500;
        } else if (m.t === 'ev') {
          const e = m.ev;
          setEvents((list) => [...list, e]);
          // Like Desktop: show the browser when Claude uses it, and new pages/images it writes.
          if (e.k === 'block' && e.block?.type === 'tool_use' && !e.parent) {
            const { name, input } = e.block;
            if (/^mcp__browser__(navigate|click|type)$/.test(name)) ctxRef.current?.openBrowser();
            // Opened once the file is written: before that (e.g. while asking permission) the page doesn't exist yet.
            else if (name === 'Write' && /\.(html?|svg)$/i.test(input?.file_path || '')) pendingArtifacts.current.set(e.block.id, input.file_path);
            // publish_artifact: the path is in its result (content is saved to a file by the server).
            else if (isPublishTool(name)) pendingArtifacts.current.set(e.block.id, null);
          }
          if (e.k === 'tool_result' && pendingArtifacts.current.has(e.toolUseId)) {
            const file = pendingArtifacts.current.get(e.toolUseId) || publishedPath(e.text);
            pendingArtifacts.current.delete(e.toolUseId);
            if (!e.isError && file) setTimeout(() => ctxRef.current?.openArtifact(file, publishedTitle(e.text)), 200);
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
          if (e.k === 'elicit') notify(`${e.server} needs your input`, session.name);
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
          setInbox(m.inbox || []);
          setWaitingOn(m.waitingOn || null);
          setOauth(m.oauth || []);
          setMeta({ ...m.meta, live: m.live });
        } else if (m.t === 'tasks') setTasks(m.tasks || []);
        else if (m.t === 'status') setStatus(m.status);
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
      if (!verbose && it.type === 'tool' && QUIET.has(it.name) && !(it.perm && !it.perm.done) && !it.result?.isError && !it.result?.images?.length) run.push(it);
      else {
        flush();
        out.push(it);
      }
    }
    flush();
    return out;
  }, [items, verbose]);
  const todos = useMemo(() => lastTodos(events), [events]);
  const pendingPerms = items.filter((i) => i.type === 'tool' && i.perm && !i.perm.done).length + items.filter((i) => (i.type === 'perm' || i.type === 'elicit') && !i.done).length;
  const busy = state === 'busy' || state === 'waiting';
  const liveTasks = useMemo(() => tasks.filter(taskLive), [tasks]);
  // Resume shows on an exit error only while it is the latest thing in the chat.
  const lastResumable = busy ? -1 : rows.findLastIndex((r) => ['error', 'user', 'text', 'tool', 'group'].includes(r.type));
  // Rows added after the chat opened always show; only the history above them is held back.
  useEffect(() => {
    if (hidden == null && loaded && rows.length) setHidden(Math.max(0, rows.length - PAGE_ROWS));
  }, [hidden, loaded, rows.length]);
  const start = Math.min(hidden ?? Infinity, Math.max(0, rows.length - PAGE_ROWS));
  const visibleRows = start > 0 ? rows.slice(start) : rows;
  const showEarlier = () => {
    const el = listRef.current;
    if (!el || start <= 0 || growRef.current != null) return;
    growRef.current = el.scrollHeight - el.scrollTop;
    setHidden(Math.max(0, start - PAGE_ROWS));
  };
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
    if (!el) return;
    if (growRef.current != null) {
      // Earlier rows were just added above: keep what you were looking at in place.
      el.scrollTop = el.scrollHeight - growRef.current;
      growRef.current = null;
    } else if (stick) el.scrollTop = el.scrollHeight;
  }, [items, inbox, stick, start]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 400 && start > 0) showEarlier();
  };

  const answer = (a) => send({ t: 'perm', ...a });
  const setMode = (mode) => send({ t: 'mode', mode });
  const submit = (text, images, refs) => {
    const btw = /^\/btw(?:\s+([\s\S]*))?$/.exec((text || '').trim());
    if (btw && !images?.length) {
      setSide({ q: btw[1] || '', key: Date.now() });
      return true;
    }
    // A pasted localhost sign-in address goes to the waiting MCP sign-in, not to Claude.
    if (oauth.length && !images?.length && LOCAL_CALLBACK.test((text || '').trim())) {
      deliverCallback(text, session.id).catch(onError);
      return true;
    }
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    setStick(true);
    return send({ t: 'send', text, images, refs });
  };

  const signIn = (name) => startSignIn(session.id, name, onError);
  const refreshMcp = () => api(`/api/sessions/${session.id}/mcp/status`, { method: 'POST', body: { start: !(meta.mcpServers || []).length } }).catch(() => {});

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
      openArtifact: (p, title) => {
        const abs = /^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${meta.cwd}/${p}`;
        const key = 'art:' + abs;
        if (title) setArtTitles((t) => (t[key] === title ? t : { ...t, [key]: title }));
        setFiles((f) => (f.includes(key) ? f : [...f, key].slice(-6)));
        openPanel(key);
      },
      openBrowser: () => openPanel('browser'),
      openTask: (id) => {
        setTaskFocus(id);
        openPanel('tasks');
      },
      bgTasks,
      openSession: (id) => onSelect(id),
      parentId: meta.parentId || null,
      verbose,
    }),
    [meta.cwd, meta.parentId, onSelect, verbose, bgTasks]
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

  const rename = async () => {
    setMenu(false);
    const name = await promptDialog('Rename chat', meta.name);
    if (name) api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { name } }).catch(onError);
  };
  const archive = () => {
    setMenu(false);
    api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { archived: !meta.archived } }).catch(onError);
  };
  const remove = async () => {
    setMenu(false);
    deleteChat(session)
      .then((done) => done && onDeleted())
      .catch(onError);
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

  const project = meta.noFolder ? 'No folder' : (meta.project || meta.cwd)?.split(/[\\/]/).filter(Boolean).pop();
  const rate = meta.rateLimit?.unifiedWindows?.five_hour;

  return (
    <ChatCtx.Provider value={ctx}>
      <div className="chat-shell">
        <div className="chat-view">
          {side && <SideChat key={side.key} sessionId={session.id} initial={side.q} onClose={() => setSide(null)} />}
          <div className="topbar">
            <IconButton className="menu-btn" onClick={onMenu} aria-label="Menu">
              ☰
            </IconButton>
            <div className="title" onClick={rename} title="Rename">
              <span className="tname">{meta.name}</span>
              <span className="muted tcwd">{project}</span>
              {meta.worktree && <span className="pill mono hide-mobile">⎇ {meta.worktree.branch}</span>}
              {meta.envName && <span className="pill hide-mobile" title="Environment">{meta.envName}</span>}
            </div>
            {parent && (
              <button className="parent-link hide-mobile" onClick={() => onSelect(parent.id)}>
                ↰ {parent.name.slice(0, 30)}
              </button>
            )}
            {conn === 'reconnecting' && <span className="pill warn">reconnecting…</span>}
            <div className="tools">
              <IconButton className={`${terminal ? 'on' : ''}`} title="Terminal" onClick={toggleTerminal}>
                ›_
              </IconButton>
              <IconButton className={`${panel === 'changes' ? 'on' : ''}`} title="Changes and files" onClick={() => (panel === 'changes' ? setPanel(null) : openPanel('changes'))}>
                ± <span className="lbl hide-mobile">Changes</span>
              </IconButton>
              <IconButton className={`${panel === 'browser' ? 'on' : ''}`} title="Browser" onClick={() => (panel === 'browser' ? setPanel(null) : openPanel('browser'))}>
                ◎ <span className="lbl hide-mobile">Browser</span>
              </IconButton>
              <div className="menu-wrap" ref={moreRef}>
                <IconButton title="More" onClick={() => setMenu((m) => !m)}>
                  ⋯
                </IconButton>
                {menu && (
                  <Menu place="down">
                    <button onClick={() => (setMenu(false), openPanel('tasks'))}>
                      Background tasks{liveTasks.length > 0 && <span className="count menu-count">{liveTasks.length}</span>}
                    </button>
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
                    <button className="danger" onClick={remove}>
                      Delete chat
                    </button>
                  </Menu>
                )}
              </div>
            </div>
          </div>

          <div className="messages" ref={listRef} onScroll={onScroll}>
            <div className="messages-inner">
              {!loaded && conn !== 'gone' && <LoadingTranscript />}
              {start > 0 && (
                <button className="show-earlier" onClick={showEarlier}>
                  Show earlier messages ({start})
                </button>
              )}
              {items.length === 0 && conn === 'open' && (
                <div className="welcome">
                  <span className="mark">&gt;_</span>
                  <h2>{meta.noFolder ? 'What can I help with?' : `What are we building in ${project}?`}</h2>
                  <div className="wsub">{meta.cwd}</div>
                </div>
              )}
              {visibleRows.map((it, i) => {
                const n = start + i;
                switch (it.type) {
                  case 'group':
                    return <ToolGroup key={it.key} tools={it.tools} cwd={meta.cwd} />;
                  case 'user':
                    return <UserMessage key={`u${it.index}`} item={it} canEdit={!busy && conn === 'open' && !it.from} onEdit={(index, text) => send({ t: 'edit', index, text })} onFork={busy ? null : fork} onOpen={(id) => sessions?.some((x) => x.id === id) && onSelect?.(id)} />;
                  case 'text':
                    return (
                      <div key={it.key || n} className="msg assistant">
                        <Markdown text={it.text} streaming={it.streaming} />
                        {!it.streaming && (
                          <div className="msg-actions">
                            <IconButton title="Copy" onClick={() => copy(it.text)}>
                              ⧉ <span className="lbl">Copy</span>
                            </IconButton>
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
                  case 'elicit':
                    return <Elicitation key={'el' + it.req.reqId} req={it.req} done={it.done} onAnswer={(a) => send({ t: 'elicit', ...a })} />;
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
                          <Button variant="primary" size="sm" disabled={conn !== 'open'} onClick={() => send({ t: 'resume' })}>
                            ↻ Resume
                          </Button>
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
                    <Button variant="primary" onClick={relogin}>
                      Log in again
                    </Button>
                  </div>
                </div>
              )}
              {children.length > 0 && (
                <div className="notice">
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
                  {items.some((i) => i.type === 'elicit' && !i.done) ? 'Waiting for your input' : pendingPerms ? 'Waiting for your approval' : status === 'compacting' ? 'Compacting…' : 'Working…'}
                </div>
              )}
              {inbox.map((q) => (
                <QueuedMessage
                  key={q.id}
                  item={q}
                  busy={busy}
                  onNow={() => send({ t: 'queue_now', id: q.id })}
                  onRemove={() => send({ t: 'queue_remove', id: q.id })}
                  onEdit={() => {
                    if (!send({ t: 'queue_remove', id: q.id })) return;
                    setInsert({ text: q.text, key: q.id });
                  }}
                  onOpen={(id) => sessions?.some((x) => x.id === id) && onSelect?.(id)}
                />
              ))}
            </div>
          </div>

          {!stick && (
            <button className="jump" onClick={() => setStick(true)}>
              ↓ Latest
            </button>
          )}

          {todos && todos.items.length > 0 && todos.items.some((t) => t.status !== 'completed') && (
            <div className="todo-dock">
              <button className="todo-head" onClick={() => setShowTodos((s) => !s)}>
                <span className="todo-title">{todos.title || 'Tasks'}</span>
                <span className="todo-count">
                  {todos.items.filter((t) => t.status === 'completed').length}/{todos.items.length}
                </span>
                <span className="todo-bar">
                  <span style={{ width: `${(100 * todos.items.filter((t) => t.status === 'completed').length) / todos.items.length}%` }} />
                </span>
                <span className="chev">{showTodos ? '▾' : '▸'}</span>
              </button>
              {showTodos && <Todos todos={todos.items} />}
            </div>
          )}

          {waitingOn && (
            <div className="inbox-bar waiting">
              <span className="dot-pulse" /> Waiting for a reply from{' '}
              <button className="linklike" onClick={() => onSelect?.(waitingOn.id)}>
                {waitingOn.name}
              </button>
              <span>. Claude carries on as soon as it answers.</span>
            </div>
          )}
          <QuoteReply
            listRef={listRef}
            disabled={conn !== 'open'}
            onSend={(text) => submit(text, [])}
            onQuote={(q) => {
              setQuote(q);
              // Focus inside the tap itself so phones open the keyboard.
              listRef.current?.closest('.chat-view')?.querySelector('.composer textarea')?.focus();
            }}
          />
          {liveTasks.length > 0 && panel !== 'tasks' && (
            <BackgroundPill
              tasks={liveTasks}
              onOpen={(id) => {
                setTaskFocus(id);
                openPanel('tasks');
              }}
            />
          )}
          <McpSignInBar sessionId={session.id} flows={oauth} onError={onError} />
          <Composer
            sessionId={session.id}
            initialDraft={meta.draft}
            quote={quote}
            onClearQuote={() => setQuote(null)}
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
            onMcpSignIn={signIn}
            onMcpRefresh={refreshMcp}
            onSettings={onSettings}
            onBrowser={() => openPanel('browser')}
            chats={mentionable}
            context={{ used: meta.contextTokens, window: meta.contextWindow }}
            onCompact={() => submit('/compact', [])}
            insert={insert}
            onError={onError}
          />

          {terminal && drawerSession && (
            <div className="term-drawer">
              <div className="term-drawer-head">
                ›_ Terminal · {meta.cwd}
                <span className="spacer" />
                <IconButton title="Close" onClick={() => setTerminal(false)}>
                  ✕
                </IconButton>
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
            titles={artTitles}
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
            tasks={tasks}
            taskFocus={taskFocus}
          />
        )}
        {info && <InfoDialog meta={meta} onClose={() => setInfo(false)} onSignIn={signIn} />}
      </div>
    </ChatCtx.Provider>
  );
}
