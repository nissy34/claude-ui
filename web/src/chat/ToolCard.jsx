import React, { useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatCtx } from './ctx.js';
import { artifactKind } from './ArtifactView.jsx';
import { diffLines } from 'diff';
import { highlight, renderMarkdown } from './markdown.js';
import Linkify from './Linkify.jsx';
import { shortPath, isPlanTool, planTodos } from './model.js';

const ICONS = {
  Bash: '›_',
  Read: '◱',
  Write: '✚',
  Edit: '✎',
  MultiEdit: '✎',
  NotebookEdit: '✎',
  Grep: '⌕',
  Glob: '⌕',
  WebFetch: '◍',
  WebSearch: '◍',
  TodoWrite: '☑',
  Task: '◈',
  Agent: '◈',
  ExitPlanMode: '▤',
  AskUserQuestion: '?',
};

export function toolSummary(name, input, cwd) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return i.description || i.command;
    case 'Read':
      return shortPath(i.file_path, cwd) + (i.offset ? `:${i.offset}` : '');
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return shortPath(i.file_path, cwd);
    case 'NotebookEdit':
      return shortPath(i.notebook_path, cwd);
    case 'Grep':
      return `"${i.pattern}"${i.path ? ` in ${shortPath(i.path, cwd)}` : ''}${i.glob ? ` (${i.glob})` : ''}`;
    case 'Glob':
      return i.pattern;
    case 'WebFetch':
      return i.url;
    case 'WebSearch':
      return i.query;
    case 'TodoWrite':
      return `${(i.todos || []).filter((t) => t.status === 'completed').length}/${(i.todos || []).length} done`;
    case 'Task':
    case 'Agent':
      return i.description || i.subagent_type;
    case 'ExitPlanMode':
      return 'Plan ready for review';
    case 'AskUserQuestion':
      return (i.questions || [])[0]?.question;
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return first ? first.slice(0, 120) : '';
    }
  }
}

function countDiff(parts) {
  let add = 0,
    del = 0;
  for (const p of parts) {
    const n = p.count ?? p.value.split('\n').length - 1;
    if (p.added) add += n;
    else if (p.removed) del += n;
  }
  return { add, del };
}

export function Diff({ oldText = '', newText = '', path, maxLines = 400 }) {
  const parts = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const rows = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    const kind = p.added ? 'add' : p.removed ? 'del' : 'ctx';
    if (kind === 'ctx' && lines.length > 6) {
      lines.slice(0, 3).forEach((l) => rows.push([kind, l]));
      rows.push(['gap', `… ${lines.length - 6} unchanged lines`]);
      lines.slice(-3).forEach((l) => rows.push([kind, l]));
    } else lines.forEach((l) => rows.push([kind, l]));
  }
  const shown = rows.slice(0, maxLines);
  return (
    <div className="diff">
      {shown.map(([k, l], i) => (
        <div key={i} className={`dl ${k}`}>
          <span className="dm">{k === 'add' ? '+' : k === 'del' ? '−' : k === 'gap' ? '' : ' '}</span>
          {k === 'gap' ? <span className="muted">{l}</span> : <span dangerouslySetInnerHTML={{ __html: highlight(l, path) || ' ' }} />}
        </div>
      ))}
      {rows.length > maxLines && <div className="dl gap">… {rows.length - maxLines} more lines</div>}
    </div>
  );
}

export function diffStats(name, input) {
  if (name === 'Edit') return countDiff(diffLines(input.old_string || '', input.new_string || ''));
  if (name === 'MultiEdit') {
    let add = 0,
      del = 0;
    for (const e of input.edits || []) {
      const c = countDiff(diffLines(e.old_string || '', e.new_string || ''));
      add += c.add;
      del += c.del;
    }
    return { add, del };
  }
  if (name === 'Write') return { add: (input.content || '').split('\n').length, del: 0 };
  return null;
}

/** The detailed body of a tool call: used in the card and in permission prompts. */
export function ToolBody({ name, input, cwd }) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return <pre className="code-sm bash">$ <Linkify text={i.command} /></pre>;
    case 'Edit':
      return <Diff oldText={i.old_string} newText={i.new_string} path={i.file_path} />;
    case 'MultiEdit':
      return (
        <>
          {(i.edits || []).map((e, n) => (
            <Diff key={n} oldText={e.old_string} newText={e.new_string} path={i.file_path} />
          ))}
        </>
      );
    case 'Write':
      return <Diff oldText="" newText={i.content || ''} path={i.file_path} maxLines={200} />;
    case 'TodoWrite':
      return <Todos todos={i.todos} />;
    case 'ExitPlanMode':
      return <div className="md plan" dangerouslySetInnerHTML={{ __html: renderMarkdown(i.plan || '') }} />;
    case 'Task':
    case 'Agent':
      return i.prompt ? <div className="md small" dangerouslySetInnerHTML={{ __html: renderMarkdown(i.prompt) }} /> : null;
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'WebFetch':
      return null;
    default:
      return <pre className="code-sm">{JSON.stringify(i, null, 2)}</pre>;
  }
}

