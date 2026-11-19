import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { renderMarkdown } from './markdown.js';
import { Button, IconButton } from '../ui/index.jsx';

const Markdown = ({ text }) => <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function artifactKind(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'csv') return 'csv';
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else if (c !== '\r') cell += c;
    if (rows.length > 2000) break;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

// Shows an HTML page or dashboard, image, SVG, Markdown, PDF or CSV file Claude made.
export default function ArtifactView({ sessionId, path, refreshKey }) {
  const [url, setUrl] = useState(null);
  const [text, setText] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const boxRef = useRef(null);
  const kind = artifactKind(path);
  const name = path.split(/[\\/]/).pop();

  useEffect(() => {
    api(`/api/artifact-url?session=${sessionId}&path=${encodeURIComponent(path)}`)
      .then((r) => setUrl(r.url))
      .catch((e) => setError(e.message));
  }, [sessionId, path]);

  const stamp = `${refreshKey}-${reload}`;
  useEffect(() => {
    if (!url || (kind !== 'markdown' && kind !== 'csv')) return;
    fetch(`${url}?t=${stamp}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Can't open this file (${r.status})`))))
      .then(setText)
      .catch((e) => setError(e.message));
  }, [url, kind, stamp]);

  const src = url ? `${url}?t=${stamp}` : '';
  const scale = fit && kind === 'image' ? null : zoom;
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen?.());

  let body;
  if (error) body = <div className="panel-empty">{error}</div>;
  else if (!url) body = <div className="panel-empty">Loading…</div>;
  else if (kind === 'html')
    body = (
      <div className="art-frame-wrap">
        <iframe
          key={stamp}
          title={name}
          src={src}
          className="art-frame"
          sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads"
          style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})` }}
        />
      </div>
    );
  else if (kind === 'image')
    body = (
      <div className={`art-image ${fit ? 'fit' : ''}`}>
        <img src={src} alt={name} style={scale ? { width: `${scale * 100}%`, maxWidth: 'none' } : undefined} />
      </div>
    );
  else if (kind === 'pdf') body = <iframe key={stamp} title={name} src={src} className="art-frame" />;
  else if (kind === 'markdown')
    body = (
      <div className="art-doc" style={{ fontSize: `${zoom * 100}%` }}>
        {text == null ? 'Loading…' : <Markdown text={text} />}
      </div>
    );
  else if (kind === 'csv') {
    const rows = text ? parseCsv(text) : [];
    body = (
      <div className="art-doc" style={{ fontSize: `${zoom * 13}px` }}>
        <table className="art-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else body = <div className="panel-empty">No preview for this file type.</div>;

  return (
    <div className="art" ref={boxRef}>
      <div className="art-bar">
        <span className="art-name" title={path}>
          {name} <span className="muted">· {(path.split('.').pop() || '').toUpperCase()}</span>
        </span>
        {kind === 'image' && (
          <Button variant="ghost" size="sm" className={`${fit ? 'on' : ''}`} onClick={() => setFit(!fit)} title="Fit to panel">
            Fit
          </Button>
        )}
        <select className="art-zoom" value={zoom} onChange={(e) => (setZoom(Number(e.target.value)), setFit(false))} title="Zoom">
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <IconButton title="Reload" onClick={() => setReload((r) => r + 1)}>
          ↻
        </IconButton>
        {url && (
          <IconButton as="a"  title="Download" href={`${url}?download=1`} download={name}>
            ⤓
          </IconButton>
        )}
        {url && (
          <IconButton as="a"  title="Open in a new tab" href={url} target="_blank" rel="noreferrer">
            ↗
          </IconButton>
        )}
        <IconButton title="Full screen" onClick={fullscreen}>
          ⛶
        </IconButton>
      </div>
      {body}
    </div>
  );
}
