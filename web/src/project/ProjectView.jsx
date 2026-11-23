import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Button, IconButton, Input, Menu, Modal, ModalBody, ModalFoot, ModalHead, Pill, Segmented, Spinner, Textarea, useDismiss } from '../ui/index.jsx';
import { DecisionCard, Md, StatusPill, SuggestionCard, ThreadCard } from './ProjectCards.jsx';
import { confirmDialog, promptDialog } from '../ui/dialogs.jsx';
import { ProjectSettingsModal } from './ProjectSettings.jsx';
import { ProjectUsageRing } from './ProjectUsage.jsx';
import ProjectPanel, { PrChip, StatusIcon } from './ProjectPanel.jsx';
import { STATUS_LABEL, STATUS_ORDER, useProject } from './useProject.js';
import { useGatewayMode, useOAuthTokenMode } from '../Gateway.jsx';
import { ImageLightbox } from '../chat/ToolCard.jsx';
import { sendableImage } from '../chat/Composer.jsx';
import './project.css';

export default function ProjectView({ projectId, tab: initialTab, thread: initialThread, onSelect, onCreate, onMenu, onError, onDeleted, projects }) {
  const [project, reload] = useProject(projectId, onError);
  const narrow = useNarrow();
  // Right panel: Threads or Context; a thread opens in place. On a phone the panel is a view of its own.
  const [panel, setPanelState] = useState(['context', 'view'].includes(initialTab) ? initialTab : 'threads');
  const [threadId, setThreadId] = useState(initialThread || null);
  const [mobileView, setMobileView] = useState(initialThread ? 'panel' : ['context', 'threads', 'view'].includes(initialTab) ? 'panel' : 'chat');
  const [settings, setSettings] = useState(initialTab === 'settings' ? 'general' : null);
  const [showNew, setShowNew] = useState(false);
  // Opening a project you marked unread marks it read again.
  useEffect(() => {
    if (project?.unread) api(`/api/cprojects/${project.id}`, { method: 'PATCH', body: { unread: false } }).catch(() => {});
  }, [project?.id, project?.unread]);
  useEffect(() => {
    setThreadId(initialThread || null);
    if (initialTab === 'settings') setSettings('general');
  }, [projectId, initialThread, initialTab]);
  const writeHash = (p, t) => history.replaceState(null, '', `#p=${projectId}${p === 'context' || p === 'view' ? `&tab=${p}` : ''}${t ? `&t=${t}` : ''}`);
  const setPanel = (p) => {
    setPanelState(p);
    writeHash(p, threadId);
  };
  const openThread = (tid) => {
    setThreadId(tid);
    if (tid) {
      setPanelState('threads');
      setMobileView('panel');
    }
    writeHash(tid ? 'threads' : panel, tid);
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
  const waiting = project.threads.filter((t) => t.status === 'waiting').length;
  const showChat = !narrow || mobileView === 'chat';
  const showPanel = !narrow || mobileView === 'panel';
  return (
    <div className="pj pj-split">
      {showChat && (
        <div className="pj-left">
          <div className="pj-left-head">
            <IconButton className="menu-btn" onClick={onMenu} aria-label="Menu">
              ☰
            </IconButton>
            <ProjectIcon project={project} size="md" />
            <span className="pj-name" title={project.goal || project.name}>
              {project.name}
            </span>
            <span className="spacer" />
            {narrow && (
              <button className="pj-mobile-switch" onClick={() => setMobileView('panel')}>
                Threads {waiting > 0 && <span className="pjp-badge">{waiting}</span>}
              </button>
            )}
            <IconButton title="Project settings" onClick={() => setSettings('general')}>
              ⚙
            </IconButton>
          </div>
          <Banners project={project} reload={reload} onError={onError} onCreate={onCreate} />
          <ProjectChat project={project} openThread={openThread} onError={onError} onFullUsage={() => setSettings('usage')} />
        </div>
      )}
      {showPanel && (
        <div className="pj-right">
          {narrow && (
            <div className="pj-mobile-back">
              <button className="linklike" onClick={() => setMobileView('chat')}>
                ‹ {project.name} chat
              </button>
            </div>
          )}
          <ProjectPanel project={project} tab={panel} setTab={setPanel} threadId={threadId} openThread={openThread} onSelect={onSelect} onError={onError} onNewThread={() => setShowNew(true)} reload={reload} onFullUsage={() => setSettings('usage')} />
        </div>
      )}
      {showNew && <NewThreadDialog project={project} onClose={() => setShowNew(false)} onError={onError} onDone={reload} />}
      {settings && <ProjectSettingsModal project={project} section={settings} setSection={setSettings} onClose={() => setSettings(null)} onSelect={onSelect} onError={onError} reload={reload} onDeleted={onDeleted} projects={projects} />}
    </div>
  );
}

function useNarrow() {
  const q = '(max-width: 860px)';
  const [n, setN] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setN(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return n;
}

function Banners({ project, reload, onError, onCreate }) {
  // With a gateway key or an OAuth token, the fix is in Settings rather than a new /login.
  const gw = useGatewayMode();
  const token = useOAuthTokenMode();
  const gateway = gw || token;
  // Same as the chat view's "Log in again": a terminal session that runs the CLI's /login.
  const relogin = () => onCreate?.({ cwd: project.settings.folders?.[0]?.path, kind: 'claude', name: 'Log in to Claude', login: true });
  return (
    <>
      {project.paused && (
        <div className="pj-banner warn">
          {project.paused.reason}
          {project.paused.auth && gateway && (
            <Button size="sm" variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('cw-open-settings', { detail: 'account' }))}>
              Open Settings
            </Button>
          )}
          {project.paused.auth && !gateway && onCreate && (
            <Button size="sm" variant="primary" onClick={relogin}>
              Log in again
            </Button>
          )}
          <Button size="sm" onClick={() => api(`/api/cprojects/${project.id}/resume`, { method: 'POST' }).then(reload).catch(onError)}>
            Resume
          </Button>
        </div>
      )}
      {project.limit && <div className="pj-banner">Usage limit reached. {project.settings.policy.continueOnReset === false ? 'Threads wait for you after it resets' : 'Work continues automatically'} at {new Date(project.limit.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>}
    </>
  );
}

// ---------------------------------------------------------------- project chat
function ProjectChat({ project, openThread, onError, onFullUsage }) {
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
  const [pasted, setPasted] = useState([]); // {key, url, abs?} pictures pasted into the box
  const pasteImages = async (files) => {
    for (const raw of files) {
      const f = (await sendableImage(raw)) || raw; // scaled down when too big for Claude
      const key = Math.random();
      const url = URL.createObjectURL(f);
      setPasted((l) => [...l, { key, url }]);
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^\w]/g, '');
      const name = `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.floor(key * 1e4)}.${ext}`;
      new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(f);
      })
        .then((data) => api(`/api/cprojects/${project.id}/library`, { method: 'POST', body: { name, data } }))
        .then((j) => setPasted((l) => l.map((x) => (x.key === key ? { ...x, abs: j.abs } : x))))
        .catch((e) => (setPasted((l) => l.filter((x) => x.key !== key)), onError(e)));
    }
  };
  // "Ask Claude" elsewhere on the page (the Custom view tab) puts a draft here.
  useEffect(() => {
    const on = (e) => {
      if (e.detail?.project !== project.id) return;
      saveDraft(e.detail.text);
      setTimeout(() => listRef.current?.closest('.pj-chat')?.querySelector('textarea')?.focus(), 0);
    };
    window.addEventListener('cw-pj-draft', on);
    return () => window.removeEventListener('cw-pj-draft', on);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const uploading = pasted.some((p) => !p.abs);
  const send = async () => {
    const ready = pasted.filter((p) => p.abs);
    const t = text.trim() + (ready.length ? `${text.trim() ? '\n\n' : ''}Attached images:\n${ready.map((p) => `- ${p.abs}`).join('\n')}` : '');
    if (!t || sending || uploading) return;
    setSending(true);
    try {
      await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: t } });
      saveDraft('');
      setPasted([]);
      stick.current = true;
    } catch (e) {
      onError(e);
    }
    setSending(false);
  };
  // A thread's result shows once: when Claude relays it in the chat afterwards, the raw post is hidden.
  // An ack (Claude handing work to the thread) is labeled with the thread too, but relays nothing.
  const relayed = new Map();
  for (const e of project.feed) if (e.type === 'chat.post' && !e.body?.ack) for (const tid of aboutIds(e.body)) relayed.set(tid, e.ts);
  const items = project.feed.filter((e) => !(e.type === 'decision.answered' || e.type === 'decision.withdrawn') && !(e.type === 'thread.post' && e.body?.kind === 'result' && relayed.get(e.thread) >= e.ts));
  const cm = project.settings.models.coordinator;
  return (
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
              <p className="muted">{project.goal || 'Tell Claude what you want done. Each piece of work gets its own thread, running in parallel in its own worktree; follow-ups go to the thread that did the work.'}</p>
              <div className="pj-starters">
                {STARTERS.map(([label, prompt]) => (
                  <button key={label} className="pj-starter" onClick={() => (saveDraft(prompt), listRef.current?.closest('.pj-chat')?.querySelector('textarea')?.focus())}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((e) => (
            <FeedItem key={e.id} e={e} project={project} threads={threads} decisions={decisions} onSelect={openThread} onError={onError} />
          ))}
          {(project.coordinatorBusy || project.coordinator?.queued > 0) && (
            <div className="pj-typing">
              <Spinner /> {project.coordinatorBusy ? 'Working…' : project.paused ? (project.paused.auth ? 'Waits until you log in and resume' : 'Waits until you resume') : 'Will read this shortly…'}
            </div>
          )}
        </div>
      </div>
      <div className="pj-composer2">
        <div className="pj-composer-box">
          {pasted.length > 0 && (
            <div className="thumbs pj-thumbs">
              {pasted.map((p) => (
                <div key={p.key} className={`thumb ${p.abs ? '' : 'uploading'}`}>
                  <img src={p.url} alt="Pasted image" />
                  <button onClick={() => setPasted((l) => l.filter((x) => x !== p))} aria-label="Remove">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            rows={1}
            value={text}
            placeholder="Ask Claude a question or start a task…"
            onChange={(e) => saveDraft(e.target.value)}
            onPaste={(e) => {
              const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
              if (!imgs.length) return;
              e.preventDefault();
              pasteImages(imgs);
            }}
            onDragOver={(e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault()}
            onDrop={(e) => {
              const imgs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
              if (!imgs.length) return;
              e.preventDefault();
              pasteImages(imgs);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="pjp-send" onClick={send} disabled={(!text.trim() && !pasted.length) || sending || uploading} aria-label="Send">
            ↵
          </button>
        </div>
        <div className="pj-composer-foot">
          <span className="muted small">
            {project.running} thread{project.running === 1 ? '' : 's'} running · ${project.usage.total.toFixed(2)}
          </span>
          <span className="spacer" />
          <span className="muted small">
            {modelName(cm.model)}
            {cm.effort ? ` ${cm.effort[0].toUpperCase()}${cm.effort.slice(1)}` : ''}
          </span>
          <ProjectUsageRing project={project} context={project.coordinator?.context} onOpenThread={openThread} onFullUsage={onFullUsage} />
        </div>
      </div>
    </div>
  );
}

const STARTERS = [
  ['Explain this repo', 'What does this repo do?'],
  ['Make a plan', 'Make a plan for '],
  ['Pick up recent work', 'Look at the recent commits and open branches and tell me what is in progress.'],
];

const modelName = (m) => (!m ? 'Default model' : m.length < 10 ? m[0].toUpperCase() + m.slice(1) : m);

const aboutIds = (b) => (b?.abouts?.length ? b.abouts : b?.about ? [b.about] : []);
const isWorking = (t) => t.status === 'working' || t.status === 'queued';

const WorkingDots = () => (
  <span className="pj-dots" aria-label="working">
    <i />
    <i />
    <i />
  </span>
);

// The thread(s) a post is about, under the post. One thread: its title, with animated dots while it works.
// Several: "N threads", and hovering or clicking lists each with its state; a row opens that thread.
function AboutLabel({ ids, threads, onSelect }) {
  const list = ids.map((id) => threads[id]).filter(Boolean);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const hover = useRef(null);
  useDismiss(open, () => setOpen(false), root);
  if (!list.length) return null;
  if (list.length === 1) {
    const t = list[0];
    return (
      <button className={`pj-about${isWorking(t) ? ' working' : ''}`} onClick={() => onSelect(t.id)} title={isWorking(t) ? `${t.title} is working` : t.title}>
        <span className="hook">╰</span> {t.title}
        {isWorking(t) && <WorkingDots />}
      </button>
    );
  }
  const show = (v) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => setOpen(v), v ? 120 : 250);
  };
  return (
    <div className="menu-wrap pj-about-wrap" ref={root} onMouseEnter={() => matchMedia('(hover: hover)').matches && show(true)} onMouseLeave={() => matchMedia('(hover: hover)').matches && show(false)}>
      <button className={`pj-about${list.some(isWorking) ? ' working' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => (clearTimeout(hover.current), setOpen((o) => !o))}>
        <span className="hook">╰</span> {list.length} threads
        {list.some(isWorking) && <WorkingDots />}
      </button>
      {open && (
        <Menu place="up" className="pj-about-pop">
          {list.map((t) => (
            <button key={t.id} role="menuitem" onClick={() => (setOpen(false), onSelect(t.id))} title={`${t.title} · ${STATUS_LABEL[t.status] || t.status}`}>
              <span className="pj-about-st">{isWorking(t) ? <WorkingDots /> : <StatusIcon status={t.status === 'idle' ? 'resolved' : t.status} />}</span>
              <span className="pj-about-title">{t.title}</span>
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}

// Pictures pasted in the project chat are saved to the library; the message ends with their paths
// (so Claude, and the threads it passes the message to, can open them) and shows them as thumbnails.
const ATTACHED_IMAGES = /\n*Attached images:\n((?:- .+(?:\n|$))+)$/;
function splitImages(text) {
  const m = ATTACHED_IMAGES.exec(text || '');
  if (!m) return [text, []];
  const rels = m[1].trim().split('\n').map((l) => l.replace(/^- /, '')).map((p) => p.slice(p.lastIndexOf('/library/') + '/library/'.length));
  return [text.slice(0, m.index), rels];
}

function PastedImages({ project, rels }) {
  const [big, setBig] = useState(null);
  const href = (p) => `/api/cprojects/${project.id}/library/file?path=${encodeURIComponent(p)}`;
  return (
    <div className="sent-images">
      {rels.map((p) => (
        <button key={p} type="button" className="sent-image" title="Click to enlarge" onClick={() => setBig(href(p))}>
          <img src={href(p)} alt={p.split('/').pop()} loading="lazy" />
        </button>
      ))}
      {big && <ImageLightbox src={big} alt="Pasted image" onClose={() => setBig(null)} />}
    </div>
  );
}

function FeedItem({ e, project, threads, decisions, onSelect, onError }) {
  const b = e.body || {};
  switch (e.type) {
    case 'user.message': {
      const [body, imgs] = splitImages(b.text);
      return (
        <div className="msg user">
          {e.from?.kind === 'desktop' && <div className="from-label">From Claude Desktop</div>}
          <div className="bubble">
            {imgs.length > 0 && <PastedImages project={project} rels={imgs} />}
            {body}
          </div>
          <Reactions list={project.reactions[e.id]} />
        </div>
      );
    }
    case 'chat.post':
      return (
        <div className="msg assistant pj-post">
          <Md text={b.text} />
          <AboutLabel ids={aboutIds(b)} threads={threads} onSelect={onSelect} />
        </div>
      );
    case 'thread.started': {
      const t = threads[e.thread];
      if (!t) return null;
      return (
        <button className="pj-started" onClick={() => onSelect(t.id)}>
          <StatusIcon status={t.status} />
          <span className="pj-started-what">{b.adopted ? 'Moved in' : e.from?.kind === 'user' ? 'You started' : t.sideOf ? 'Side question' : 'Started'}</span>
          <span className="pj-started-title">{t.title}</span>
          <PrChip pr={t.pr} />
        </button>
      );
    }
    case 'thread.suggested': {
      const sg = project.suggestions?.find((x) => x.id === b.id);
      return <SuggestionCard projectId={project.id} suggestion={sg} threadTitle={sg?.answer?.thread ? threads[sg.answer.thread]?.title : ''} onError={onError} onOpenThread={onSelect} />;
    }
    case 'suggestion.answered':
      return null;
    case 'decision.requested':
      return <DecisionCard projectId={project.id} decision={decisions[b.id]} threadTitle={threads[e.thread]?.title} onError={onError} onOpenThread={onSelect} />;
    case 'thread.post':
      return (
        <div className={`pj-activity kind-${b.kind}`}>
          <AboutLabel ids={e.thread ? [e.thread] : []} threads={threads} onSelect={onSelect} />
          <div>
            {b.kind !== 'result' && <span className={`pk pk-${b.kind}`}>{b.kind}</span>} <ActivityText text={b.text} />
          </div>
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
    case 'turn.failed': {
      const who = b.session === project.coordinatorId ? 'Claude' : threads[b.session]?.title || 'A thread';
      return (
        <div className="pj-notice warn">
          {who} couldn't finish: {b.text}
        </div>
      );
    }
    case 'limit.hit':
      return <div className="pj-notice warn">Usage limit reached; work continues at {new Date(b.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>;
    case 'limit.reset':
      return <div className="pj-notice">Usage limit reset; continuing</div>;
    case 'policy.changed':
      return (
        <div className="pj-notice">
          Settings changed by the coordinator: {b.policy.proactivity} updates{b.reason ? ` (${b.reason})` : ''}
        </div>
      );
    case 'coordinator.rotated':
      // An automatic reset is housekeeping the user can't act on; only a restart they asked for shows.
      return b.manual ? <div className="pj-notice">Coordinator restarted</div> : null;
    case 'notice':
      return <div className="pj-notice">{b.text}</div>;
    case 'pr.updated':
      if (b.quiet) return null;
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
  const back = () => (location.hash = `p=${project.id}${isCoord ? '' : `&t=${session.id}`}`);
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
/** A project's icon: its emoji or first letter on its color, like Desktop's project icons. */
export function ProjectIcon({ project, size = 'sm' }) {
  const icon = (project.icon || '').trim();
  // An emoji shows on its own (one of them); letters sit on the project's color.
  const emoji = /\p{Extended_Pictographic}/u.test(icon);
  const text = emoji ? [...new Intl.Segmenter().segment(icon)][0].segment : icon.slice(0, 2) || (project.name.trim()[0] || '◈').toUpperCase();
  return (
    <span className={`pj-ic c-${project.color || 'orange'} ${size} ${emoji ? 'emoji' : ''} ${text.length > 1 && !emoji ? 'two' : ''}`} aria-hidden="true">
      {text}
    </span>
  );
}

export function ProjectList({ projects, activeId, onOpen, onNew, onError, onDeleted }) {
  const [menu, setMenu] = useState(null);
  const ref = useRef(null);
  useDismiss(!!menu, () => setMenu(null), ref);
  const shown = projects.filter((p) => !p.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastActivity - a.lastActivity);
  const patch = (p, body) => api(`/api/cprojects/${p.id}`, { method: 'PATCH', body }).catch(onError);
  const act = async (p, a) => {
    setMenu(null);
    if (a === 'window') window.open(`${location.pathname}#p=${p.id}`, '_blank', 'noopener');
    else if (a === 'pin') patch(p, { pinned: !p.pinned });
    else if (a === 'unread') patch(p, { unread: true });
    else if (a === 'rename') {
      const name = await promptDialog('Rename project', p.name);
      if (name?.trim()) patch(p, { name: name.trim() });
    } else if (a === 'settings') onOpen(p.id, 'settings');
    else if (a === 'archive') patch(p, { archived: true });
    else if (a === 'delete') {
      if (!(await confirmDialog(`Delete "${p.name}"? Its threads stay as archived chats; the project chat, memory and library are deleted.`, { title: 'Delete project', ok: 'Delete', danger: true }))) return;
      api(`/api/cprojects/${p.id}`, { method: 'DELETE' })
        .then(() => p.id === activeId && onDeleted?.())
        .catch(onError);
    }
  };
  // Shortcut letters while a row's menu is open, like the desktop app.
  useEffect(() => {
    if (!menu) return;
    const p = projects.find((x) => x.id === menu);
    const onKey = (e) => {
      const a = { o: 'window', p: 'pin', u: 'unread', r: 'rename', s: 'settings', a: 'archive', d: 'delete' }[e.key.toLowerCase()];
      if (e.key === 'Escape') setMenu(null);
      else if (a && p && !e.metaKey && !e.ctrlKey && !e.altKey) (e.preventDefault(), act(p, a));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="group pj-sidebar" ref={ref}>
      <div className="group-head">
        <span className="gname section-like">Projects</span>
        <IconButton title="New project" onClick={onNew}>
          +
        </IconButton>
      </div>
      {shown.map((p) => (
        <div
          key={p.id}
          role="button"
          tabIndex={0}
          className={`session-row ${p.id === activeId ? 'active' : ''} ${menu === p.id ? 'menu-open' : ''}`}
          onClick={() => onOpen(p.id)}
          onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id)}
          onContextMenu={(e) => (e.preventDefault(), setMenu(p.id))}
          title={p.goal || p.name}
        >
          <ProjectIcon project={p} />
          <span className={`sname ${p.unread ? 'unread' : ''}`}>{p.name}</span>
          {p.attention > 0 ? <span className="count">{p.attention}</span> : p.unread ? <span className="dot attn" title="Unread" /> : p.coordinatorBusy || p.counts?.working ? <span className="dot busy" title="Working" /> : <span className="when">{timeAgo(p.lastActivity)}</span>}
          <span className="menu-wrap row-menu" onClick={(e) => e.stopPropagation()}>
            <IconButton title="More" onClick={() => setMenu(menu === p.id ? null : p.id)}>
              ⋯
            </IconButton>
            {menu === p.id && (
              <Menu place="down">
                <button onClick={() => act(p, 'window')}>
                  Open in new window <kbd>O</kbd>
                </button>
                <div className="sep" />
                <button onClick={() => act(p, 'pin')}>
                  {p.pinned ? 'Unpin' : 'Pin'} <kbd>P</kbd>
                </button>
                <button onClick={() => act(p, 'unread')}>
                  Mark as unread <kbd>U</kbd>
                </button>
                <button onClick={() => act(p, 'rename')}>
                  Rename <kbd>R</kbd>
                </button>
                <div className="sep" />
                <button onClick={() => act(p, 'settings')}>
                  Settings <kbd>S</kbd>
                </button>
                <div className="sep" />
                <button onClick={() => act(p, 'archive')}>
                  Archive <kbd>A</kbd>
                </button>
                <button className="danger" onClick={() => act(p, 'delete')}>
                  Delete <kbd>D</kbd>
                </button>
              </Menu>
            )}
          </span>
        </div>
      ))}
      {shown.length === 0 && (
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