export function Todos({ todos }) {
  if (!todos?.length) return null;
  return (
    <ul className="todos">
      {todos.map((t, n) => (
        <li key={n} className={t.status}>
          <span className="tbox">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''}</span>
          {t.status === 'in_progress' ? t.activeForm || t.content : t.content}
        </li>
      ))}
    </ul>
  );
}

const FILE_TOOLS = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function childSessionId(result) {
  try {
    return JSON.parse(result?.text || '')?.session?.id || null;
  } catch {
    return null;
  }
}

/** First meaningful line of a failed tool's result, for the collapsed row. */
function errorLine(text) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = line.replace(/^<tool_use_error>|<\/tool_use_error>$/g, '').replace(/^(MCP error -?\d+:\s*)/, '');
  return clean.length > 200 ? clean.slice(0, 200) + '…' : clean;
}

/** Pictures a tool returned (screenshots and the like), shown in the card; click one to enlarge. */
export function ToolImages({ images, label }) {
  const [big, setBig] = useState(null);
  const [broken, setBroken] = useState({});
  return (
    <div className="tool-images">
      {images.map((src, n) =>
        broken[src] ? (
          <span key={src + n} className="tool-image-gone muted">
            Image no longer available
          </span>
        ) : (
        <button key={src + n} className="tool-image" title="Click to enlarge" onClick={() => setBig(src)}>
          <img src={src} alt={`${label} result${images.length > 1 ? ` ${n + 1}` : ''}`} loading="lazy" onError={() => setBroken((b) => ({ ...b, [src]: true }))} />
        </button>
        ),
      )}
      {big && <ImageLightbox src={big} alt={label} onClose={() => setBig(null)} />}
    </div>
  );
}

