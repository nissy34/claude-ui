import React, { useMemo, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { renderMarkdown } from '../chat/markdown.js';
import { Button, Card, Pill, Spinner, Textarea } from '../ui/index.jsx';
import { promptDialog } from '../ui/dialogs.jsx';
import { STATUS_LABEL, STATUS_TONE, projectAction } from './useProject.js';

export function Md({ text }) {
  const html = useMemo(() => renderMarkdown(text || ''), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function StatusPill({ status, stuck }) {
  if (stuck) return <Pill tone="warn">Stuck</Pill>;
  return (
    <Pill tone={STATUS_TONE[status]} className={`st-${status}`}>
      {status === 'working' && <span className="pulse-dot" />}
      {STATUS_LABEL[status] || status}
    </Pill>
  );
}

export function Progress({ progress }) {
  if (!progress) return null;
  const pct = Math.round((progress.done / Math.max(progress.total, 1)) * 100);
  return (
    <span className="pj-progress" title={`${progress.done} of ${progress.total} steps done`}>
      <span className="bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      {progress.done}/{progress.total}
    </span>
  );
}

export function Checklist({ checklist }) {
  if (!checklist?.steps?.length) return null;
  return (
    <div className="pj-checklist">
      {checklist.title && <div className="cl-title">{checklist.title}</div>}
      {checklist.steps.map((s, i) => (
        <div key={i} className={`cl-step ${s.status}`}>
          <span className="cl-mark">{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '✱' : '○'}</span>
          {s.step}
        </div>
      ))}
    </div>
  );
}

/** A thread as a card: title, live status, checklist progress, last post. */
export function ThreadCard({ projectId, thread, onOpen, onError, compact, actions = true }) {
  const [open, setOpen] = useState(false);
  if (!thread) return null;
  const t = thread;
  const act = (action, body) => projectAction(projectId, t.id, action, body).catch(onError);
  const remind = async () => {
    const v = await promptDialog('Remind in how many minutes?', '60', { ok: 'Snooze' });
    if (v && Number(v) > 0) act('remind', { minutes: Number(v) });
  };
  return (
    <Card className={`pj-thread ${compact ? 'compact' : ''} st-${t.status}`}>
      <div className="pj-thread-head" onClick={() => onOpen?.(t.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen?.(t.id)}>
        <span className="pj-thread-title">{t.title}</span>
        <StatusPill status={t.status} stuck={t.stuck} />
      </div>
      <div className="pj-thread-meta">
        <Progress progress={t.progress} />
        {t.pendingPermissions > 0 && <Pill tone="accent">Permission needed</Pill>}
        {t.pr?.url && (
          <a className="pill blue" href={t.pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            PR #{t.pr.number} {t.pr.state === 'MERGED' ? 'merged' : t.pr.summary?.fail ? `· ${t.pr.summary.fail} failing` : ''}
          </a>
        )}
        {t.sideOf && <Pill>Side question</Pill>}
        {!compact && t.branch && <span className="pill mono">⎇ {t.branch}</span>}
        {t.reminder && <span className="muted small">⏰ {new Date(t.reminder.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
        <span className="muted small">{timeAgo(t.lastActivity)}</span>
      </div>
      {t.error && <div className="pj-thread-error">{t.error}</div>}
      {t.lastPost && !compact && (
        <div className={`pj-lastpost ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
          <span className={`pk pk-${t.lastPost.kind}`}>{t.lastPost.kind}</span>
          {open ? <Md text={t.lastPost.text} /> : <span className="pj-lastpost-text">{t.lastPost.text}</span>}
        </div>
      )}
      {open && <Checklist checklist={t.checklist} />}
      {actions && !compact && (
        <div className="pj-thread-actions">
          <Button size="sm" onClick={() => onOpen?.(t.id)}>
            Open
          </Button>
          {t.status === 'working' && (
            <Button size="sm" variant="ghost" onClick={() => act('stop')}>
              Stop
            </Button>
          )}
          {t.stuck && (
            <Button size="sm" variant="ghost" onClick={() => act('nudge')}>
              Nudge
            </Button>
          )}
          {t.status !== 'resolved' ? (
            <Button size="sm" variant="ghost" onClick={() => act('resolve')}>
              Resolve
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => act('reopen')}>
              Reopen
            </Button>
          )}
          {t.status !== 'resolved' && (
            <Button size="sm" variant="ghost" onClick={t.reminder ? () => act('remind', {}) : remind}>
              {t.reminder ? 'Clear reminder' : 'Remind'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => act('fork')} title="A new thread that starts from this thread's conversation">
            Fork
          </Button>
        </div>
      )}
    </Card>
  );
}

/** A thread the coordinator suggested: Start or Dismiss. */
export function SuggestionCard({ projectId, suggestion, threadTitle, onError, onOpenThread }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!suggestion) return null;
  const sg = suggestion;
  const act = async (action) => {
    setBusy(true);
    try {
      const r = await api(`/api/cprojects/${projectId}/suggestions/${sg.id}`, { method: 'POST', body: { action } });
      if (r.thread) onOpenThread?.(r.thread.id);
    } catch (e) {
      onError?.(e);
    }
    setBusy(false);
  };
  return (
    <Card className={`pj-decision pj-suggestion ${sg.answer ? 'answered' : ''}`}>
      <div className="pj-decision-from">Suggested thread</div>
      <div className="pj-decision-q">{sg.title}</div>
      {sg.reason && <div className="muted small">{sg.reason}</div>}
      <button className="linklike small" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide the brief' : 'Show the brief'}
      </button>
      {open && <Md text={sg.brief} />}
      {!sg.answer ? (
        <div className="pj-suggestion-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => act('start')}>
            Start thread
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('dismiss')}>
            Dismiss
          </Button>
          {busy && <Spinner />}
        </div>
      ) : sg.answer.action === 'start' ? (
        <div className="muted small">
          Started {timeAgo(sg.answer.ts)}
          {sg.answer.thread && (
            <>
              {' · '}
              <button className="linklike" onClick={() => onOpenThread?.(sg.answer.thread)}>
                {threadTitle || 'open thread'}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="muted small">Dismissed {timeAgo(sg.answer.ts)}</div>
      )}
    </Card>
  );
}

/** A decision card: question, options with the recommended one marked; answered or withdrawn state. */
export function DecisionCard({ projectId, decision, threadTitle, onError, onOpenThread }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showNote, setShowNote] = useState(false);
  if (!decision) return null;
  const d = decision;
  const answer = async (i) => {
    setBusy(true);
    try {
      await api(`/api/cprojects/${projectId}/decisions/${d.id}`, { method: 'POST', body: { choice: i, note } });
    } catch (e) {
      onError?.(e);
    }
    setBusy(false);
  };
  const by = d.answer?.by?.kind === 'desktop' ? ' (via Claude Desktop)' : '';
  return (
    <Card className={`pj-decision ${d.answer ? 'answered' : ''}`}>
      <div className="pj-decision-from">
        {d.thread ? (
          <>
            Decision from{' '}
            <button className="linklike" onClick={() => onOpenThread?.(d.thread)}>
              {threadTitle || 'a thread'}
            </button>
          </>
        ) : (
          'Decision from the coordinator'
        )}
        {d.irreversible && <Pill tone="red">Can't be undone</Pill>}
      </div>
      <div className="pj-decision-q">{d.question}</div>
      <div className="pj-decision-opts">
        {d.options.map((o, i) => {
          const chosen = d.answer && !d.answer.withdrawn && d.answer.choice === i;
          return (
            <button key={i} className={`pj-opt ${i === d.recommended ? 'rec' : ''} ${chosen ? 'chosen' : ''}`} disabled={!!d.answer || busy} onClick={() => answer(i)}>
              <span className="pj-opt-label">
                {chosen && '✓ '}
                {o.label}
                {i === d.recommended && <span className="pj-rec">Recommended</span>}
              </span>
              {o.consequence && <span className="pj-opt-cons">{o.consequence}</span>}
            </button>
          );
        })}
      </div>
      {d.reason && !d.answer && <div className="muted small">Why recommended: {d.reason}</div>}
      {!d.answer && (
        <div className="pj-decision-note">
          {showNote ? (
            <Textarea rows={2} placeholder="Optional note sent with your answer" value={note} onChange={(e) => setNote(e.target.value)} />
          ) : (
            <button className="linklike small" onClick={() => setShowNote(true)}>
              Add a note
            </button>
          )}
        </div>
      )}
      {d.answer?.withdrawn && <div className="muted small">Withdrawn</div>}
      {d.answer && !d.answer.withdrawn && (
        <div className="muted small">
          Answered {timeAgo(d.answer.ts)}
          {by}
          {d.answer.note ? ` · “${d.answer.note}”` : ''}
        </div>
      )}
      {busy && <Spinner />}
    </Card>
  );
}

// ---------------------------------------------------------------- "Updated project memory" row
// A collapsed row; open, it shows what changed in MEMORY.md and the memory file(s) as a diff.
export function MemoryUpdate({ body, ts }) {
  const [open, setOpen] = useState(false);
  const names = (body.names || [body.name]).filter(Boolean);
  const actions = body.actions || [body.action];
  const diffs = body.diffs || [];
  const label = actions.every((a) => a === 'deleted') ? 'Removed from project memory' : actions.every((a) => a === 'pinned') ? 'Updated pinned project memory' : 'Updated project memory';
  const shown = names.filter((n) => n !== 'MEMORY.md');
  return (
    <div className={`pj-mem ${open ? 'open' : ''}`}>
      <button className="pj-mem-head" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!diffs.length} title={diffs.length ? (open ? 'Hide the change' : 'Show the change') : undefined}>
        <span>{label}</span>
        {shown.length > 0 && <span className="pj-mem-names">{shown.join(', ')}</span>}
        {diffs.length > 0 && (
          <svg className="pj-mem-chev" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && (
        <div className="pj-mem-body">
          {diffs.map((d) => (
            <div key={d.file} className="pj-mem-file">
              {diffs.length > 1 && (
                <div className="pj-mem-fname">
                  {d.file}
                  <span className="pj-mem-count">
                    {d.added ? <span className="add">+{d.added}</span> : null}
                    {d.removed ? <span className="del">−{d.removed}</span> : null}
                  </span>
                </div>
              )}
              <pre className="pj-mem-diff">
                {d.lines.map(([op, text], i) => (
                  <div key={i} className={op === '+' ? 'add' : op === '-' ? 'del' : op === '…' ? 'gap' : 'ctx'}>
                    <span className="op">{op === '…' ? '' : op === ' ' ? ' ' : op === '-' ? '−' : '+'}</span>
                    {op === '…' ? '…' : text || ' '}
                  </div>
                ))}
                {d.clipped && <div className="gap">… (more lines not shown)</div>}
              </pre>
            </div>
          ))}
        </div>
      )}
      {ts && <div className="pj-mem-ts">{timeAgo(ts)}</div>}
    </div>
  );
}
