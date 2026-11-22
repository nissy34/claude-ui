import React, { useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatCtx } from './ctx.js';
import { artifactKind } from './ArtifactView.jsx';
import { diffLines } from 'diff';
import { highlight, renderMarkdown } from './markdown.js';
import Linkify from './Linkify.jsx';
import { shortPath, isPlanTool, planTodos, isPublishTool, isPinViewTool, publishedPath } from './model.js';
import { Button } from '../ui/index.jsx';

const ICONS = {
  mcp__ui__publish_artifact: '◰',
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

const STOPPED_RE = /^\s*(The user doesn't want to proceed with this tool use|\[Request interrupted by user)/;

// The tool_result Claude Code returns when auto mode's safety classifier blocked the call.
const CLASSIFIER_RE = /denied by the Claude Code auto mode classifier\.(?:\s*Reason:\s*(.+?)\.(?:\s+If you have|\s*$))?/is;

/** Auto mode blocked this call: say so plainly, with the classifier's reason and a way to approve it. */
function AutoModeBlocked({ item, reason }) {
  const ctx = useContext(ChatCtx);
  const [sent, setSent] = useState(false);
  const allowed = item.allowed || sent;
  const what = item.name === 'Bash' || item.name === 'PowerShell' ? 'this command' : 'this call';
  return (
    <div className="tool-blocked">
      <span className="tb-text" title={reason || undefined}>
        Auto mode blocked {what}
        {reason ? <span className="muted">: {reason.replace(/^\[|\]$/g, '')}</span> : null}
      </span>
      {allowed ? (
        <span className="muted tb-done">Allowed in this chat</span>
      ) : !ctx.allowDenied ? null : (
        <Button
          size="sm"
          title={`Allow ${what} for the rest of this chat and ask Claude to run it again`}
          onClick={() => {
            if (ctx.allowDenied?.(item.id)) setSent(true);
          }}
        >
          Allow and run again
        </Button>
      )}
    </div>
  );
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
        <Button as="a" size="sm" href={src} target="_blank" rel="noreferrer">
          Open original ↗
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
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
  const publish = isPublishTool(name);
  // What publish_artifact published: the server's path once done, else the file it was given.
  const published = publish ? (result && !result.isError && publishedPath(result.text)) || input?.path || null : null;
  const pinned = isPinViewTool(name) && typeof input?.path === 'string' ? input.path : null;
  const artPath = published || pinned || filePath;
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
  // Stop (or a denial) makes the CLI answer the tool with its own "doesn't want to proceed" boilerplate.
  const stopped = !!result?.isError && STOPPED_RE.test(result.text || '');
  const status = stopped ? 'stopped' : result ? (result.isError ? 'error' : 'done') : item.perm && !item.perm.done ? 'waiting' : 'running';
  const blocked = status === 'error' && !plan ? CLASSIFIER_RE.exec(result.text || '') : null;
  const summary = toolSummary(name, input, cwd);
  const body = open ? <ToolBody name={name} input={input} cwd={cwd} /> : null;
  const resultText = result?.text || '';
  // Started in the background (run_in_background, Monitor, background agent): link to its row in Background tasks.
  const bg = item.id && ctx.bgTasks?.[item.id];
  const hideResultByDefault = publish || ['Read', 'Edit', 'Write', 'MultiEdit', 'TodoWrite', 'Glob', 'Grep'].includes(name);

  return (
    <div className={`tool ${status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="ticon">{ICONS[name] || '⚙'}</span>
        <span className="tname">{plan ? item.input?.title || 'Plan' : publish ? 'Published artifact' : isSessionTool ? sessionLabel : name.replace(/^mcp__([^_]+)__/, '$1 · ')}</span>
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
          <span className="tsum">{publish ? input?.title || (published || '').split(/[\\/]/).pop() || '' : isSessionTool ? input?.name || input?.prompt?.slice(0, 80) || input?.message?.slice(0, 80) || summary : summary}</span>
        )}
        {stats && (
          <span className="tstats">
            {stats.add > 0 && <span className="add">+{stats.add}</span>}
            {stats.del > 0 && <span className="del">−{stats.del}</span>}
          </span>
        )}
        {bg && (
          <span
            className={`pill tbg ${bg.live ? 'accent' : ''}`}
            title="Show in Background tasks"
            onClick={(e) => {
              e.stopPropagation();
              ctx.openTask(bg.id);
            }}
          >
            {bg.live ? 'Running in background' : 'Background'}
          </span>
        )}
        <span className={`tstate ${status}`}>{status === 'running' ? <span className="spinner" /> : status === 'error' ? '!' : status === 'stopped' ? '■' : status === 'waiting' ? '…' : '✓'}</span>
      </button>
      {result?.images?.length > 0 && <ToolImages images={result.images} label={name.replace(/^mcp__([^_]+)__/, '$1 · ')} />}
      {stopped && !open && item.perm?.done !== 'deny' && <div className="tool-stopped">Stopped</div>}
      {blocked && <AutoModeBlocked item={item} reason={blocked[1]} />}
      {status === 'error' && !blocked && !open && resultText && (
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
      {artPath && name !== 'Read' && artifactKind(artPath) && status !== 'error' && status !== 'stopped' && (!(publish || pinned) || status === 'done') && (
        <button className="artifact-card card interactive" onClick={() => ctx.openArtifact(artPath, publish || pinned ? input?.title : undefined)} title={artPath}>
          <span className="art-icon">{{ html: '◰', image: '▣', markdown: '¶', pdf: '▤', csv: '▦' }[artifactKind(artPath)]}</span>
          <span className="art-meta">
            <b>{((publish || pinned) && input?.title) || artPath.split(/[\\/]/).pop()}</b>
            <span className="muted">{{ html: 'Web page', image: 'Image', markdown: 'Document', pdf: 'PDF', csv: 'Table' }[artifactKind(artPath)]} · click to open</span>
          </span>
          <span className="muted">↗</span>
        </button>
      )}
      {linkedSession && (
        <div className="tool-body">
          <Button size="sm" className="open-session" onClick={() => ctx.openSession(linkedSession)}>
            Open session →
          </Button>
        </div>
      )}
      {children}
    </div>
  );
}

const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mcpParts = (name) => {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2].replace(/_/g, ' ') } : null;
};

// One verb phrase per kind of tool, in the order they first ran, like Desktop's
// "Edited CLAUDE.md, ran 2 commands, read 3 files".
const GROUP_KINDS = [
  { names: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'], say: (ts) => { const f = [...new Set(ts.map((t) => fileName(t.input?.file_path || t.input?.notebook_path)))]; return f.length === 1 ? `edited ${f[0]}` : `edited ${plural(f.length, 'file')}`; } },
  { names: ['Read', 'NotebookRead'], say: (ts) => { const f = [...new Set(ts.map((t) => fileName(t.input?.file_path || t.input?.notebook_path)))]; return f.length === 1 ? `read ${f[0]}` : `read ${plural(f.length, 'file')}`; } },
  { names: ['Grep', 'Glob', 'LS'], say: (ts) => `searched ${plural(ts.length, 'pattern')}` },
  { names: ['Bash', 'BashOutput', 'KillShell'], say: (ts) => (ts.length === 1 ? 'ran a command' : `ran ${plural(ts.length, 'command')}`) },
  { names: ['WebFetch'], say: (ts) => `fetched ${plural(ts.length, 'page')}` },
  { names: ['WebSearch'], say: (ts) => `searched the web${ts.length > 1 ? ` ${ts.length} times` : ''}` },
  { names: ['ToolSearch'], say: () => 'loaded tools' },
];

export function groupSummary(tools) {
  const buckets = new Map(); // key -> {say, tools}
  for (const t of tools) {
    const kind = GROUP_KINDS.find((k) => k.names.includes(t.name));
    const mcp = !kind && mcpParts(t.name);
    const key = kind ? kind.names[0] : mcp ? 'mcp:' + mcp.server : 'other';
    if (!buckets.has(key)) {
      const say = kind
        ? kind.say
        : mcp
          ? (ts) => { const names = [...new Set(ts.map((x) => mcpParts(x.name).tool))]; return `used ${mcp.server}: ${names.length <= 2 ? names.join(', ') : plural(names.length, 'tool')}`; }
          : (ts) => (ts.length === 1 ? `used ${ts[0].name}` : `used ${plural(ts.length, 'other tool')}`);
      buckets.set(key, { say, tools: [] });
    }
    buckets.get(key).tools.push(t);
  }
  const s = [...buckets.values()].map((b) => b.say(b.tools)).join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A run of tool calls folded into one line like "Edited app.js, ran 2 commands". What matters at a
 *  glance stays visible under it: edited files with their +/−, pictures the tools returned, and
 *  pages or documents Claude wrote. Expand for the full cards. */
export function ToolGroup({ tools, cwd }) {
  const running = tools.some((t) => !t.result);
  const failed = tools.filter((t) => t.result?.isError).length;
  const { verbose, openFile, openArtifact } = useContext(ChatCtx);
  const [open, setOpen] = useState(verbose);
  React.useEffect(() => setOpen(verbose), [verbose]);
  const edits = useMemo(() => {
    const m = new Map();
    for (const t of tools) {
      if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t.name) || t.result?.isError) continue;
      const p = t.input?.file_path || t.input?.notebook_path;
      if (!p) continue;
      const st = diffStats(t.name, t.input || {}) || { add: 0, del: 0 };
      const cur = m.get(p) || { path: p, add: 0, del: 0, wrote: false };
      m.set(p, { ...cur, add: cur.add + (st.add || 0), del: cur.del + (st.del || 0), wrote: cur.wrote || t.name === 'Write' });
    }
    return [...m.values()];
  }, [tools]);
  const add = edits.reduce((n, e) => n + e.add, 0);
  const del = edits.reduce((n, e) => n + e.del, 0);
  const images = tools.flatMap((t) => t.result?.images || []);
  // Pages and pictures Claude wrote get a card, like a lone Write does; edited docs stay chips.
  const arts = edits.filter((e) => e.wrote && artifactKind(e.path));
  return (
    <div className={`tool-group ${failed ? 'has-err' : ''}`}>
      <button className="tool-group-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {running ? <span className="spinner" /> : <span className="ticon">⋯</span>}
        <span className="tg-sum">{groupSummary(tools)}</span>
        {failed > 0 && <span className="del">{failed} failed</span>}
        {(add > 0 || del > 0) && (
          <span className="tstats">
            {add > 0 && <span className="add">+{add}</span>}
            {del > 0 && <span className="del">−{del}</span>}
          </span>
        )}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {!open && (edits.length > 0 || images.length > 0) && (
        <div className="tg-extras">
          {edits.length > 0 && (
            <div className="tg-files">
              {edits.map((e) => (
                <button key={e.path} className="tg-file" title={e.path} onClick={() => (artifactKind(e.path) ? openArtifact(e.path) : openFile(e.path))}>
                  <span className="mono">{fileName(e.path)}</span>
                  {e.add > 0 && <span className="add">+{e.add}</span>}
                  {e.del > 0 && <span className="del">−{e.del}</span>}
                </button>
              ))}
            </div>
          )}
          {images.length > 0 && <ToolImages images={images} label="Tool" />}
        </div>
      )}
      {!open && arts.length > 0 && arts.length <= 2 && arts.map((a) => (
        <button key={'art' + a.path} className="artifact-card card interactive" onClick={() => openArtifact(a.path)} title={a.path}>
          <span className="art-icon">{{ html: '◰', image: '▣', markdown: '¶', pdf: '▤', csv: '▦' }[artifactKind(a.path)]}</span>
          <span className="art-meta">
            <b>{fileName(a.path)}</b>
            <span className="muted">{{ html: 'Web page', image: 'Image', markdown: 'Document', pdf: 'PDF', csv: 'Table' }[artifactKind(a.path)]} · click to open</span>
          </span>
          <span className="muted">↗</span>
        </button>
      ))}
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
