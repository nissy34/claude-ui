import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { highlight } from './markdown.js';
import ArtifactView from './ArtifactView.jsx';
import BrowserView from './BrowserView.jsx';

function UnifiedDiff({ diff, path }) {
  const rows = [];
  for (const line of diff.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith('@@')) rows.push(['hunk', line.replace(/^(@@[^@]*@@).*/, '$1')]);
    else if (line.startsWith('+')) rows.push(['add', line.slice(1)]);
    else if (line.startsWith('-')) rows.push(['del', line.slice(1)]);
    else if (line.startsWith('\\')) continue;
    else rows.push(['ctx', line.slice(1)]);
  }
  const shown = rows.slice(0, 3000);
  return (
    <div className="diff">
      {shown.map(([k, l], i) => (
        <div key={i} className={`dl ${k}`}>
          <span className="dm">{k === 'add' ? '+' : k === 'del' ? '−' : ''}</span>
          {k === 'hunk' ? <span>{l}</span> : <span dangerouslySetInnerHTML={{ __html: highlight(l, path) || ' ' }} />}
        </div>
      ))}
      {rows.length > shown.length && <div className="dl gap">… {rows.length - shown.length} more lines</div>}
    </div>
  );
}

function Changes({ sessionId, refreshKey, onOpenFile, onPrompt, busy }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    api(`/api/sessions/${sessionId}/changes`)
      .then(setData)
      .catch((e) => setData({ error: e.message }))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sessionId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="panel-empty">Loading…</div>;
  if (data.error) return <div className="panel-empty">{data.error}</div>;
  if (!data.git) return <div className="panel-empty">This folder isn't a git repository, so there's no change list. Edits still show as diffs in the chat.</div>;
  const add = data.files.reduce((n, f) => n + f.add, 0);
  const del = data.files.reduce((n, f) => n + f.del, 0);
  return (
    <>
      <div className="changes-summary">
        <span className="pill branch">⎇ {data.branch}</span>
        <span>
          {data.files.length} file{data.files.length === 1 ? '' : 's'} <span className="add">+{add}</span> <span className="del">−{del}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Refresh" onClick={load}>
          {loading ? <span className="spinner" /> : '↻'}
        </button>
        {data.files.length > 0 && (
          <button className="btn small ghost" onClick={() => setOpen(Object.fromEntries(data.files.map((f) => [f.path, !Object.values(open).some(Boolean)])))}>
            {Object.values(open).some(Boolean) ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      {onPrompt && (
        <div className="git-actions">
          <button className="btn small" disabled={busy || !data.files.length} onClick={() => onPrompt('Commit the current changes with a clear commit message. Stage only the files that belong to this work.')}>
            Commit
          </button>
          <button className="btn small" disabled={busy || !data.files.length} onClick={() => onPrompt('Commit the current changes with a clear commit message, then push the branch.')}>
            Commit and push
          </button>
          <button className="btn small primary" disabled={busy} onClick={() => onPrompt('Commit any uncommitted changes, push this branch, and open a pull request with a clear title and description. Use the gh CLI if it is available, and give me the PR link.')}>
            Create PR
          </button>
        </div>
      )}
      {data.files.length === 0 && <div className="panel-empty">No uncommitted changes.</div>}
      {data.files.map((f) => (
        <div key={f.path} className="change-file">
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
          {open[f.path] && <UnifiedDiff diff={f.diff} path={f.path} />}
        </div>
      ))}
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
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</span>
        <span>{lines.length} lines</span>
        <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(data.content)}>
          Copy
        </button>
      </div>
      <div className="file-view diff" style={{ borderRadius: 0, maxHeight: 'none' }}>
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

export default function SidePanel({ sessionId, tab, files, onTab, onCloseFile, onClose, refreshKey, onOpenFile, onPrompt, busy, onError, wide, onWide }) {
  return (
    <aside className={`side-panel ${wide ? 'wide' : ''}`}>
      <div className="panel-head">
        <div className="panel-tabs">
          <button className={`panel-tab ${tab === 'changes' ? 'on' : ''}`} onClick={() => onTab('changes')}>
            Changes
          </button>
          <button className={`panel-tab ${tab === 'browser' ? 'on' : ''}`} onClick={() => onTab('browser')}>
            Browser
          </button>
          {files.map((f) => (
            <button key={f} className={`panel-tab ${tab === f ? 'on' : ''}`} onClick={() => onTab(f)} title={f.replace(/^art:/, '')}>
              {f.startsWith('art:') ? '◇ ' : ''}
              {f.split(/[\\/]/).pop()}
              <span
                style={{ marginLeft: 6, opacity: 0.6 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(f);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button className="icon-btn hide-mobile" title={wide ? 'Narrower' : 'Wider'} onClick={onWide}>
          {wide ? '⇥' : '⇤'}
        </button>
        <button className="icon-btn" title="Close panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {tab === 'changes' ? (
          <Changes sessionId={sessionId} refreshKey={refreshKey} onOpenFile={onOpenFile} onPrompt={onPrompt} busy={busy} />
        ) : tab === 'browser' ? (
          <BrowserView sessionId={sessionId} onError={onError} />
        ) : tab.startsWith('art:') ? (
          <ArtifactView sessionId={sessionId} path={tab.slice(4)} refreshKey={refreshKey} />
        ) : (
          <FileView sessionId={sessionId} path={tab} refreshKey={refreshKey} />
        )}
      </div>
    </aside>
  );
}
