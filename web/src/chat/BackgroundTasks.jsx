import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, IconButton } from '../ui/index.jsx';

// Background tasks of a chat, like Claude Desktop's "Background tasks" pane: shells Claude started
// with run_in_background, Monitor watches, background agents. Each row shows how long it has run,
// opens to its output (polled while it runs) and can be stopped.

const ICON = { shell: '›_', monitor: '◉', agent: '✳', workflow: '⧉', mcp: '⬡' };
const KIND_LABEL = { shell: 'Shell', monitor: 'Monitor', agent: 'Agent', workflow: 'Workflow', mcp: 'MCP task' };
const ENDED = new Set(['completed', 'failed', 'stopped', 'killed']);

export const isLive = (t) => !ENDED.has(t.status);

export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\r(?!\n)/g, '');

function useNow(on) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function StatusChip({ status }) {
  const label = { running: 'Running', stopping: 'Stopping…', pending: 'Pending', paused: 'Paused', completed: 'Done', failed: 'Failed', stopped: 'Stopped', killed: 'Stopped' }[status] || status;
  return (
    <span className={`bg-status ${status}`}>
      {(status === 'running' || status === 'stopping') && <span className="bg-spin" />}
      {label}
    </span>
  );
}

function TaskOutput({ sessionId, task }) {
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  const stick = useRef(true);
  const live = isLive(task);
  useEffect(() => {
    if (!task.canOutput) return;
    let stop = false;
    let timer;
    const load = () =>
      api(`/api/sessions/${sessionId}/tasks/${encodeURIComponent(task.id)}/output`)
        .then((r) => !stop && (setOut(stripAnsi(r.output || '')), setErr(null)))
        .catch((e) => !stop && setErr(e.message))
        .finally(() => {
          if (!stop && live) timer = setTimeout(load, 1500);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [sessionId, task.id, task.canOutput, live]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [out]);
  if (!task.canOutput) {
    const u = task.usage;
    return (
      <div className="bg-detail">
        {task.summary && <div className="bg-summary">{task.summary}</div>}
        {task.lastTool && live && <div className="muted">Last step: {task.lastTool}</div>}
        {u && (
          <div className="muted">
            {u.tool_uses} tool use{u.tool_uses === 1 ? '' : 's'} · {Math.round((u.total_tokens || 0) / 100) / 10}k tokens
          </div>
        )}
        {!task.summary && !u && <div className="muted">{live ? 'Working…' : 'No report.'}</div>}
      </div>
    );
  }
  return (
    <pre
      className="bg-output"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {err && out === null ? `Couldn't read the output: ${err}` : out === null ? 'Loading…' : out || (live ? 'No output yet.' : 'No output.')}
    </pre>
  );
}

function TaskRow({ sessionId, task, now, open, onToggle, onError }) {
  const live = isLive(task);
  const title = task.description || task.command || task.id;
  const stop = (e) => {
    e.stopPropagation();
    api(`/api/sessions/${sessionId}/tasks/${encodeURIComponent(task.id)}/stop`, { method: 'POST' }).catch(onError);
  };
  const dismiss = (e) => {
    e.stopPropagation();
    api(`/api/sessions/${sessionId}/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }).catch(onError);
  };
  return (
    <div className={`bg-task ${live ? 'is-live' : 'is-ended'} ${open ? 'is-open' : ''}`}>
      <div className="bg-row" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle())}>
        <span className={`bg-icon ${task.kind}`}>{ICON[task.kind] || '•'}</span>
        <span className="bg-main">
          <span className="bg-title" title={title}>
            {title}
          </span>
          <span className="bg-sub">
            {KIND_LABEL[task.kind] || 'Task'}
            {task.agentType && task.kind === 'agent' ? ` · ${task.agentType}` : ''} · {elapsed((task.endedAt || now) - task.startedAt)}
            {task.error && !live ? ` · ${task.error}` : ''}
          </span>
        </span>
        <StatusChip status={task.status} />
        {live ? (
          <Button variant="ghost" size="sm" className="bg-stop" title="Stop this task" disabled={task.status === 'stopping'} onClick={stop}>
            ■<span className="hide-mobile"> Stop</span>
          </Button>
        ) : (
          <IconButton className="bg-dismiss" title="Remove from the list" onClick={dismiss}>
            ✕
          </IconButton>
        )}
      </div>
      {open && (
        <div className="bg-body">
          {task.command && task.command !== title && <code className="bg-cmd">$ {task.command}</code>}
          <TaskOutput sessionId={sessionId} task={task} />
        </div>
      )}
    </div>
  );
}

export default function BackgroundTasks({ sessionId, tasks, onError, focus }) {
  const [open, setOpen] = useState(() => new Set(focus ? [focus] : []));
  useEffect(() => {
    if (focus) setOpen((s) => new Set(s).add(focus));
  }, [focus]);
  const live = tasks.filter(isLive);
  const ended = tasks.filter((t) => !isLive(t)).reverse();
  const now = useNow(live.length > 0);
  const toggle = (id) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const row = (t) => <TaskRow key={t.id} sessionId={sessionId} task={t} now={now} open={open.has(t.id)} onToggle={() => toggle(t.id)} onError={onError} />;
  if (!tasks.length)
    return (
      <div className="panel-empty bg-empty">
        <div className="bg-empty-icon">◇</div>
        <div>No background tasks</div>
        <div className="muted">Commands Claude runs in the background, Monitor watches and background agents show up here while they run.</div>
      </div>
    );
  return (
    <div className="bg-tasks">
      {live.length > 0 && (
        <>
          <div className="bg-section">Running · {live.length}</div>
          {live.map(row)}
        </>
      )}
      {ended.length > 0 && (
        <>
          <div className="bg-section">Finished · {ended.length}</div>
          {ended.map(row)}
        </>
      )}
    </div>
  );
}

/** Above the message box while tasks run, like the CLI's status line: tap to open the pane. */
export function BackgroundPill({ tasks, onOpen }) {
  const now = useNow(true);
  const one = tasks.length === 1 ? tasks[0] : null;
  return (
    <button className="bg-pill" title="Show background tasks" onClick={() => onOpen(one?.id || null)}>
      <span className="bg-spin" />
      <span className="bg-pill-text">{one ? one.description || one.command || 'Background task' : `${tasks.length} background tasks running`}</span>
      {one && <span className="bg-pill-time">{elapsed(now - one.startedAt)}</span>}
    </button>
  );
}
