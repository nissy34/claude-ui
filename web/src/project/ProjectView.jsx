import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Button, IconButton, Input, Modal, ModalBody, ModalFoot, ModalHead, Pill, Segmented, Spinner, Textarea } from '../ui/index.jsx';
import { DecisionCard, Md, StatusPill, SuggestionCard, ThreadCard } from './ProjectCards.jsx';
import { promptDialog } from '../ui/dialogs.jsx';
import ProjectSettings from './ProjectSettings.jsx';
import { ProjectLibrary, ProjectMemory } from './ProjectFiles.jsx';
import { STATUS_LABEL, STATUS_ORDER, useProject } from './useProject.js';
import './project.css';

const TABS = [
  ['chat', 'Chat'],
  ['overview', 'Overview'],
  ['memory', 'Memory'],
  ['library', 'Library'],
  ['settings', 'Settings'],
];

export default function ProjectView({ projectId, tab: initialTab, onSelect, onMenu, onError, onDeleted, projects }) {
  const [project, reload] = useProject(projectId, onError);
  const [tab, setTab] = useState(initialTab || 'chat');
  useEffect(() => setTab(initialTab || 'chat'), [projectId, initialTab]);
  const go = (t) => {
    setTab(t);
    history.replaceState(null, '', `#p=${projectId}${t === 'chat' ? '' : `&tab=${t}`}`);
  };
  if (project === false)
    return (
      <div className="pj-empty">
        <p>This project no longer exists.</p>
      </div>
    );
  if (!project)
    return (
      <div className="pj-empty">
        <Spinner /> Loading project…
      </div>
    );
  const waiting = (project.counts.waiting || 0) + project.decisions.filter((d) => !d.answer && !d.thread).length;
  return (
    <div className="pj">
      <div className="topbar bordered">
        <IconButton className="menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </IconButton>
        <div className="title">
          <span className="tname">{project.name}</span>
          {project.goal && <span className="muted tcwd hide-mobile">{project.goal}</span>}
        </div>
        <Segmented
          className="pj-tabs"
          value={tab}
          onChange={go}
          options={TABS.map(([v, l]) => [
            v,
            <>
              {l}
              {v === 'overview' && waiting > 0 && <span className="count menu-count">{waiting}</span>}
            </>,
          ])}
        />
      </div>
      {project.paused && (
        <div className="pj-banner warn">
          {project.paused.reason}
          <Button size="sm" onClick={() => api(`/api/cprojects/${projectId}/resume`, { method: 'POST' }).then(reload).catch(onError)}>
            Resume
          </Button>
        </div>
      )}
      {project.limit && <div className="pj-banner">Usage limit reached. Work continues automatically at {new Date(project.limit.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>}
      {tab === 'chat' && <ProjectChat project={project} onSelect={onSelect} onError={onError} reload={reload} />}
      {tab === 'overview' && <Overview project={project} onSelect={onSelect} onError={onError} reload={reload} />}
      {tab === 'memory' && <ProjectMemory project={project} onError={onError} />}
      {tab === 'library' && <ProjectLibrary project={project} onError={onError} />}
      {tab === 'settings' && <ProjectSettings project={project} onSelect={onSelect} onError={onError} reload={reload} onDeleted={onDeleted} projects={projects} />}
    </div>
  );
}

// ---------------------------------------------------------------- project chat
function ProjectChat({ project, onSelect, onError }) {
  const listRef = useRef(null);
  const stick = useRef(true);
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(`cw.pj.draft.${project.id}`) || '';
    } catch {
      return '';
    }
  });
  const [sending, setSending] = useState(false);
  const threads = useMemo(() => Object.fromEntries(project.threads.map((t) => [t.id, t])), [project.threads]);
  const decisions = useMemo(() => Object.fromEntries(project.decisions.map((d) => [d.id, d])), [project.decisions]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [project.feed.length, project.coordinatorBusy]);
  const saveDraft = (v) => {
    setText(v);
    try {
      localStorage.setItem(`cw.pj.draft.${project.id}`, v);
    } catch {}
  };
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: t } });
      saveDraft('');
      stick.current = true;
    } catch (e) {
      onError(e);
    }
    setSending(false);
  };
  const items = project.feed.filter((e) => !(e.type === 'decision.answered' || e.type === 'decision.withdrawn'));
  return (
    <div className="pj-chat-wrap">
      <div className="pj-chat">
        <div
          className="messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="messages-inner">
            {items.length === 0 && (
              <div className="pj-intro">
                <div className="pj-intro-title">{project.name}</div>
                <p className="muted">
                  Tell the coordinator what you want done. It answers quick questions itself and hands real work to threads: parallel Claude Code sessions, each in its own worktree. Coordinator: {project.settings.models.coordinator.model || 'default'} · {project.settings.models.coordinator.effort || 'default'} effort. Threads: {project.settings.models.thread.model || 'default'} · {project.settings.models.thread.effort || 'default'} effort.
                </p>
              </div>
            )}
            {items.map((e) => (
              <FeedItem key={e.id} e={e} project={project} threads={threads} decisions={decisions} onSelect={onSelect} onError={onError} />
            ))}
            {(project.coordinatorBusy || project.coordinator?.queued > 0) && (
              <div className="pj-typing">
                <Spinner /> {project.coordinatorBusy ? 'Coordinator is working…' : 'Coordinator will read this shortly…'}
              </div>
            )}
          </div>
        </div>
        <div className="pj-composer">
          <Textarea
            rows={2}
            value={text}
            placeholder={`Message ${project.name}`}
            onChange={(e) => saveDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button variant="primary" onClick={send} disabled={!text.trim() || sending}>
            Send
          </Button>
        </div>
      </div>
      <aside className="pj-side hide-mobile">
        <div className="section-head">Threads</div>
        {project.threads.filter((t) => t.status !== 'resolved').length === 0 && <div className="muted small pad">No open threads.</div>}
        {[...project.threads]
          .filter((t) => t.status !== 'resolved')
          .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.lastActivity - a.lastActivity)
          .map((t) => (
            <ThreadCard key={t.id} projectId={project.id} thread={t} compact onOpen={onSelect} onError={onError} />
          ))}
        <div className="pj-side-foot muted small">
          {project.running}/{project.settings.policy.maxRunning} running · ${project.usage.total.toFixed(2)} used
        </div>
      </aside>
    </div>
  );
}

