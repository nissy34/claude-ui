import React, { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from './api.js';
import { artifactKind } from './chat/ArtifactView.jsx';
import { IconButton, Modal, Segmented } from './ui/index.jsx';

const LABEL = { html: 'Web page', image: 'Image', markdown: 'Document', pdf: 'PDF', csv: 'Table' };
const ICON = { html: '◰', image: '▣', markdown: '¶', pdf: '▤', csv: '▦' };

// Every page, dashboard, image and document Claude has written or published: across all chats
// (the Artifacts page), or one chat's (its ⋯ menu, with sessionId), switchable either way.
// Each tile names the chat that made it; the chat name opens that chat.
export default function ArtifactsGallery({ onClose, onOpen, onOpenChat, onError, sessionId = null, sessionName = '' }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [scope, setScope] = useState(sessionId ? 'chat' : 'all');
  useEffect(() => {
    api('/api/artifacts')
      .then((r) => setList(r.artifacts))
      .catch((e) => (setList([]), onError(e)));
  }, [onError]);
  const inScope = useMemo(() => (list || []).filter((a) => scope === 'all' || a.sessionId === sessionId), [list, scope, sessionId]);
  const shown = useMemo(
    () => inScope.filter((a) => (!kind || artifactKind(a.path) === kind) && (!q || `${a.title || ''} ${a.name} ${a.sessionName} ${a.path}`.toLowerCase().includes(q.toLowerCase()))),
    [inScope, q, kind]
  );
  const chatCount = (list || []).filter((a) => a.sessionId === sessionId).length;
  return (
    <Modal onClose={onClose} size="wide">
      <div className="modal-head art-head">
        <span className="mtitle">Artifacts</span>
        {sessionId && (
          <Segmented
            className="art-scope"
            value={scope}
            onChange={setScope}
            options={[
              ['chat', `This chat${list ? ` (${chatCount})` : ''}`],
              ['all', 'All chats'],
            ]}
          />
        )}
        <input className="field sm search-in" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select className="field sm proj-pick hide-mobile" style={{ flex: 'none' }} value={kind} onChange={(e) => setKind(e.target.value)}>
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
        {list && shown.length === 0 && (
          <div className="empty-box">
            {inScope.length
              ? 'No matches.'
              : scope === 'chat'
                ? `Nothing in ${sessionName ? `"${sessionName}"` : 'this chat'} yet. Pages, documents and images Claude writes or publishes here show up in this list.`
                : 'Nothing yet. When Claude writes or publishes a web page, dashboard, image, Markdown document, PDF or CSV, it shows up here.'}
          </div>
        )}
        <div className="art-grid">
          {shown.map((a) => {
            const k = artifactKind(a.path);
            const open = () => onOpen(a);
            return (
              <div
                key={a.sessionId + a.path}
                role="button"
                tabIndex={0}
                className="art-tile card interactive"
                onClick={open}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
                title={a.path}
              >
                <div className="art-thumb">
                  {k === 'image' ? <img src={a.url} alt="" loading="lazy" /> : k === 'html' ? <iframe src={a.url} title={a.name} sandbox="" loading="lazy" tabIndex={-1} /> : <span>{ICON[k]}</span>}
                </div>
                <div className="art-tile-meta">
                  <b>{a.title || a.name}</b>
                  <span className="muted">
                    {LABEL[k]} · {timeAgo(a.mtime)}
                  </span>
                  {onOpenChat && (scope === 'all' || a.sessionId !== sessionId) ? (
                    <button
                      className="art-chat link-btn"
                      title={`Open the chat "${a.sessionName}"`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenChat(a);
                      }}
                    >
                      ◌ {a.sessionName || 'Untitled chat'}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
