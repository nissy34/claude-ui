import React, { useMemo, useState } from 'react';
import { diffWordsWithSpace } from 'diff';
import { highlight } from './markdown.js';
import { Button, IconButton } from '../ui/index.jsx';

// One file's diff for the Changes panel: unified or side by side, with line numbers, optional
// word-level highlights on changed lines, word wrap, and line comments for Claude.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Rows of a git diff: hunk headers, context, added and removed lines with their numbers. */
export function parseDiff(diff) {
  const rows = [];
  let oldN = 0;
  let newN = 0;
  for (const line of diff.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) continue;
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (m) (oldN = +m[1]), (newN = +m[2]);
      rows.push({ k: 'hunk', text: line.replace(/^(@@[^@]*@@).*/, '$1') });
    } else if (line.startsWith('+')) rows.push({ k: 'add', text: line.slice(1), n: newN++ });
    else if (line.startsWith('-')) rows.push({ k: 'del', text: line.slice(1), o: oldN++ });
    else if (line.startsWith('\\')) continue;
    else rows.push({ k: 'ctx', text: line.slice(1), o: oldN++, n: newN++ });
  }
  // Pair each run of removed lines with the added lines right after it, for word highlights
  // and the side-by-side view.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].k !== 'del') continue;
    let j = i;
    while (j < rows.length && rows[j].k === 'del') j++;
    let k = j;
    while (k < rows.length && rows[k].k === 'add') k++;
    for (let x = 0; x < Math.min(j - i, k - j); x++) {
      rows[i + x].pair = rows[j + x];
      rows[j + x].pair = rows[i + x];
    }
    i = k - 1;
  }
  return rows;
}

/** A line's HTML: syntax colors, or with `words`, the changed words marked against its pair. */
function lineHtml(row, path, words) {
  if (row.k === 'hunk') return esc(row.text);
  if (words && row.pair && (row.k === 'add' || row.k === 'del')) {
    const [a, b] = row.k === 'del' ? [row.text, row.pair.text] : [row.pair.text, row.text];
    const parts = diffWordsWithSpace(a, b);
    // Only worth marking when most of the line stayed the same.
    const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
    if (same >= Math.min(a.length, b.length) * 0.4) {
      return (
        parts
          .filter((p) => (row.k === 'del' ? !p.added : !p.removed))
          .map((p) => (p.added || p.removed ? `<mark class="dw">${esc(p.value)}</mark>` : esc(p.value)))
          .join('') || ' '
      );
    }
  }
  return highlight(row.text, path) || ' ';
}

function CommentRows({ comments, path, row, side, onComment }) {
  const line = row.k === 'del' ? row.o : row.n;
  const old = row.k === 'del';
  return comments
    ?.filter((c) => c.path === path && c.line === line && c.old === old && c.code === row.text && (!side || side === (old ? 'old' : 'new')))
    .map((c) => (
      <div key={c.id} className="dl-comment">
        <span>{c.text}</span>
        <IconButton title="Remove comment" onClick={() => onComment({ remove: c.id })}>
          ✕
        </IconButton>
      </div>
    ));
}

function Draft({ draft, setDraft, onSave }) {
  return (
    <div className="dl-draft fields sm">
      <textarea
        autoFocus
        rows={2}
        placeholder="Comment for Claude (Ctrl/⌘ Enter to add)"
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), onSave());
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      <div className="row">
        <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!draft.text.trim()} onClick={onSave}>
          Add comment
        </Button>
      </div>
    </div>
  );
}

const MAX_ROWS = 3000;

export default function DiffView({ diff, path, comments, onComment, split, wrap, words }) {
  const [draft, setDraft] = useState(null); // { key, line, old, code, text }
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const shown = rows.slice(0, MAX_ROWS);
  const startDraft = (key, row) => setDraft({ key, line: row.k === 'del' ? row.o : row.n, old: row.k === 'del', code: row.text, text: '' });
  const save = () => {
    if (draft?.text.trim()) onComment({ path, line: draft.line, old: draft.old, code: draft.code, text: draft.text.trim() });
    setDraft(null);
  };
  const addBtn = (key, row) =>
    onComment && row && row.k !== 'hunk' ? (
      <button className="dl-add" title="Comment on this line" onClick={() => startDraft(key, row)}>
        +
      </button>
    ) : null;

  if (!split) {
    return (
      <div className={`diff numbered ${wrap ? 'wrap' : ''}`}>
        {shown.map((r, i) => (
          <React.Fragment key={i}>
            <div className={`dl ${r.k}`}>
              {addBtn(i, r)}
              {r.k !== 'hunk' && (
                <>
                  <span className="lno">{r.o ?? ''}</span>
                  <span className="lno">{r.n ?? ''}</span>
                </>
              )}
              <span className="dm">{r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''}</span>
              <span className="dt" dangerouslySetInnerHTML={{ __html: lineHtml(r, path, words) }} />
            </div>
            {r.k !== 'hunk' && <CommentRows comments={comments} path={path} row={r} onComment={onComment} />}
            {draft?.key === i && <Draft draft={draft} setDraft={setDraft} onSave={save} />}
          </React.Fragment>
        ))}
        {rows.length > shown.length && <div className="dl gap">… {rows.length - shown.length} more lines</div>}
      </div>
    );
  }

  // Side by side: context on both sides, a removed line beside the added line it became.
  const pairs = [];
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    if (r.k === 'hunk') pairs.push({ hunk: r });
    else if (r.k === 'ctx') pairs.push({ left: r, right: r });
    else if (r.k === 'del') pairs.push({ left: r, right: r.pair || null });
    else if (r.k === 'add' && !r.pair) pairs.push({ left: null, right: r });
  }
  const cell = (r, side, key) => (
    <div className={`dc ${r ? r.k : 'empty'}`}>
      {r && addBtn(key, r)}
      <span className="lno">{r ? (side === 'old' ? r.o : r.n) : ''}</span>
      <span className="dt" dangerouslySetInnerHTML={{ __html: r ? lineHtml(r, path, words) : '' }} />
    </div>
  );
  return (
    <div className={`diff split ${wrap ? 'wrap' : ''}`}>
      {pairs.map((p, i) =>
        p.hunk ? (
          <div key={i} className="dl hunk">
            {p.hunk.text}
          </div>
        ) : (
          <React.Fragment key={i}>
            <div className="dsplit">
              {cell(p.left, 'old', `${i}L`)}
              {cell(p.right, 'new', `${i}R`)}
            </div>
            {p.left && p.left.k === 'del' && <CommentRows comments={comments} path={path} row={p.left} side="old" onComment={onComment} />}
            {p.right && p.right.k !== 'del' && <CommentRows comments={comments} path={path} row={p.right} side="new" onComment={onComment} />}
            {(draft?.key === `${i}L` || draft?.key === `${i}R`) && <Draft draft={draft} setDraft={setDraft} onSave={save} />}
          </React.Fragment>
        ),
      )}
      {rows.length > shown.length && <div className="dl gap">… {rows.length - shown.length} more lines</div>}
    </div>
  );
}
