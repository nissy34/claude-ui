import React, { useContext, useMemo, useState } from 'react';
import { ChatCtx } from './ctx.js';
import { artifactKind } from './ArtifactView.jsx';
import { diffLines } from 'diff';
import { highlight, renderMarkdown } from './markdown.js';
import { shortPath } from './model.js';

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
      return <pre className="code-sm bash">$ {i.command}</pre>;
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

export default function ToolCard({ item, cwd, children }) {
  const { name, input, result } = item;
  const ctx = useContext(ChatCtx);
  const filePath = FILE_TOOLS[name] && input?.[FILE_TOOLS[name]];
  const isSessionTool = /^mcp__sessions__(start_session|send_to_session|read_session)$/.test(name);
  const linkedSession = isSessionTool ? childSessionId(result) || input?.id : null;
  const isEditLike = ['Edit', 'MultiEdit', 'Write', 'TodoWrite', 'ExitPlanMode'].includes(name);
  const [open, setOpen] = useState(isEditLike && !(name === 'Write' && filePath && artifactKind(filePath)));
  const [showResult, setShowResult] = useState(false);
  const stats = useMemo(() => diffStats(name, input || {}), [name, input]);
  const status = result ? (result.isError ? 'error' : 'done') : item.perm && !item.perm.done ? 'waiting' : 'running';
  const summary = toolSummary(name, input, cwd);
  const body = open ? <ToolBody name={name} input={input} cwd={cwd} /> : null;
  const resultText = result?.text || '';
  const hideResultByDefault = ['Read', 'Edit', 'Write', 'MultiEdit', 'TodoWrite', 'Glob', 'Grep'].includes(name);

  return (
    <div className={`tool ${status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="ticon">{ICONS[name] || '⚙'}</span>
        <span className="tname">{isSessionTool ? { start_session: 'Started session', send_to_session: 'Messaged session', read_session: 'Checked session' }[name.split('__')[2]] : name.replace(/^mcp__([^_]+)__/, '$1 · ')}</span>
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
        <span className={`tstate ${status}`}>{status === 'running' ? <span className="spinner" /> : status === 'error' ? '!' : status === 'waiting' ? '…' : '✓'}</span>
      </button>
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
            <pre className={`code-sm result ${result.isError ? 'err' : ''}`}>{resultText}</pre>
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
  const [open, setOpen] = useState(false);
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