function FeedItem({ e, project, threads, decisions, onSelect, onError }) {
  const b = e.body || {};
  switch (e.type) {
    case 'user.message':
      return (
        <div className="msg user">
          {e.from?.kind === 'desktop' && <div className="from-label">From Claude Desktop</div>}
          <div className="bubble">{b.text}</div>
          <Reactions list={project.reactions[e.id]} />
        </div>
      );
    case 'chat.post':
      return (
        <div className="msg assistant pj-post">
          <div className="pj-who">Coordinator · {timeAgo(e.ts)}</div>
          <Md text={b.text} />
        </div>
      );
    case 'thread.started':
      return (
        <div className="pj-feed-card">
          <div className="pj-who">{e.from?.kind === 'user' ? 'You started a thread' : 'Started a thread'}</div>
          <ThreadCard projectId={project.id} thread={threads[e.thread]} onOpen={onSelect} onError={onError} actions={false} />
        </div>
      );
    case 'thread.suggested': {
      const sg = project.suggestions?.find((x) => x.id === b.id);
      return <SuggestionCard projectId={project.id} suggestion={sg} threadTitle={sg?.answer?.thread ? threads[sg.answer.thread]?.title : ''} onError={onError} onOpenThread={onSelect} />;
    }
    case 'suggestion.answered':
      return null;
    case 'budget.reached':
      return <div className="pj-notice warn">Budget reached: ${Number(b.total).toFixed(2)} of ${Number(b.budget).toFixed(2)}</div>;
    case 'decision.requested':
      return <DecisionCard projectId={project.id} decision={decisions[b.id]} threadTitle={threads[e.thread]?.title} onError={onError} onOpenThread={onSelect} />;
    case 'thread.post':
      return (
        <div className={`pj-activity kind-${b.kind}`}>
          <button className="linklike" onClick={() => onSelect(e.thread)}>
            {threads[e.thread]?.title || 'Thread'}
          </button>{' '}
          <span className={`pk pk-${b.kind}`}>{b.kind}</span> <ActivityText text={b.text} />
        </div>
      );
    case 'thread.resolved':
      return (
        <div className="pj-notice">
          ✓ {threads[e.thread]?.title || 'A thread'} resolved{b.auto ? ` (${b.auto})` : e.from?.kind === 'user' ? ' by you' : ''}
        </div>
      );
    case 'project.paused':
      return <div className="pj-notice warn">{b.reason}</div>;
    case 'project.resumed':
      return <div className="pj-notice">Resumed</div>;
    case 'limit.hit':
      return <div className="pj-notice warn">Usage limit reached; work continues at {new Date(b.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>;
    case 'limit.reset':
      return <div className="pj-notice">Usage limit reset; continuing</div>;
    case 'policy.changed':
      return (
        <div className="pj-notice">
          Settings changed by the coordinator: at most {b.policy.maxRunning} running, {b.policy.proactivity} updates{b.reason ? ` (${b.reason})` : ''}
        </div>
      );
    case 'coordinator.rotated':
      return <div className="pj-notice">Coordinator context reset to a digest</div>;
    case 'notice':
      return <div className="pj-notice">{b.text}</div>;
    case 'pr.updated':
      return (
        <div className={`pj-notice ${b.wake ? 'warn' : ''}`}>
          <button className="linklike" onClick={() => onSelect(e.thread)}>
            {threads[e.thread]?.title || 'Thread'}
          </button>
          : {b.summary}{' '}
          {b.pr?.url && (
            <a href={b.pr.url} target="_blank" rel="noreferrer">
              open
            </a>
          )}
        </div>
      );
    default:
      return null;
  }
}

function ActivityText({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  if (open) return <Md text={text} />;
  return (
    <span className="pj-activity-text" onClick={() => long && setOpen(true)}>
      {long ? text.slice(0, 220) + '…' : text}
    </span>
  );
}

function Reactions({ list }) {
  if (!list?.length) return null;
  return (
    <div className="pj-reactions">
      {list.map((r, i) => (
        <span key={i} title={r.by?.kind}>
          {r.emoji}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- overview
function Overview({ project, onSelect, onError, reload }) {
  const [showNew, setShowNew] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const groups = STATUS_ORDER.filter((s) => s !== 'resolved' || showResolved).map((s) => [s, project.threads.filter((t) => t.status === s).sort((a, b) => b.lastActivity - a.lastActivity)]);
  const coordDecisions = project.decisions.filter((d) => !d.answer && !d.thread);
  const resolvedCount = project.threads.filter((t) => t.status === 'resolved').length;
  return (
    <div className="pj-overview">
      <div className="pj-overview-inner">
        <div className="pj-overview-bar">
          <span className="muted">
            {project.threads.length} threads · {project.running}/{project.settings.policy.maxRunning} running · {project.settings.policy.proactivity} updates
          </span>
          <Button size="sm" onClick={() => setShowNew(true)}>
            ＋ New thread
          </Button>
        </div>
        {coordDecisions.map((d) => (
          <DecisionCard key={d.id} projectId={project.id} decision={d} onError={onError} />
        ))}
        {groups.map(([status, list]) =>
          list.length ? (
            <section key={status} className="pj-group">
              <div className="section-head">
                {STATUS_LABEL[status]} <span className="muted">{list.length}</span>
              </div>
              {list.map((t) => (
                <React.Fragment key={t.id}>
                  <ThreadCard projectId={project.id} thread={t} onOpen={onSelect} onError={onError} />
                  {project.decisions
                    .filter((d) => d.thread === t.id && !d.answer)
                    .map((d) => (
                      <DecisionCard key={d.id} projectId={project.id} decision={d} threadTitle={t.title} onError={onError} onOpenThread={onSelect} />
                    ))}
                </React.Fragment>
              ))}
            </section>
          ) : null
        )}
        {project.threads.length === 0 && <div className="muted pad">No threads yet. Ask the coordinator for something in the Chat tab, or start one here.</div>}
        {resolvedCount > 0 && (
          <button className="show-arch" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Hide resolved' : `Resolved (${resolvedCount})`}
          </button>
        )}
      </div>
      {showNew && <NewThreadDialog project={project} onClose={() => setShowNew(false)} onError={onError} onDone={reload} />}
    </div>
  );
}

function NewThreadDialog({ project, onClose, onError, onDone }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/cprojects/${project.id}/threads`, { method: 'POST', body: { title, brief } });
      onDone?.();
      onClose();
    } catch (err) {
      onError(err);
    }
    setBusy(false);
  };
  return (
    <Modal as="form" onSubmit={submit} onClose={onClose}>
      <ModalHead title="New thread" onClose={onClose} />
      <ModalBody className="fields">
        <label>
          Title
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix Safari export button" />
        </label>
        <label>
          Brief
          <Textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should this thread do? Goal, what's known, what done looks like." />
        </label>
        <div className="muted small">Runs with {project.settings.models.thread.model || 'the default model'} in its own worktree. The coordinator hears about its results.</div>
      </ModalBody>
      <ModalFoot>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!title.trim() || !brief.trim() || busy}>
          Start thread
        </Button>
      </ModalFoot>
    </Modal>
  );
}

// ---------------------------------------------------------------- thread bar (above a thread's chat)
export function ThreadBar({ session, onSelect, onError, view = 'log', setView }) {
  const [project] = useProject(session.cproject, onError);
  const [open, setOpen] = useState(false);
  if (!project) return null;
  const isCoord = project.coordinatorId === session.id;
  const t = project.threads.find((x) => x.id === session.id);
  const decisions = project.decisions.filter((d) => d.thread === session.id && !d.answer);
  const back = () => (location.hash = `p=${project.id}`);
  if (isCoord)
    return (
      <div className="pj-threadbar">
        <button className="linklike" onClick={back}>
          ◂ {project.name}
        </button>
        <span className="muted small">Coordinator work log: everything the coordinator did. Talk to it in the project chat.</span>
      </div>
    );
  if (!t) return null;
  return (
    <div className="pj-threadbar-wrap">
      <div className="pj-threadbar">
        <button className="linklike" onClick={back}>
          ◂ {project.name}
        </button>
        <StatusPill status={t.status} stuck={t.stuck} />
        {t.progress && (
          <button className="linklike small" onClick={() => setOpen((o) => !o)}>
            {t.checklist?.title || 'Checklist'} {t.progress.done}/{t.progress.total} {open ? '▾' : '▸'}
          </button>
        )}
        <span className="spacer" />
        <Button size="sm" variant="ghost" title="Ask a quick question in a side thread that starts from this conversation, without interrupting it" onClick={async () => {
            const q = await promptDialog('Side question', '', { ok: 'Ask', placeholder: 'What do you want to know?' });
            if (!q?.trim()) return;
            try {
              const r = await api(`/api/cprojects/${project.id}/threads/${t.id}/side`, { method: 'POST', body: { question: q } });
              onSelect?.(r.thread.id);
            } catch (e) {
              onError(e);
            }
          }}>
          Side question
        </Button>
        {setView && (
          <Segmented
            value={view}
            onChange={setView}
            options={[
              ['conversation', 'Conversation'],
              ['log', 'Work log'],
            ]}
          />
        )}
        {t.status !== 'resolved' ? (
          <Button size="sm" variant="ghost" onClick={() => api(`/api/cprojects/${project.id}/threads/${t.id}/resolve`, { method: 'POST' }).catch(onError)}>
            Resolve
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => api(`/api/cprojects/${project.id}/threads/${t.id}/reopen`, { method: 'POST' }).catch(onError)}>
            Reopen
          </Button>
        )}
      </div>
      {open && t.checklist && (
        <div className="pj-threadbar-cl">
          {t.checklist.steps.map((s, i) => (
            <div key={i} className={`cl-step ${s.status}`}>
              <span className="cl-mark">{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '✱' : '○'}</span>
              {s.step}
            </div>
          ))}
        </div>
      )}
      {decisions.map((d) => (
        <div key={d.id} className="pj-threadbar-dec">
          <DecisionCard projectId={project.id} decision={d} threadTitle={t.title} onError={onError} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- sidebar list
export function ProjectList({ projects, activeId, onOpen, onNew }) {
  return (
    <div className="group pj-sidebar">
      <div className="group-head">
        <span className="gname section-like">Projects</span>
        <IconButton title="New project" onClick={onNew}>
          +
        </IconButton>
      </div>
      {projects.filter((p) => !p.archived).map((p) => (
        <div key={p.id} role="button" tabIndex={0} className={`session-row ${p.id === activeId ? 'active' : ''}`} onClick={() => onOpen(p.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id)} title={p.goal || p.name}>
          <span className={`dot ${p.attention ? 'attn' : p.coordinatorBusy || p.counts.working ? 'busy' : 'on'}`} />
          <span className="sname">◈ {p.name}</span>
          {p.attention > 0 ? <span className="count">{p.attention}</span> : <span className="when">{timeAgo(p.lastActivity)}</span>}
        </div>
      ))}
      {projects.filter((p) => !p.archived).length === 0 && (
        <button className="pj-new-row" onClick={onNew}>
          New project…
        </button>
      )}
    </div>
  );
}

export { STATUS_LABEL };
export { Pill };

// ---------------------------------------------------------------- a thread's Conversation (posts, not tool calls)
export function ThreadConversation({ session, onSelect, onError }) {
  const [project] = useProject(session.cproject, onError);
  const [feed, setFeed] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!project) return;
    api(`/api/cprojects/${project.id}/threads/${session.id}/feed`)
      .then((r) => setFeed(r.feed))
      .catch(onError);
  }, [project?.lastActivity, session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [feed?.length]);
  if (!project || !feed)
    return (
      <div className="messages">
        <div className="messages-inner">
          <Spinner />
        </div>
      </div>
    );
  const decisions = Object.fromEntries(project.decisions.map((d) => [d.id, d]));
  const t = project.threads.find((x) => x.id === session.id);
  return (
    <div className="messages" ref={ref}>
      <div className="messages-inner">
        <div className="muted small">Your messages, the thread's posts and its cards. Tool calls and edits are in the Work log.</div>
        {feed.map((e) => {
          const b = e.body || {};
          if (e.type === 'thread.started')
            return (
              <div key={e.id} className="msg user from-session">
                <div className="from-label">Brief from {e.from?.kind === 'user' ? 'you' : e.from?.kind === 'desktop' ? 'Claude Desktop' : 'the coordinator'}</div>
                <div className="bubble">{b.brief}</div>
              </div>
            );
          if (e.type === 'user.message')
            return (
              <div key={e.id} className="msg user">
                <div className="bubble">{b.text}</div>
              </div>
            );
          if (e.type === 'session.message')
            return e.from?.id === session.id ? (
              <div key={e.id} className="msg assistant">
                <div className="pj-who">To the coordinator · {timeAgo(e.ts)}</div>
                <Md text={b.text} />
              </div>
            ) : (
              <div key={e.id} className="msg user from-session">
                <div className="from-label">From {e.from?.kind === 'desktop' ? 'Claude Desktop' : e.from?.kind === 'thread' ? project.threads.find((x) => x.id === e.from.id)?.title || 'a thread' : 'the coordinator'}</div>
                <div className="bubble">{b.text}</div>
              </div>
            );
          if (e.type === 'thread.post')
            return (
              <div key={e.id} className="msg assistant pj-post">
                <div className="pj-who">
                  <span className={`pk pk-${b.kind}`}>{b.kind}</span> {timeAgo(e.ts)}
                  {b.auto ? ' · from its final reply' : ''}
                </div>
                <Md text={b.text} />
              </div>
            );
          if (e.type === 'decision.requested') return <DecisionCard key={e.id} projectId={project.id} decision={decisions[b.id]} threadTitle={t?.title} onError={onError} />;
          if (e.type === 'pr.updated') return <div key={e.id} className="pj-notice">{b.summary}</div>;
          if (e.type === 'reminder.set') return <div key={e.id} className="pj-notice">⏰ Snoozed until {new Date(b.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{b.note ? `: ${b.note}` : ''}</div>;
          if (e.type === 'reminder.due') return <div key={e.id} className="pj-notice">⏰ Reminder due</div>;
          if (e.type === 'thread.resolved') return <div key={e.id} className="pj-notice">✓ Resolved{b.auto ? ` (${b.auto})` : ''}</div>;
          if (e.type === 'thread.reopened') return <div key={e.id} className="pj-notice">Reopened</div>;
          if (e.type === 'notice') return <div key={e.id} className="pj-notice">{b.text}</div>;
          return null;
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- move a regular chat into a project
export function MoveToProjectDialog({ session, onClose, onError, onMoved }) {
  const [list, setList] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/cprojects')
      .then((r) => {
        const open = r.projects.filter((p) => !p.archived);
        setList(open);
        setPick(open[0]?.id || '');
      })
      .catch(onError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const move = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/cprojects/${pick}/adopt`, { method: 'POST', body: { session: session.id } });
      onMoved?.(pick);
    } catch (err) {
      onError(err);
    }
    setBusy(false);
  };
  return (
    <Modal as="form" onSubmit={move} onClose={onClose}>
      <ModalHead title="Move into a project" onClose={onClose} />
      <ModalBody className="fields">
        {!list ? (
          <Spinner />
        ) : list.length === 0 ? (
          <div className="muted">No projects yet. Create one from the sidebar first.</div>
        ) : (
          <>
            <div className="muted small">"{session.name}" becomes a thread of the project. It keeps its folder, branch and history, and the project's coordinator is told about it.</div>
            {list.map((p) => (
              <label key={p.id} className="pj-move-row">
                <input type="radio" name="pj-move" checked={pick === p.id} onChange={() => setPick(p.id)} /> <b>{p.name}</b> {p.goal && <span className="muted small">{p.goal}</span>}
              </label>
            ))}
          </>
        )}
      </ModalBody>
      <ModalFoot>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!pick || busy}>
          Move
        </Button>
      </ModalFoot>
    </Modal>
  );
}
