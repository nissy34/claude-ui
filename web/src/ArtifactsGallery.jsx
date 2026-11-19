import React, { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';
import { artifactKind } from './chat/ArtifactView.jsx';
import { IconButton, Modal } from './ui/index.jsx';

const LABEL = { html: 'Web page', image: 'Image', markdown: 'Document', pdf: 'PDF', csv: 'Table' };
const ICON = { html: '◰', image: '▣', markdown: '¶', pdf: '▤', csv: '▦' };

// Every page, dashboard, image and document Claude has written, across all chats.
export default function ArtifactsGallery({ onClose, onOpen, onError }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  useEffect(() => {
    api('/api/artifacts')
      .then((r) => setList(r.artifacts))
      .catch((e) => (setList([]), onError(e)));
  }, [onError]);
  const shown = useMemo(
    () => (list || []).filter((a) => (!kind || artifactKind(a.path) === kind) && (!q || `${a.name} ${a.sessionName} ${a.path}`.toLowerCase().includes(q.toLowerCase()))),
    [list, q, kind]
  );
  return (
    <Modal onClose={onClose} size="wide">
      <div className="modal-head">
        <span className="mtitle">Artifacts</span>
        <input className="search-in" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select className="proj-pick" style={{ flex: 'none' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}s
            </option>
          ))}
        </select>
        <IconButton onClick={onClose} aria-label="Close">
          ✕
        </IconButton>
      </div>
      <div className="modal-body">
        {!list && <div className="muted">Loading…</div>}
        {list && shown.length === 0 && <div className="empty-box">{list.length ? 'No matches.' : 'Nothing yet. When Claude writes a web page, dashboard, image, Markdown document, PDF or CSV, it shows up here.'}</div>}
        <div className="art-grid">
          {shown.map((a) => {
            const k = artifactKind(a.path);
            return (
              <button key={a.sessionId + a.path} className="art-tile" onClick={() => onOpen(a)} title={a.path}>
                <div className="art-thumb">
                  {k === 'image' ? <img src={a.url} alt="" loading="lazy" /> : k === 'html' ? <iframe src={a.url} title={a.name} sandbox="" loading="lazy" tabIndex={-1} /> : <span>{ICON[k]}</span>}
                </div>
                <div className="art-tile-meta">
                  <b>{a.name}</b>
                  <span className="muted">
                    {LABEL[k]} · {a.sessionName} · {timeAgo(a.mtime)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
