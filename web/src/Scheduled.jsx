import React, { useEffect, useState } from 'react';
import { api, timeAgo } from './api.js';
import { MODES } from './chat/Composer.jsx';
import { useModels } from './models.js';

const PRESETS = [
  ['manual', 'Manual (run by hand)'],
  ['once', 'Once'],
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['custom', 'Custom (cron)'],
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describe(t) {
  const at = t.time || '09:00';
  switch (t.preset) {
    case 'manual':
      return 'Manual';
    case 'once':
      return t.runAt ? `Once, ${new Date(t.runAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Once';
    case 'hourly':
      return `Hourly at :${at.split(':')[1] || '00'}`;
    case 'daily':
      return `Daily at ${at}`;
    case 'weekdays':
      return `Weekdays at ${at}`;
    case 'weekly':
      return `${DAYS[t.weekday ?? 1]}s at ${at}`;
    case 'custom':
      return `Cron ${t.cron}`;
    default:
      return t.preset;
  }
}

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const localInput = (ms) => {
  const d = new Date(ms || Date.now() + 3600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function TaskForm({ task, projects, defaultCwd, onSave, onCancel, onError }) {
  const models = useModels();
  const [f, setF] = useState(() => ({
    name: '',
    prompt: '',
    cwd: defaultCwd || projects.projects[0]?.path || '',
    preset: 'daily',
    time: '09:00',
    weekday: 1,
    cron: '0 9 * * 1-5',
    runAt: localInput(),
    permissionMode: 'default',
    model: '',
    worktree: false,
    ...(task ? { ...task, runAt: localInput(task.runAt) } : {}),
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, prompt: f.prompt, cwd: f.cwd, preset: f.preset, time: f.time, weekday: Number(f.weekday), cron: f.cron, runAt: new Date(f.runAt).getTime(), permissionMode: f.permissionMode, model: f.model, worktree: f.worktree };
      await onSave(body);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const folders = [...new Set([f.cwd, ...projects.projects.map((p) => p.path)].filter(Boolean))];
  return (
    <div className="sched-form">
      <label>
        Name
        <input value={f.name} onChange={set('name')} placeholder="Morning build check" autoFocus />
      </label>
      <label>
        Instructions
        <textarea rows={5} value={f.prompt} onChange={set('prompt')} placeholder="Each run starts a new chat with these instructions. Write them as a complete task." />
      </label>
      <label>
        Folder
        <select value={f.cwd} onChange={set('cwd')}>
          {folders.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <div className="sched-row">
        <label>
          Schedule
          <select value={f.preset} onChange={set('preset')}>
            {PRESETS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {['hourly', 'daily', 'weekdays', 'weekly'].includes(f.preset) && (
          <label>
            {f.preset === 'hourly' ? 'Minute' : 'Time'}
            <input type="time" value={f.time} onChange={set('time')} />
          </label>
        )}
        {f.preset === 'weekly' && (
          <label>
            Day
            <select value={f.weekday} onChange={set('weekday')}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {f.preset === 'custom' && (
          <label>
            Cron (local time)
            <input value={f.cron} onChange={set('cron')} placeholder="0 */3 * * *" />
          </label>
        )}
        {f.preset === 'once' && (
          <label>
            When
            <input type="datetime-local" value={f.runAt} onChange={set('runAt')} />
          </label>
        )}
      </div>
      <div className="sched-row">
        <label>
          Permission mode
          <select value={f.permissionMode} onChange={set('permissionMode')}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={f.model} onChange={set('model')}>
            {(models.length ? models : [{ id: '', displayName: 'Default' }]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={!!f.worktree} onChange={set('worktree')} /> Run each time in a fresh git worktree
      </label>
      {f.permissionMode === 'default' && f.preset !== 'manual' && <div className="muted sched-note">Runs nobody watches wait at every permission prompt in "Ask before edits" mode. Pick another mode if this task edits files or runs commands.</div>}
      <div className="sched-actions">
        <button className="btn small ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn small primary" disabled={busy || !f.name.trim() || !f.prompt.trim()} onClick={save}>
          {task ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// Desktop's Scheduled page: prompts that start a new chat on a schedule, on this server.
export default function Scheduled({ projects, defaultCwd, onClose, onOpen, onError }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | task
  const [open, setOpen] = useState(null);
  const load = () =>
    api('/api/schedules')
      .then(setData)
      .catch((e) => (setData({ tasks: [] }), onError(e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn) => async (...a) => {
    try {
      await fn(...a);
      await load();
    } catch (e) {
      onError(e);
    }
  };
  const save = async (body) => {
    if (editing === 'new') await api('/api/schedules', { method: 'POST', body });
    else await api(`/api/schedules/${editing.id}`, { method: 'PATCH', body });
    setEditing(null);
    await load();
  };
  const toggle = act((t) => api(`/api/schedules/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } }));
  const run = act(async (t) => {
    const r = await api(`/api/schedules/${t.id}/run`, { method: 'POST' });
    if (r.run?.sessionId) onOpen(r.run.sessionId);
  });
  const remove = act((t) => window.confirm(`Delete "${t.name}"? Chats from earlier runs stay.`) && api(`/api/schedules/${t.id}`, { method: 'DELETE' }));

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">Scheduled</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {data?.tz ? `Server time zone: ${data.tz}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {!editing && (
            <button className="btn small primary" onClick={() => setEditing('new')}>
              ＋ New task
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {editing ? (
            <TaskForm task={editing === 'new' ? null : editing} projects={projects} defaultCwd={defaultCwd} onSave={save} onCancel={() => setEditing(null)} onError={onError} />
          ) : !data ? (
            <div className="muted">Loading…</div>
          ) : data.tasks.length === 0 ? (
            <div className="panel-empty">
              <div style={{ fontSize: 28, marginBottom: 8 }}>◷</div>
              Run a prompt on a schedule: a morning summary, a nightly test run, a weekly dependency check. Each run starts a new chat on this server, so it runs even when your laptop is closed. You can also ask Claude in any chat to schedule something.
            </div>
          ) : (
            <div className="sched-list">
              {data.tasks.map((t) => (
                <div key={t.id} className={`sched-item ${t.enabled ? '' : 'paused'}`}>
                  <div className="sched-main" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <div className="sched-name">
                      {t.name} {!t.enabled && <span className="pill">{t.preset === 'once' && t.lastRun ? 'Done' : 'Paused'}</span>}
                    </div>
                    <div className="muted sched-meta">
                      {describe(t)} · next {t.enabled && t.nextRun ? when(t.nextRun) : '—'} · last {t.lastRun ? timeAgo(t.lastRun) : 'never'} · {t.cwd.split(/[\\/]/).pop()}
                    </div>
                  </div>
                  <div className="sched-btns">
                    <button className="btn small" onClick={() => run(t)}>
                      Run now
                    </button>
                    <button className="btn small ghost" onClick={() => toggle(t)}>
                      {t.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn small ghost" onClick={() => setEditing(t)}>
                      Edit
                    </button>
                    <button className="icon-btn" title="Delete" onClick={() => remove(t)}>
                      ✕
                    </button>
                  </div>
                  {open === t.id && (
                    <div className="sched-detail">
                      <pre className="sched-prompt">{t.prompt}</pre>
                      <div className="muted" style={{ fontSize: 12, margin: '6px 0 4px' }}>
                        History
                      </div>
                      {(t.history || []).length === 0 && <div className="muted">No runs yet.</div>}
                      {(t.history || []).map((h, i) => (
                        <div key={i} className="sched-run">
                          <span>{when(h.at)}</span>
                          <span className="muted">{h.why}</span>
                          {h.status === 'failed' ? <span style={{ color: 'var(--red)' }}>Failed: {h.error}</span> : h.sessionId ? <button className="link-btn" onClick={() => onOpen(h.sessionId)}>Open chat</button> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