export function ImageLightbox({ src, alt, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-label="Image" onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a className="btn small" href={src} target="_blank" rel="noreferrer">
          Open original ↗
        </a>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default function ToolCard({ item, cwd, children }) {
  const plan = isPlanTool(item.name);
  // update_plan renders like the built-in task list.
  const { name, input, result } = plan ? { ...item, name: 'TodoWrite', input: { todos: planTodos(item.input) } } : item;
  const ctx = useContext(ChatCtx);
  const filePath = FILE_TOOLS[name] && input?.[FILE_TOOLS[name]];
  const isSessionTool = /^mcp__sessions__(start_session|send_to_session|read_session)$/.test(name);
  const parentId = ctx.parentId;
  const sendTarget = String(input?.id ?? input?.session_id ?? input?.to ?? '');
  const sessionArg = /^parent$/i.test(sendTarget) ? parentId : sendTarget || undefined;
  const linkedSession = isSessionTool && !result?.isError ? childSessionId(result) || sessionArg : null;
  const sessionLabel =
    name === 'mcp__sessions__send_to_session'
      ? `${input?.wait_for_reply ? 'Asked' : 'Messaged'} ${/^parent$/i.test(sendTarget) || (parentId && sendTarget === parentId) ? 'parent' : 'session'}`
      : { start_session: 'Started session', read_session: 'Checked session' }[name.split('__')[2]];
  const isEditLike = ['Edit', 'MultiEdit', 'Write', 'TodoWrite', 'ExitPlanMode'].includes(name);
  const [open, setOpen] = useState(isEditLike && !plan && !(name === 'Write' && filePath && artifactKind(filePath)));
  const [showResult, setShowResult] = useState(false);
  const stats = useMemo(() => diffStats(name, input || {}), [name, input]);
  const status = result ? (result.isError ? 'error' : 'done') : item.perm && !item.perm.done ? 'waiting' : 'running';
  const summary = toolSummary(name, input, cwd);
  const body = open ? <ToolBody name={name} input={input} cwd={cwd} /> : null;
  const resultText = result?.text || '';
  // Started in the background (run_in_background, Monitor, background agent): link to its row in Background tasks.
  const bg = item.id && ctx.bgTasks?.[item.id];
  const hideResultByDefault = ['Read', 'Edit', 'Write', 'MultiEdit', 'TodoWrite', 'Glob', 'Grep'].includes(name);

  return (
    <div className={`tool ${status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="ticon">{ICONS[name] || '⚙'}</span>
        <span className="tname">{plan ? item.input?.title || 'Plan' : isSessionTool ? sessionLabel : name.replace(/^mcp__([^_]+)__/, '$1 · ')}</span>
        {filePath ? (
          <span
            className="tsum link"
            title="Open file"
            onClick={(e) => {
              e.stopPropagation();
              ctx.openFile(filePath);
            }}
          >
            {summary}
          </span>
        ) : (
          <span className="tsum">{isSessionTool ? input?.name || input?.prompt?.slice(0, 80) || input?.message?.slice(0, 80) || summary : summary}</span>
        )}
        {stats && (
          <span className="tstats">
            {stats.add > 0 && <span className="add">+{stats.add}</span>}
            {stats.del > 0 && <span className="del">−{stats.del}</span>}
          </span>
        )}
        {bg && (
          <span
            className={`tbg ${bg.live ? 'live' : ''}`}
            title="Show in Background tasks"
            onClick={(e) => {
              e.stopPropagation();
              ctx.openTask(bg.id);
            }}
          >
            {bg.live ? 'Running in background' : 'Background'}
          </span>
        )}
        <span className={`tstate ${status}`}>{status === 'running' ? <span className="spinner" /> : status === 'error' ? '!' : status === 'waiting' ? '…' : '✓'}</span>
      </button>
      {result?.images?.length > 0 && <ToolImages images={result.images} label={name.replace(/^mcp__([^_]+)__/, '$1 · ')} />}
      {status === 'error' && !open && resultText && (
        <div className="tool-err" title={resultText} onClick={() => setOpen(true)}>
          {errorLine(resultText)}
        </div>
      )}
      {open && (body || resultText || item.children?.length > 0) && (
        <div className="tool-body">
          {body}
          {item.children?.length > 0 && (
            <div className="subtools">
              {item.children.map((c) => (
                <div key={c.id} className={`subtool ${c.result ? (c.result.isError ? 'error' : 'done') : 'running'}`}>
                  <span className="ticon">{ICONS[c.name] || '⚙'}</span>
                  <span className="tname">{c.name}</span>
                  <span className="tsum">{toolSummary(c.name, c.input, cwd)}</span>
                </div>
              ))}
            </div>
          )}
          {resultText && (hideResultByDefault && !result.isError && !showResult ? (
            <button className="link-btn" onClick={() => setShowResult(true)}>
              Show output
            </button>
          ) : (
            <pre className={`code-sm result ${result.isError ? 'err' : ''}`}><Linkify text={resultText} /></pre>
          ))}
        </div>
      )}
      {filePath && name !== 'Read' && artifactKind(filePath) && status !== 'error' && (
        <button className="artifact-card" onClick={() => ctx.openArtifact(filePath)}>
          <span className="art-icon">{{ html: '◰', image: '▣', markdown: '¶', pdf: '▤', csv: '▦' }[artifactKind(filePath)]}</span>
          <span className="art-meta">
            <b>{filePath.split(/[\\/]/).pop()}</b>
            <span className="muted">{{ html: 'Web page', image: 'Image', markdown: 'Document', pdf: 'PDF', csv: 'Table' }[artifactKind(filePath)]} · click to open</span>
          </span>
          <span className="muted">↗</span>
        </button>
      )}
      {linkedSession && (
        <div className="tool-body" style={{ borderTop: '1px solid var(--line)' }}>
          <button className="btn small open-session" onClick={() => ctx.openSession(linkedSession)}>
            Open session →
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

const GROUP_LABELS = [
  [['Read', 'NotebookRead'], (n) => `read ${n} file${n > 1 ? 's' : ''}`],
  [['Grep', 'Glob', 'LS'], (n) => `searched ${n} pattern${n > 1 ? 's' : ''}`],
  [['Bash', 'BashOutput', 'KillShell'], (n) => `ran ${n} command${n > 1 ? 's' : ''}`],
  [['WebFetch', 'WebSearch'], (n) => `${n} web lookup${n > 1 ? 's' : ''}`],
];

export function groupSummary(tools) {
  const counts = new Map();
  let other = 0;
  for (const t of tools) {
    const g = GROUP_LABELS.find(([names]) => names.includes(t.name));
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
    else other++;
  }
  const parts = [...counts].map(([g, n]) => g[1](n));
  if (other) parts.push(`used ${other} other tool${other > 1 ? 's' : ''}`);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Several quiet tool calls in a row, folded into one line like "Read 3 files, ran 2 commands". */
export function ToolGroup({ tools, cwd }) {
  const running = tools.some((t) => !t.result);
  const failed = tools.filter((t) => t.result?.isError).length;
  const { verbose } = useContext(ChatCtx);
  const [open, setOpen] = useState(verbose);
  React.useEffect(() => setOpen(verbose), [verbose]);
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen((o) => !o)}>
        {running ? <span className="spinner" /> : <span className="ticon">⋯</span>}
        <span>{groupSummary(tools)}</span>
        {failed > 0 && <span className="del">({failed} failed)</span>}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolCard key={t.id} item={t} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}
