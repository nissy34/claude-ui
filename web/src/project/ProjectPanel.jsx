// The project page's right-hand panel: Threads (grouped by status, open one in place) and Context
// (instructions, memory, files). The project chat stays on the left.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Button, IconButton, Input, Menu, MenuSeparator, Modal, ModalBody, ModalHead, Spinner, Textarea } from '../ui/index.jsx';
import { confirmDialog, promptDialog } from '../ui/dialogs.jsx';
import { DecisionCard, Md } from './ProjectCards.jsx';
import { ProjectMemory } from './ProjectFiles.jsx';
import { projectAction } from './useProject.js';
import { ProjectUsageRing } from './ProjectUsage.jsx';

const short = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const plain = (md) =>
  String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
const modelName = (m) => (!m ? 'Default model' : m.length < 10 ? m[0].toUpperCase() + m.slice(1) : m);
const kb = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

// ---------------------------------------------------------------- icons
export function StatusIcon({ status }) {
  const c = { width: 18, height: 18, viewBox: '0 0 18 18', className: `pjp-icon st-${status}`, 'aria-hidden': true };
  if (status === 'waiting')
    return (
      <svg {...c}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M7.3 6v6M10.7 6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (status === 'working' || status === 'landing')
    return (
      <svg {...c} className={`${c.className} spin`}>
        <path d="M9 2a7 7 0 1 1-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (status === 'resolved')
    return (
      <svg {...c}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.8 9.2l2.2 2.2 4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === 'snoozed')
    return (
      <svg {...c}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 5.5V9l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  // idle, queued, review: a dashed ring (queued gets a dot)
  return (
    <svg {...c}>
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 2.6" />
      {status === 'queued' && <circle cx="9" cy="9" r="1.8" fill="currentColor" />}
    </svg>
  );
}

export const PrIcon = ({ merged }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    {merged ? (
      <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 0v9M3.5 12.5a1.5 1.5 0 1 0 0 .01M12.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 0c0-4-4-5.5-9-5.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    ) : (
      <path d="M4 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0v6m0 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 0V6.5c0-1.4-1-2.5-2.5-2.5H8m0 0 1.6-1.6M8 4l1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    )}
  </svg>
);

export function PrChip({ pr }) {
  if (!pr?.url) return null;
  const st = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.state === 'DRAFT' ? 'draft' : 'open';
  return (
    <a className={`pjp-pr ${st}`} href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`${pr.title || ''} · ${st}${pr.summary?.fail ? ` · ${pr.summary.fail} failing` : ''}`}>
      <PrIcon merged={st === 'merged'} />#{pr.number}
      {pr.summary?.fail ? <span className="pjp-fail">{pr.summary.fail}✕</span> : null}
    </a>
  );
}

/** One line on what a thread needs from you, or what it last said. */
export function threadLine(t, decisions) {
  if (t.status === 'waiting') {
    const d = decisions.find((x) => x.thread === t.id && !x.answer);
    if (d) return `Decision: ${d.question}`;
    if (t.pendingPermissions) return 'Needs your permission to continue';
    if (t.error) return t.error;
  }
  if (t.status === 'queued') return 'Queued: waiting for a free slot';
  if (t.stuck) return 'No activity for a while: open it to check, or nudge it';
  return t.lastPost ? plain(t.lastPost.text) : plain(t.checklist?.steps?.find((s) => s.status === 'in_progress')?.step || '');
}

// ---------------------------------------------------------------- the panel
export default function ProjectPanel({ project, tab, setTab, threadId, openThread, onSelect, onError, onNewThread, reload, onFullUsage }) {
  const waiting = project.threads.filter((t) => t.status === 'waiting').length;
  if (threadId && project.threads.some((t) => t.id === threadId))
    return <ThreadPane project={project} threadId={threadId} onBack={() => openThread(null)} onSelect={onSelect} openThread={openThread} onError={onError} onFullUsage={onFullUsage} />;
  return (
    <div className="pjp">
      <div className="pjp-head">
        <div className="pjp-tabs" role="tablist">
          <button role="tab" className={tab === 'threads' ? 'on' : ''} onClick={() => setTab('threads')}>
            Threads {waiting > 0 && <span className="pjp-badge">{waiting}</span>}
          </button>
          <button role="tab" className={tab === 'context' ? 'on' : ''} onClick={() => setTab('context')}>
            Context
          </button>
          {project.view && (
            <button role="tab" className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>
              Custom view
            </button>
          )}
          {!project.view && (
            <button className="pjp-tab-add" title="Add a Custom view: a page Claude keeps up to date, like a dashboard or a checklist" onClick={() => api(`/api/cprojects/${project.id}/view`, { method: 'POST', body: {} }).then(() => (reload(), setTab('view'))).catch(onError)}>
              ＋
            </button>
          )}
        </div>
        <span className="spacer" />
        {tab === 'threads' && (
          <IconButton size="sm" title="Start a thread yourself" onClick={onNewThread}>
            ＋
          </IconButton>
        )}
      </div>
      {tab === 'view' && project.view ? <ViewTab project={project} onError={onError} reload={reload} onRemoved={() => setTab('threads')} /> : tab === 'context' ? <ContextTab project={project} onError={onError} reload={reload} /> : <ThreadsList project={project} openThread={openThread} />}
    </div>
  );
}

// ---------------------------------------------------------------- custom view
function ViewTab({ project, onError, reload, onRemoved }) {
  const v = project.view;
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const ask = () => window.dispatchEvent(new CustomEvent('cw-pj-draft', { detail: { project: project.id, text: 'Make a custom view for this project: ' } }));
  const post = (body) => api(`/api/cprojects/${project.id}/view`, { method: 'POST', body }).then(reload).catch(onError);
  return (
    <div className="pjp-body pjp-view">
      {v.empty ? (
        <div className="pjp-view-empty">
          <div className="pjp-view-ico">◰</div>
          <b>Nothing here yet</b>
          <p className="muted small">Pin a page to see it here, or ask Claude to make one, like a dashboard, a checklist or a weekly digest.</p>
          <div className="pjp-view-actions">
            <Button size="sm" onClick={() => setPicking(true)}>
              Pin a page
            </Button>
            <Button size="sm" onClick={ask}>
              Ask Claude
            </Button>
          </div>
          <button className="linklike small muted" onClick={() => post({ remove: true }).then(onRemoved)}>
            Remove this tab
          </button>
        </div>
      ) : (
        <>
          <div className="pjp-view-bar">
            <span className="pjp-view-title" title={v.path}>
              {v.title}
            </span>
            <span className="spacer" />
            {v.url && (
              <a className="small" href={v.url} target="_blank" rel="noreferrer">
                Open ↗
              </a>
            )}
            <div className="menu-wrap">
              <IconButton size="sm" title="More" onClick={() => setMenu((m) => !m)}>
                ⋯
              </IconButton>
              {menu && (
                <Menu place="down" align="end">
                  <button onClick={() => (setMenu(false), setPicking(true))}>Pin another page…</button>
                  <button onClick={() => (setMenu(false), ask())}>Ask Claude to change it</button>
                  <button onClick={() => (setMenu(false), post({ remove: true }).then(onRemoved))}>Remove the Custom view</button>
                </Menu>
              )}
            </div>
          </div>
          {v.missing ? <div className="pjp-ctx-row muted">The pinned file is gone: {v.path}</div> : <iframe key={v.mtime} className="pjp-view-frame" src={v.url} title={v.title} sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" />}
        </>
      )}
      {picking && <PinPicker project={project} onClose={() => setPicking(false)} onPick={(a) => (setPicking(false), post({ session: a.sessionId, path: a.path, title: a.title || a.name }))} onError={onError} />}
    </div>
  );
}

function PinPicker({ project, onClose, onPick, onError }) {
  const [arts, setArts] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api(`/api/artifacts?cproject=${encodeURIComponent(project.id)}`)
      .then((r) => setArts(r.artifacts.filter((a) => /^(html?|svg|md)$/.test(a.ext))))
      .catch(onError);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (arts || []).filter((a) => !q || `${a.title || ''} ${a.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal onClose={onClose}>
      <ModalHead onClose={onClose}>Pin a page</ModalHead>
      <ModalBody>
        <Input autoFocus placeholder="Search pages" value={q} onChange={(e) => setQ(e.target.value)} />
        {!arts && <Spinner />}
        {arts?.length === 0 && <p className="muted small">This project has no pages yet. Ask Claude to make one.</p>}
        <div className="pjp-pick-list">
          {shown.map((a) => (
            <button key={a.sessionId + a.path} className="pjp-pick" onClick={() => onPick(a)}>
              <b>{a.title || a.name}</b>
              <span className="muted small">{project.threads.find((t) => t.id === a.sessionId)?.title || a.sessionName || ''}</span>
            </button>
          ))}
        </div>
      </ModalBody>
    </Modal>
  );
}

const GROUPS = [
  ['waiting', 'Waiting on you', ['waiting']],
  ['working', 'Working', ['working', 'queued', 'landing']],
  ['idle', 'Idle', ['review', 'idle', 'snoozed']],
];

function ThreadsList({ project, openThread }) {
  // Resolved starts folded, unless nothing else is open.
  const [closed, setClosed] = useState(() => ({ resolved: project.threads.some((t) => t.status !== 'resolved') }));
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = project.threads.filter((t) => !needle || t.title.toLowerCase().includes(needle));
  const groups = [...GROUPS.map(([k, label, sts]) => [k, label, list.filter((t) => sts.includes(t.status))]), ['resolved', 'Resolved', list.filter((t) => t.status === 'resolved')]];
  return (
    <div className="pjp-body">
      {project.threads.length > 6 && <input className="pjp-search" placeholder="Find a thread" value={q} onChange={(e) => setQ(e.target.value)} />}
      {project.threads.length === 0 && <div className="pjp-empty">No threads yet. Ask in the project chat and the coordinator starts them, or press ＋.</div>}
      {groups.map(([k, label, items]) =>
        items.length ? (
          <section key={k} className="pjp-group">
            <button className="pjp-group-head" onClick={() => setClosed((c) => ({ ...c, [k]: !c[k] }))}>
              {label} · {items.length} <span className="chev">{closed[k] ? '›' : '⌄'}</span>
            </button>
            {!closed[k] &&
              items
                .sort((a, b) => b.lastActivity - a.lastActivity)
                .map((t) => <ThreadRow key={t.id} t={t} project={project} onOpen={() => openThread(t.id)} />)}
          </section>
        ) : null
      )}
    </div>
  );
}

function ThreadRow({ t, project, onOpen }) {
  const line = threadLine(t, project.decisions);
  const extras = t.pr?.url || t.sideOf;
  return (
    <div className={`pjp-row st-${t.status}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <StatusIcon status={t.stuck ? 'waiting' : t.status} />
      <div className="pjp-row-main">
        <div className="pjp-row-top">
          <span className="pjp-row-title">{t.title}</span>
          <span className="pjp-row-time">{short(t.lastActivity)}</span>
        </div>
        {line && <div className="pjp-row-line">{line}</div>}
        {extras && (
          <div className="pjp-row-extras">
            {t.sideOf && <span className="pjp-chip">side question</span>}
            <PrChip pr={t.pr} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one thread, in the panel
function ThreadPane({ project, threadId, onBack, onSelect, openThread, onError, onFullUsage }) {
  const t = project.threads.find((x) => x.id === threadId);
  const [feed, setFeed] = useState(null);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    api(`/api/cprojects/${project.id}/threads/${threadId}/feed`)
      .then((r) => setFeed(r.feed))
      .catch(onError);
  }, [project.id, threadId, t?.lastActivity, project.lastActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [feed?.length, threadId]);
  const act = (a, body) => projectAction(project.id, threadId, a, body).catch(onError);
  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      await api(`/api/cprojects/${project.id}/threads/${threadId}/message`, { method: 'POST', body: { text: v } });
      setText('');
    } catch (e) {
      onError(e);
    }
    setSending(false);
  };
  const side = async () => {
    setMenu(false);
    const q = await promptDialog('Side question', '', { ok: 'Ask', placeholder: 'What do you want to know?' });
    if (!q?.trim()) return;
    try {
      const r = await api(`/api/cprojects/${project.id}/threads/${threadId}/side`, { method: 'POST', body: { question: q } });
      openThread(r.thread.id);
    } catch (e) {
      onError(e);
    }
  };
  const remind = async () => {
    setMenu(false);
    const v = await promptDialog('Remind in how many minutes?', '60', { ok: 'Snooze' });
    if (v && Number(v) > 0) act('remind', { minutes: Number(v) });
  };
  const decisions = Object.fromEntries(project.decisions.map((d) => [d.id, d]));
  const lastChecklist = feed ? [...feed].reverse().find((e) => e.type === 'checklist.updated')?.id : null;
  const threadTitle = (id) => project.threads.find((x) => x.id === id)?.title;
  // Previous / next in the order the Threads list shows (most recent activity first).
  const order = [...project.threads].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).map((x) => x.id);
  const at = order.indexOf(threadId);
  const prevId = at > 0 ? order[at - 1] : null;
  const nextId = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  return (
    <div className="pjp">
      <div className="pjp-head">
        <div className="pjp-crumbs">
          <button className="linklike" onClick={onBack}>
            Threads
          </button>
          <span className="sep">›</span>
          <span className="pjp-crumb-title" title={t.title}>
            {t.title}
          </span>
        </div>
        {t.status === 'working' ? (
          <IconButton size="sm" title="Stop" onClick={() => act('stop')}>
            ■
          </IconButton>
        ) : null}
        <IconButton size="sm" title={t.status === 'resolved' ? 'Reopen' : 'Resolve'} className={t.status === 'resolved' ? 'on' : ''} onClick={() => act(t.status === 'resolved' ? 'reopen' : 'resolve')}>
          ✓
        </IconButton>
        <div className="menu-wrap">
          <IconButton size="sm" title="More" onClick={() => setMenu((m) => !m)}>
            ⋯
          </IconButton>
          {menu && (
            <Menu place="down">
              <button disabled={!prevId} onClick={() => (setMenu(false), openThread(prevId))}>Previous thread</button>
              <button disabled={!nextId} onClick={() => (setMenu(false), openThread(nextId))}>Next thread</button>
              <MenuSeparator />
              <button onClick={side}>Side question…</button>
              <button onClick={remind}>{t.reminder ? 'Change reminder…' : 'Remind me…'}</button>
              {t.reminder && <button onClick={() => (setMenu(false), act('remind', {}))}>Clear reminder</button>}
              <button onClick={() => (setMenu(false), act('fork').then((r) => r?.thread && openThread(r.thread.id)))}>Fork</button>
              {t.stuck && <button onClick={() => (setMenu(false), act('nudge'))}>Nudge</button>}
              <button onClick={() => (setMenu(false), onSelect(threadId))}>Open the work log</button>
            </Menu>
          )}
        </div>
        <IconButton size="sm" title="Open as a full chat (work log, files, terminal)" onClick={() => onSelect(threadId)}>
          ⤢
        </IconButton>
      </div>
      <div className="pjp-body pjp-thread" ref={ref}>
        {!feed && <Spinner />}
        {feed?.map((e) => {
          const b = e.body || {};
          switch (e.type) {
            case 'thread.started':
              return (
                <div key={e.id} className="pjp-msg user">
                  <div className="pjp-fwd">{b.adopted ? 'Moved in from a regular chat' : e.from?.kind === 'user' ? 'Started by you' : e.from?.kind === 'desktop' ? 'From Claude Desktop' : 'Forwarded from project chat'} ↰</div>
                  <div className="pjp-bubble">
                    <ClampText text={b.brief} />
                  </div>
                </div>
              );
            case 'user.message':
              return (
                <div key={e.id} className="pjp-msg user">
                  <div className="pjp-bubble">{b.text}</div>
                </div>
              );
            case 'session.message':
              return e.from?.id === threadId ? (
                <div key={e.id} className="pjp-msg">
                  <div className="pjp-fwd left">To the coordinator</div>
                  <Md text={b.text} />
                </div>
              ) : (
                <div key={e.id} className="pjp-msg user">
                  <div className="pjp-fwd">{e.from?.kind === 'desktop' ? 'From Claude Desktop' : e.from?.kind === 'thread' ? `From ${threadTitle(e.from.id) || 'a thread'}` : 'Forwarded from project chat'} ↰</div>
                  <div className="pjp-bubble">{b.text}</div>
                </div>
              );
            case 'checklist.updated':
              return e.id === lastChecklist ? (
                <div key={e.id} className="pjp-cl">
                  {(t.checklist?.steps || b.steps || []).map((s, i) => (
                    <div key={i} className={`pjp-cl-step ${s.status}`}>
                      <span className="mk">{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '' : ''}</span>
                      {s.step}
                    </div>
                  ))}
                </div>
              ) : null;
            case 'thread.post':
              return (
                <div key={e.id} className="pjp-msg">
                  {b.kind !== 'result' && <span className={`pk pk-${b.kind}`}>{b.kind}</span>}
                  <Md text={b.text} />
                  <div className="pjp-time">{new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                </div>
              );
            case 'decision.requested':
              return <DecisionCard key={e.id} projectId={project.id} decision={decisions[b.id]} threadTitle={t.title} onError={onError} />;
            case 'pr.updated':
              if (b.quiet) return null;
              return (
                <div key={e.id} className="pjp-note">
                  {b.summary}
                </div>
              );
            case 'reminder.set':
              return (
                <div key={e.id} className="pjp-note">
                  ⏰ Snoozed until {new Date(b.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  {b.note ? `: ${b.note}` : ''}
                </div>
              );
            case 'thread.resolved':
              return (
                <div key={e.id} className="pjp-note">
                  ✓ Resolved{b.auto ? ` (${b.auto})` : ''}
                </div>
              );
            case 'thread.reopened':
              return (
                <div key={e.id} className="pjp-note">
                  Reopened
                </div>
              );
            case 'notice':
              return (
                <div key={e.id} className="pjp-note">
                  {b.text}
                </div>
              );
            // What passed between threads: notes this thread shared, notes handed to it, signals about it.
            case 'note.shared':
              return (
                <div key={e.id} className="pjp-note pjp-act" title={b.files?.length ? b.files.join(', ') : undefined}>
                  <span className="pjp-act-k">↗ Shared {NOTE_LABEL[b.kind] || b.kind}</span> {b.text}
                  <span className="muted">
                    {' '}
                    · {(b.pushTo || []).filter((x) => x !== project.coordinatorId).length ? `handed to ${(b.pushTo || []).filter((x) => x !== project.coordinatorId).map((x) => threadTitle(x) || 'a thread').join(', ')}` : 'searchable'}
                  </span>
                </div>
              );
            case 'notes.delivered':
              return (
                <div key={e.id} className="pjp-note pjp-act">
                  <span className="pjp-act-k">↘ {b.via === 'tool' ? 'Handed notes mid-turn' : 'Handed notes'}</span>
                  {b.notes.map((n) => (
                    <div key={n.id} className="pjp-act-line">
                      {NOTE_LABEL[n.kind] || n.kind} from {n.from}: {n.text}
                    </div>
                  ))}
                </div>
              );
            case 'memory.changed':
              return (
                <div key={e.id} className="pjp-note pjp-act">
                  <span className="pjp-act-k">{b.action === 'delete' ? 'Removed from project memory' : 'Updated project memory'}</span> {(b.names || [b.name]).join(', ')}
                </div>
              );
            case 'signal':
              return (
                <div key={e.id} className="pjp-note pjp-act warn">
                  <span className="pjp-act-k">⚑ {SIGNAL_LABEL[b.kind] || b.kind}</span> {b.text}
                </div>
              );
            default:
              return null;
          }
        })}
        {t.status === 'working' && (
          <div className="pjp-typing">
            <Spinner /> Working…
          </div>
        )}
        {t.pendingPermissions > 0 && (
          <div className="pjp-note warn">
            It needs your permission to continue.{' '}
            <button className="linklike" onClick={() => onSelect(threadId)}>
              Answer in the work log
            </button>
          </div>
        )}
      </div>
      {t.pr?.url && (
        <a className={`pjp-prbar ${t.pr.state === 'MERGED' ? 'merged' : t.pr.state === 'CLOSED' ? 'closed' : 'open'}`} href={t.pr.url} target="_blank" rel="noreferrer">
          <PrIcon merged={t.pr.state === 'MERGED'} /> <b>#{t.pr.number}</b> <span className="mono pjp-prbar-branch">{t.pr.head || t.branch}</span>
          {t.pr.additions != null && (
            <span className="pjp-diffstat">
              <span className="add">+{t.pr.additions}</span> <span className="del">−{t.pr.deletions}</span>
            </span>
          )}
          <span className="spacer" />
          {t.pr.summary && t.pr.summary.pass + t.pr.summary.fail + t.pr.summary.pending > 0 && !t.pr.summary.fail && <span className="muted small">{t.pr.summary.pending ? `${t.pr.summary.pending} checks running · ` : 'Checks pass · '}</span>}
          {t.pr.state === 'MERGED' ? 'Merged' : t.pr.state === 'CLOSED' ? 'Closed' : t.pr.summary?.fail ? `${t.pr.summary.fail} failing` : t.pr.review === 'APPROVED' ? 'Approved' : 'Open'}
        </a>
      )}
      {!t.pr?.url && t.branch && (
        <div className="pjp-prbar none">
          <span className="mono">⎇ {t.branch}</span>
        </div>
      )}
      <div className="pjp-composer">
        <textarea
          rows={1}
          value={text}
          placeholder="Steer this thread…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="pjp-composer-foot">
          <span className="muted small">{t.status === 'working' ? 'Delivered when its current step ends' : t.status === 'resolved' ? 'Sending reopens it' : ''}</span>
          <span className="spacer" />
          <span className="muted small">
            {modelName(t.model)} {t.effort ? t.effort[0].toUpperCase() + t.effort.slice(1) : ''}
          </span>
          <ProjectUsageRing project={project} context={t.context} currentThread={t.id} onOpenThread={openThread} onFullUsage={onFullUsage} />
          <button className="pjp-send" disabled={!text.trim() || sending} onClick={send} aria-label="Send">
            ↵
          </button>
        </div>
      </div>
    </div>
  );
}

function ClampText({ text }) {
  const [open, setOpen] = useState(false);
  const long = (text || '').length > 400;
  return (
    <>
      {open || !long ? text : text.slice(0, 400) + '…'}
      {long && (
        <button className="linklike small pjp-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------- context
const NOTE_LABEL = { fix: 'fix', gotcha: 'gotcha', reusable: 'reusable helper', fact: 'fact', warning: 'warning', decision: 'your decision' };
const SIGNAL_LABEL = { overlap: 'File overlap', stuck: 'Possibly stuck', dependency_landed: 'Dependency landed' };

function ActivityRow({ a, project, onRetract }) {
  const title = (id) => project.threads.find((t) => t.id === id)?.title || (id === 'user' ? 'You' : id);
  const when = short(a.ts);
  if (a.type === 'note')
    return (
      <div className="pjp-ctx-row pjp-act-row" title={a.files?.length ? a.files.join(', ') : undefined}>
        <span className={`pjp-kind k-${a.kind}`}>{NOTE_LABEL[a.kind] || a.kind}</span>
        <span className="pjp-act-text">
          {a.text}
          <span className="muted">
            {' '}
            · {a.from === 'user' ? 'you' : title(a.from)}
            {a.to?.length ? ` → ${a.to.map(title).join(', ')}` : a.kind === 'decision' ? '' : ' · searchable'}
          </span>
        </span>
        {a.kind !== 'decision' && (
          <button className="pjp-ctx-del" title="Retract this note" onClick={() => onRetract(a.noteId)}>
            ✕
          </button>
        )}
        <span className="pjp-row-time">{when}</span>
      </div>
    );
  if (a.type === 'signal')
    return (
      <div className="pjp-ctx-row pjp-act-row">
        <span className="pjp-kind k-signal">{SIGNAL_LABEL[a.kind] || a.kind}</span>
        <span className="pjp-act-text">{a.text}</span>
        <span className="pjp-row-time">{when}</span>
      </div>
    );
  if (a.type === 'delivered')
    return (
      <div className="pjp-ctx-row pjp-act-row muted">
        <span className="pjp-kind">handed</span>
        <span className="pjp-act-text">
          {a.notes.length} note{a.notes.length > 1 ? 's' : ''} to {a.to === project.coordinatorId ? 'the coordinator' : title(a.to)} {a.via === 'tool' ? 'mid-turn' : 'with its wake'}
        </span>
        <span className="pjp-row-time">{when}</span>
      </div>
    );
  return null;
}

function ContextTab({ project, onError, reload }) {
  const [open, setOpen] = useState({ instructions: true, memory: false, files: true, artifacts: true, activity: false });
  const [arts, setArts] = useState(null);
  const [mem, setMem] = useState(null);
  const [lib, setLib] = useState(null);
  const [editing, setEditing] = useState(null); // instructions text while editing
  const [memModal, setMemModal] = useState(null); // file name, or '' for the list
  const [dirs, setDirs] = useState({});
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () => {
    api(`/api/cprojects/${project.id}/memory`)
      .then((r) => setMem(r.files))
      .catch(onError);
    api(`/api/cprojects/${project.id}/library`)
      .then(setLib)
      .catch(onError);
    api(`/api/artifacts?cproject=${encodeURIComponent(project.id)}&published=1`)
      .then((r) => setArts(r.artifacts))
      .catch(onError);
  };
  useEffect(load, [project.id, project.lastActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => {
    const top = new Map();
    for (const f of lib?.files || []) {
      const [head, ...rest] = f.path.split('/');
      if (!rest.length) top.set(f.path, { file: f });
      else {
        const d = top.get(head) || { dir: head, files: [], modified: 0, size: 0 };
        d.files.push({ ...f, name: rest.join('/') });
        d.modified = Math.max(d.modified, f.modified);
        d.size += f.size;
        top.set(head, d);
      }
    }
    return [...top.values()].sort((a, b) => (b.modified || b.file?.modified || 0) - (a.modified || a.file?.modified || 0));
  }, [lib]);
  const used = (lib?.files || []).reduce((n, f) => n + f.size, 0);
  const saveInstructions = async () => {
    try {
      await api(`/api/cprojects/${project.id}`, { method: 'PATCH', body: { instructions: editing } });
      setEditing(null);
      reload();
    } catch (e) {
      onError(e);
    }
  };
  const upload = async (list) => {
    setBusy(true);
    for (const f of list) {
      if (f.size > 25 << 20) {
        onError(new Error(`${f.name} is over 25 MB`));
        continue;
      }
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      await api(`/api/cprojects/${project.id}/library`, { method: 'POST', body: { name: f.name, data } }).catch(onError);
    }
    setBusy(false);
    load();
  };
  const del = async (p) => {
    if (!(await confirmDialog(`Delete ${p}?`, { title: 'Delete file', ok: 'Delete', danger: true }))) return;
    await api(`/api/cprojects/${project.id}/library/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' }).catch(onError);
    load();
  };
  const href = (p) => `/api/cprojects/${project.id}/library/file?path=${encodeURIComponent(p)}`;
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const instr = project.settings.instructions || '';
  const FileRow = ({ f, name, depth = 0 }) => (
    <div className="pjp-ctx-row file" style={{ paddingLeft: 30 + depth * 18 }}>
      <span className="pjp-ico">▤</span>
      <a className="pjp-ctx-name" href={href(f.path)} download title={`${f.path} · ${kb(f.size)}`}>
        {name}
      </a>
      <button className="pjp-ctx-del" title="Delete" onClick={() => del(f.path)}>
        ✕
      </button>
      <span className="pjp-row-time">{short(f.modified)}</span>
    </div>
  );
  return (
    <div
      className="pjp-body pjp-ctx"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) upload([...e.dataTransfer.files]);
      }}
    >
      <div className="pjp-ctx-top">
        <span className="muted">Every session in the project reads this</span>
        <span className="spacer" />
        <button className="linklike" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : '＋ Add context'}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => (upload([...e.target.files]), (e.target.value = ''))} />
      </div>

      <button className="pjp-ctx-sec" onClick={() => toggle('instructions')}>
        <span className="chev">{open.instructions ? '⌄' : '›'}</span> Instructions <span className="muted">{instr.trim() ? 1 : 0}</span>
      </button>
      {open.instructions &&
        (editing !== null ? (
          <div className="pjp-ctx-edit">
            <Textarea rows={6} autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} placeholder="Standing rules for every session, e.g. Open a draft PR for every change. Never touch the payments module." />
            <div className="pjp-ctx-actions">
              <span className="muted small">{editing.length} / 16,000</span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={saveInstructions}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="pjp-ctx-row" role="button" tabIndex={0} onClick={() => setEditing(instr)}>
            <span className="pjp-ico">✎</span>
            <span className="pjp-ctx-name">Project instructions</span>
            <span className="muted pjp-ctx-desc">{instr.trim() ? plain(instr).slice(0, 80) : 'None yet'}</span>
          </div>
        ))}

      <button className="pjp-ctx-sec" onClick={() => toggle('memory')}>
        <span className="chev">{open.memory ? '⌄' : '›'}</span> Memory <span className="muted">{mem?.length ?? ''}</span>
      </button>
      {open.memory && (
        <>
          {mem?.length === 0 && <div className="pjp-ctx-row muted">Nothing remembered yet. Threads and the coordinator save facts here.</div>}
          {mem?.map((f) => (
            <div key={f.name} className="pjp-ctx-row" role="button" tabIndex={0} onClick={() => setMemModal(f.name)}>
              <span className="pjp-ico">◇</span>
              <span className="pjp-ctx-name">{f.name}</span>
              <span className="muted pjp-ctx-desc">{f.description}</span>
              <span className="pjp-row-time">{short(Date.parse(f.modified))}</span>
            </div>
          ))}
          <button className="linklike small pjp-ctx-add" onClick={() => setMemModal('')}>
            Manage memory
          </button>
        </>
      )}

      <button className="pjp-ctx-sec" onClick={() => toggle('files')}>
        <span className="chev">{open.files ? '⌄' : '›'}</span> Files <span className="muted">{lib?.files.length ?? ''}</span>
      </button>
      {open.files && (
        <>
          {lib?.files.length === 0 && <div className="pjp-ctx-row muted">No files yet. Threads put deliverables here; drop files to add them.</div>}
          {tree.map((n) =>
            n.file ? (
              <FileRow key={n.file.path} f={n.file} name={n.file.path} />
            ) : (
              <React.Fragment key={n.dir}>
                <div className="pjp-ctx-row" role="button" tabIndex={0} onClick={() => setDirs((d) => ({ ...d, [n.dir]: !d[n.dir] }))}>
                  <span className="chev small">{dirs[n.dir] ? '⌄' : '›'}</span>
                  <span className="pjp-ico">▭</span>
                  <span className="pjp-ctx-name">{n.dir}</span>
                  <span className="muted pjp-ctx-desc">{n.files.length}</span>
                  <span className="pjp-row-time">{short(n.modified)}</span>
                </div>
                {dirs[n.dir] && n.files.sort((a, b) => b.modified - a.modified).map((f) => <FileRow key={f.path} f={f} name={f.name} depth={1} />)}
              </React.Fragment>
            )
          )}
        </>
      )}
      <button className="pjp-ctx-sec" onClick={() => toggle('artifacts')}>
        <span className="chev">{open.artifacts ? '⌄' : '›'}</span> Artifacts <span className="muted">{arts?.length ?? ''}</span>
      </button>
      {open.artifacts && (
        <>
          {arts?.length === 0 && <div className="pjp-ctx-row muted">No artifacts yet. Pages and documents that threads publish show up here.</div>}
          {arts?.map((a) => (
            <div key={a.sessionId + a.path} className="pjp-ctx-row file">
              <span className="pjp-ico">◰</span>
              <a className="pjp-ctx-name" href={a.url} target="_blank" rel="noreferrer" title={a.path}>
                {a.title || a.name}
              </a>
              <span className="muted pjp-ctx-desc">{project.threads.find((t) => t.id === a.sessionId)?.title || a.sessionName || ''}</span>
              <span className="pjp-row-time">{short(a.mtime)}</span>
            </div>
          ))}
        </>
      )}
      <button className="pjp-ctx-sec" onClick={() => toggle('activity')}>
        <span className="chev">{open.activity ? '⌄' : '›'}</span> Activity <span className="muted">{project.notes?.length || ''}</span>
      </button>
      {open.activity && (
        <>
          {!project.activity?.length && <div className="pjp-ctx-row muted">Nothing passed between threads yet. Notes threads share, what was handed to whom, and signals show up here.</div>}
          {(project.activity || [])
            .filter((a) => a.type !== 'retracted')
            .slice(0, 40)
            .map((a) => (
              <ActivityRow key={a.id} a={a} project={project} onRetract={(nid) => api(`/api/cprojects/${project.id}/notes/${nid}`, { method: 'DELETE' }).then(reload).catch(onError)} />
            ))}
        </>
      )}
      <div className="pjp-storage">
        <div className="bar">
          <span style={{ width: `${Math.min(100, Math.max(0.5, (used / (1 << 30)) * 100))}%` }} />
        </div>
        <span className="muted small">{kb(used)} in the project library</span>
      </div>
      {memModal !== null && (
        <Modal size="wide" onClose={() => (setMemModal(null), load())}>
          <ModalHead title="Project memory" onClose={() => (setMemModal(null), load())} />
          <ModalBody className="pjp-modal-body">
            <ProjectMemory project={project} onError={onError} initial={memModal || null} />
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}
