import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { highlight } from './markdown.js';
import ArtifactView from './ArtifactView.jsx';
import BrowserView from './BrowserView.jsx';
import BackgroundTasks, { isLive } from './BackgroundTasks.jsx';
import { Button, IconButton, Menu, useDismiss } from '../ui/index.jsx';
import DiffView from './DiffView.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';
import { useResizable } from '../ui/resizable.jsx';
import { copyText } from '../ui/clipboard.js';

// The branch's pull request with CI checks, like Desktop's PR status in the Changes card, plus the
// repository's PRs the chat linked to (chats that push to another branch, e.g. an existing PR's).
export function PrCard({ sessionId, refreshKey, onPrompt, busy, onError }) {
  const [st, setSt] = useState(null);
  const load = () =>
    api(`/api/sessions/${sessionId}/pr`)
      .then(setSt)
      .catch(() => setSt(null));
  useEffect(() => {
    load();
  }, [sessionId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = [st?.pr, ...(st?.linked || [])].some((p) => p?.summary?.pending > 0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return null;
  if (!st.available) return <div className="pr-card card muted pr-note">{st.reason}</div>;
  // gh answered with something unexpected: say so instead of showing nothing.
  if (st.error) return <div className="pr-card card muted pr-note" title={st.error}>Couldn't check for a pull request: {st.error}</div>;
  const merge = async (pr) => {
    if (!(await confirmDialog(`Turn on auto-merge (squash) for PR #${pr.number}? GitHub merges it once checks and reviews pass.`, { ok: 'Turn on' }))) return;
    try {
      setSt(await api(`/api/sessions/${sessionId}/pr/merge-when-ready`, { method: 'POST', body: { number: pr.number } }));
    } catch (e) {
      onError?.(e);
    }
  };
  const all = [st.pr, ...(st.linked || [])].filter(Boolean);
  return all.map((pr) => <PrView key={pr.url} pr={pr} linked={pr !== st.pr} onRefresh={load} onMerge={merge} onPrompt={onPrompt} busy={busy} />);
}

function PrView({ pr, linked, onRefresh, onMerge, onPrompt, busy }) {
  const [open, setOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const { pass, fail, pending: pend } = pr.summary;
  const merge = async () => {
    setMerging(true);
    await onMerge(pr);
    setMerging(false);
  };
  return (
    <div className="pr-card card">
      <div className="pr-top">
        <span className={`pill strong pr-state ${{ OPEN: 'green', MERGED: 'purple', CLOSED: 'red' }[pr.state] || ''}`}>{pr.state === 'OPEN' ? 'Open' : pr.state === 'DRAFT' ? 'Draft' : pr.state === 'MERGED' ? 'Merged' : 'Closed'}</span>
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-title" title={pr.title}>
          #{pr.number} {pr.title}
        </a>
        <IconButton title="Refresh" onClick={onRefresh}>
          ↻
        </IconButton>
      </div>
      {linked && <div className="pr-meta muted">Linked in this chat · {pr.head}</div>}
      {pr.checks.length > 0 && (
        <button className="pr-checks" onClick={() => setOpen(!open)}>
          {fail > 0 && <span className="ck fail">✕ {fail} failing</span>}
          {pend > 0 && <span className="ck pending">● {pend} running</span>}
          {pass > 0 && <span className="ck pass">✓ {pass} passed</span>}
          <span className="chev">{open ? '▾' : '▸'}</span>
        </button>
      )}
      {open && (
        <div className="pr-check-list">
          {pr.checks.map((c, i) => (
            <div key={i} className={`ck-row ${c.state}`}>
              <span className="ck-ico">{c.state === 'pass' ? '✓' : c.state === 'fail' ? '✕' : '●'}</span>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </div>
          ))}
        </div>
      )}
      <div className="pr-meta muted">
        {pr.review === 'APPROVED' ? 'Approved' : pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : pr.review === 'REVIEW_REQUIRED' ? 'Review required' : ''}
        {pr.mergeable === 'CONFLICTING' ? ' · Merge conflict' : ''}
        {pr.autoMerge ? ' · Auto-merge on' : ''}
      </div>
      {(pr.state === 'OPEN' || pr.state === 'DRAFT') && (
        <div className="git-actions">
          {fail > 0 && (
            <Button size="sm" disabled={busy || !onPrompt} onClick={() => onPrompt(`CI is failing on PR #${pr.number} (${pr.url}). Use gh to look at the failing checks and their logs, find the root cause, fix it, and push. Don't skip or disable tests.`)}>
              Fix failing checks
            </Button>
          )}
          {(pr.review === 'CHANGES_REQUESTED' || pr.review === 'REVIEW_REQUIRED') && (
            <Button size="sm" disabled={busy || !onPrompt} onClick={() => onPrompt(`Read the review comments on PR #${pr.number} (${pr.url}) with gh, address the ones that need changes, push, and reply on the threads you handled.`)}>
              Address review comments
            </Button>
          )}
          {pr.mergeable === 'CONFLICTING' && (
            <Button size="sm" disabled={busy || !onPrompt} onClick={() => onPrompt(`PR #${pr.number} has a merge conflict with ${pr.base}. Merge ${pr.base} into this branch, resolve the conflicts carefully, run the tests, and push.`)}>
              Resolve conflict
            </Button>
          )}
          {!pr.autoMerge && pr.state === 'OPEN' && (
            <Button size="sm" disabled={merging} onClick={merge}>
              {merging ? 'Turning on…' : 'Merge when ready'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Line comments on the diff, sent to Claude as one review (like Desktop's diff comments).
function reviewPrompt(comments) {
  const body = comments.map((c) => `- ${c.path}:${c.line}${c.old ? ' (removed line)' : ''}\n  > ${c.code.trim().slice(0, 200)}\n  ${c.text.replace(/\n/g, '\n  ')}`).join('\n');
  return `Please address my review comments on the current changes:\n\n${body}`;
}

const DIFF_OPTS_KEY = 'cw.diffOpts';
const DEFAULT_OPTS = { list: true, group: false, split: false, wrap: false, words: true, ws: false, mine: false };
function loadOpts() {
  try {
    return { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem(DIFF_OPTS_KEY) || '{}') };
  } catch {
    return DEFAULT_OPTS;
  }
}

/** Changed files as a flat list or grouped under their folders. */
function FileList({ files, group, active, onPick }) {
  const row = (f, label) => (
    <button key={f.path} className={`fl-row ${active === f.path ? 'on' : ''}`} title={f.path} onClick={() => onPick(f.path)}>
      <span className={`cstatus ${f.status}`}>{f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}</span>
      <span className="fl-name">{label}</span>
      <span className="tstats">
        {f.add > 0 && <span className="add">+{f.add}</span>}
        {f.del > 0 && <span className="del">−{f.del}</span>}
      </span>
    </button>
  );
  if (!group) return <div className="file-list">{files.map((f) => row(f, f.path))}</div>;
  const dirs = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const d = i < 0 ? '' : f.path.slice(0, i);
    if (!dirs.has(d)) dirs.set(d, []);
    dirs.get(d).push(f);
  }
  return (
    <div className="file-list">
      {[...dirs.keys()].sort().map((d) => (
        <div key={d || '.'} className="fl-dir">
          {d && <div className="fl-dir-name">{d}/</div>}
          {dirs.get(d).map((f) => row(f, f.path.slice(d ? d.length + 1 : 0)))}
        </div>
      ))}
    </div>
  );
}

function DiffOptions({ opts, set, anyOpen, onToggleAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(open, () => setOpen(false), ref);
  const item = (key, label) => (
    <button role="menuitemcheckbox" aria-checked={!!opts[key]} onClick={() => set({ [key]: !opts[key] })}>
      <span className="check">{opts[key] ? '✓' : ''}</span>
      {label}
    </button>
  );
  return (
    <div className="menu-wrap" ref={ref}>
      <IconButton title="Diff options" aria-label="Diff options" onClick={() => setOpen((o) => !o)}>
        ⋯
      </IconButton>
      {open && (
        <Menu place="down" align="right">
          {item('list', 'Show file list')}
          {item('group', 'Group files by folder')}
          <div className="sep" />
          {item('split', 'Side by side')}
          {item('wrap', 'Word wrap')}
          {item('words', 'Highlight changed words')}
          {item('ws', 'Hide whitespace changes')}
          <div className="sep" />
          <button onClick={() => (setOpen(false), onToggleAll())}>
            <span className="check" />
            {anyOpen ? 'Collapse all files' : 'Expand all files'}
          </button>
        </Menu>
      )}
    </div>
  );
}

function Changes({ sessionId, refreshKey, onOpenFile, onPrompt, busy, wide }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState([]);
  const [opts, setOptsState] = useState(loadOpts);
  const [base, setBase] = useState('HEAD');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(null);
  const listRef = useRef(null);
  const setOpts = (patch) =>
    setOptsState((o) => {
      const next = { ...o, ...patch };
      try {
        localStorage.setItem(DIFF_OPTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const onComment = (c) => setComments((list) => (c.remove ? list.filter((x) => x.id !== c.remove) : [...list, { ...c, id: Math.random().toString(36).slice(2) }]));
  const sendReview = () => {
    onPrompt(reviewPrompt(comments));
    setComments([]);
  };
  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (base !== 'HEAD') qs.set('base', base);
    if (opts.ws) qs.set('ws', '0');
    api(`/api/sessions/${sessionId}/changes?${qs}`)
      .then(setData)
      .catch((e) => setData({ error: e.message }))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sessionId, refreshKey, base, opts.ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => {
    if (!data?.files) return [];
    const mine = new Set(data.claude || []);
    const needle = q.trim().toLowerCase();
    return data.files.filter((f) => (!opts.mine || mine.has(f.path)) && (!needle || f.path.toLowerCase().includes(needle)));
  }, [data, opts.mine, q]);

  if (!data) return <div className="panel-empty">Loading…</div>;
  if (data.error)
    return (
      <div className="panel-empty">
        {data.error}
        {base !== 'HEAD' && (
          <div>
            <Button size="sm" onClick={() => setBase('HEAD')}>
              Show uncommitted changes
            </Button>
          </div>
        )}
      </div>
    );
  if (!data.git) return <div className="panel-empty">This folder isn't a git repository, so there's no change list. Edits still show as diffs in the chat.</div>;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const anyOpen = files.some((f) => open[f.path]);
  const pick = (p) => {
    setOpen((o) => ({ ...o, [p]: true }));
    setActive(p);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const sideList = opts.list && wide && files.length > 1;
  const nMine = (data.claude || []).filter((p) => data.files.some((f) => f.path === p)).length;

  return (
    <>
      <div className="changes-summary">
        <select className="base-pick" value={base} onChange={(e) => setBase(e.target.value)} title="Compare with">
          <option value="HEAD">Uncommitted</option>
          {(data.bases || []).map((b) => (
            <option key={b} value={b}>
              Since {b}
            </option>
          ))}
        </select>
        <span className="muted">→</span>
        <span className="pill mono" title="Current branch">
          ⎇ {data.branch}
        </span>
        <span className="spacer" />
        <span className="changes-count">
          {files.length} file{files.length === 1 ? '' : 's'} <span className="add">+{add}</span> <span className="del">−{del}</span>
        </span>
        <IconButton title="Refresh" onClick={load}>
          {loading ? <span className="spinner" /> : '↻'}
        </IconButton>
        <DiffOptions opts={opts} set={setOpts} anyOpen={anyOpen} onToggleAll={() => setOpen(Object.fromEntries(files.map((f) => [f.path, !anyOpen])))} />
      </div>
      <div className="changes-filter">
        <input className="field sm" type="search" placeholder="Search changed files" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search changed files" />
        <button className={`chip ${opts.mine ? 'on' : ''}`} aria-pressed={opts.mine} onClick={() => setOpts({ mine: !opts.mine })} title="Only files Claude edited in this chat, not changes from commands it ran or your own edits">
          Claude's edits only{nMine ? ` · ${nMine}` : ''}
        </button>
      </div>
      <PrCard sessionId={sessionId} refreshKey={refreshKey} onPrompt={onPrompt} busy={busy} />
      {onPrompt && base === 'HEAD' && (
        <div className="git-actions">
          <Button size="sm" disabled={busy || !data.files.length} onClick={() => onPrompt('Commit the current changes with a clear commit message. Stage only the files that belong to this work.')}>
            Commit
          </Button>
          <Button size="sm" disabled={busy || !data.files.length} onClick={() => onPrompt('Commit the current changes with a clear commit message, then push the branch.')}>
            Commit and push
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onPrompt('Commit any uncommitted changes, push this branch, and open a pull request with a clear title and description. Use the gh CLI if it is available, and give me the PR link.')}>
            Create PR
          </Button>
        </div>
      )}
      {comments.length > 0 && (
        <div className="review-bar">
          <span>
            {comments.length} comment{comments.length === 1 ? '' : 's'}
          </span>
          <span className="spacer" />
          <Button variant="ghost" size="sm" onClick={() => setComments([])}>
            Discard
          </Button>
          <Button variant="primary" size="sm" disabled={busy || !onPrompt} onClick={sendReview} title="Ctrl/⌘ Enter">
            Send to Claude
          </Button>
        </div>
      )}
      {data.files.length === 0 && <div className="panel-empty">{base === 'HEAD' ? 'No uncommitted changes.' : `No changes since ${base}.`}</div>}
      {data.files.length > 0 && files.length === 0 && <div className="panel-empty">No changed files match.</div>}
      <div className={`changes-body ${sideList ? 'side' : ''}`}>
        {opts.list && files.length > 1 && <FileList files={files} group={opts.group} active={active} onPick={pick} />}
        <div className="changes-files" ref={listRef}>
          {files.map((f) => (
            <div key={f.path} className="change-file" data-path={f.path}>
              <button className="change-head" onClick={() => setOpen((o) => ({ ...o, [f.path]: !o[f.path] }))}>
                <span className="chev">{open[f.path] ? '▾' : '▸'}</span>
                <span className={`cstatus ${f.status}`}>{f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}</span>
                <span className="cpath" title={f.path}>
                  {f.path}
                </span>
                <span className="tstats">
                  {f.add > 0 && <span className="add">+{f.add}</span>}
                  {f.del > 0 && <span className="del">−{f.del}</span>}
                </span>
                {f.status !== 'deleted' && (
                  <span
                    className="icon-btn"
                    title="Open file"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(f.path);
                    }}
                  >
                    ↗
                  </span>
                )}
              </button>
              {open[f.path] && <DiffView diff={f.diff} path={f.path} comments={comments} onComment={onPrompt ? onComment : null} split={opts.split} wrap={opts.wrap} words={opts.words} />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function FileView({ sessionId, path, refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    api(`/api/file?session=${sessionId}&path=${encodeURIComponent(path)}`)
      .then(setData)
      .catch((e) => setData({ error: e.message }));
  }, [sessionId, path, refreshKey]);
  if (!data) return <div className="panel-empty">Loading…</div>;
  if (data.error) return <div className="panel-empty">{data.error}</div>;
  if (data.binary) return <div className="panel-empty">Binary file ({Math.round(data.size / 1024)} KB)</div>;
  if (data.tooLarge) return <div className="panel-empty">File is too large to preview ({Math.round(data.size / 1024)} KB)</div>;
  const lines = data.content.split('\n');
  return (
    <>
      <div className="file-meta">
        <span className="grow ellipsis">{path}</span>
        <span>{lines.length} lines</span>
        <Button variant="ghost" size="sm" onClick={() => copyText(data.content)}>
          Copy
        </Button>
      </div>
      <div className="file-view diff flush">
        {lines.map((l, i) => (
          <div key={i} className="ln">
            <span className="lno">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(l, path) || ' ' }} />
          </div>
        ))}
      </div>
    </>
  );
}

function PaneTabs({ tab, files, titles, tasks, liveTasks, onTab, onCloseFile, terminal }) {
  return (
    <div className="panel-tabs">
      <button className={`panel-tab ${tab === 'changes' ? 'on' : ''}`} onClick={() => onTab('changes')}>
        Changes
      </button>
      <button className={`panel-tab ${tab === 'browser' ? 'on' : ''}`} onClick={() => onTab('browser')}>
        Browser
      </button>
      {terminal && (
        <button className={`panel-tab ${tab === 'terminal' ? 'on' : ''}`} onClick={() => onTab('terminal')}>
          Terminal
        </button>
      )}
      {(tab === 'tasks' || tasks.length > 0) && (
        <button className={`panel-tab ${tab === 'tasks' ? 'on' : ''}`} onClick={() => onTab('tasks')} title="Background tasks">
          Background{liveTasks > 0 && <span className="count tab-count">{liveTasks}</span>}
        </button>
      )}
      {files.map((f) => (
        <button key={f} className={`panel-tab ${tab === f ? 'on' : ''}`} onClick={() => onTab(f)} title={f.replace(/^art:/, '')}>
          {f.startsWith('art:') ? '◇ ' : ''}
          {titles[f] || f.split(/[\\/]/).pop()}
          {onCloseFile && (
            <span
              style={{ marginLeft: 6, opacity: 0.6 }}
              onClick={(e) => {
                e.stopPropagation();
                onCloseFile(f);
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// Stacked and side-by-side splits each remember their own divider position.
function readRatio(dir) {
  try {
    const r = parseFloat(localStorage.getItem('cw.splitRatio.' + dir));
    return r > 0.15 && r < 0.85 ? r : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * The side panel. With split on it shows two panes at once (Desktop's multi-pane workspace):
 * stacked when the panel is narrow, side by side when it's wide; drag the divider to resize.
 * `terminal` is the chat's terminal view (or null) so it can live in a pane instead of the drawer.
 */
export default function SidePanel({ sessionId, tab, files, titles = {}, onTab, onCloseFile, onClose, refreshKey, onOpenFile, onPrompt, busy, onError, wide, onWide, tasks = [], taskFocus, split, onSplit, terminal, onStartTerminal }) {
  const liveTasks = tasks.filter(isLive).length;
  // Normal and wide keep their own dragged widths.
  const resize = useResizable(wide ? 'panel-wide' : 'panel', { edge: 'left', min: 320, max: () => window.innerWidth - 420, label: 'Resize side panel' });
  const dir = wide ? 'across' : 'down';
  const [ratios, setRatios] = useState(() => ({ down: readRatio('down'), across: readRatio('across') }));
  const ratio = ratios[dir];
  const setRatio = (r) => setRatios((x) => ({ ...x, [dir]: typeof r === 'function' ? r(x[dir]) : r }));
  const bodyRef = useRef(null);
  const tabProps = { files, titles, tasks, liveTasks, terminal: !!onStartTerminal };

  const body = (t) =>
    t === 'changes' ? (
      <Changes sessionId={sessionId} refreshKey={refreshKey} onOpenFile={onOpenFile} onPrompt={onPrompt} busy={busy} wide={wide && !split} />
    ) : t === 'tasks' ? (
      <BackgroundTasks sessionId={sessionId} tasks={tasks} onError={onError} focus={taskFocus} />
    ) : t === 'browser' ? (
      <BrowserView sessionId={sessionId} onError={onError} />
    ) : t === 'terminal' ? (
      terminal || (
        <div className="pane-empty">
          <button className="btn" onClick={onStartTerminal}>
            Start a terminal in this folder
          </button>
        </div>
      )
    ) : t.startsWith('art:') ? (
      <ArtifactView sessionId={sessionId} path={t.slice(4)} refreshKey={refreshKey} />
    ) : (
      <FileView sessionId={sessionId} path={t} refreshKey={refreshKey} />
    );

  const drag = (e) => {
    e.preventDefault();
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box) return;
    const across = dir === 'across';
    const move = (ev) => {
      const pt = ev.touches ? ev.touches[0] : ev;
      const r = across ? (pt.clientX - box.left) / box.width : (pt.clientY - box.top) / box.height;
      setRatio(Math.min(0.85, Math.max(0.15, r)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('pane-dragging', 'across', 'down');
      setRatio((r) => {
        try {
          localStorage.setItem('cw.splitRatio.' + dir, String(r));
        } catch {}
        return r;
      });
    };
    document.body.classList.add('pane-dragging', across ? 'across' : 'down');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside className={`side-panel ${wide ? 'wide' : ''} ${split ? 'split' : ''}`} ref={resize.ref} style={resize.style}>
      {resize.handle}
      <div className="panel-head">
        <PaneTabs tab={tab} onTab={onTab} onCloseFile={onCloseFile} {...tabProps} />
        {onSplit && (
          <IconButton className={`hide-mobile ${split ? 'on' : ''}`} title={split ? 'Show one pane' : 'Split: show two panes at once'} onClick={() => onSplit(split ? null : tab === 'changes' ? 'browser' : 'changes')}>
            {wide ? '◫' : '⊟'}
          </IconButton>
        )}
        <IconButton className="hide-mobile" title={wide ? 'Narrower' : 'Wider'} onClick={onWide}>
          {wide ? '⇥' : '⇤'}
        </IconButton>
        <IconButton title="Close panel" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      {split ? (
        <div className={`pane-split ${wide ? 'across' : 'down'}`} ref={bodyRef}>
          <div className="panel-body pane-a" style={{ flexBasis: `${ratio * 100}%` }}>
            {body(tab)}
          </div>
          <div className="pane-divider" onPointerDown={drag} role="separator" aria-orientation={wide ? 'vertical' : 'horizontal'} title="Drag to resize" />
          <div className="pane-b">
            <div className="pane-head-2">
              <PaneTabs tab={split} onTab={onSplit} {...tabProps} />
              <IconButton title="Close this pane" onClick={() => onSplit(null)}>
                ✕
              </IconButton>
            </div>
            <div className="panel-body">{body(split)}</div>
          </div>
        </div>
      ) : (
        <div className="panel-body">{body(tab)}</div>
      )}
    </aside>
  );
}
