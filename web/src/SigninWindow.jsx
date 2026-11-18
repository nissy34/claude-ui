import React, { useEffect } from 'react';
import { api } from './api.js';
import BrowserView from './chat/BrowserView.jsx';

// The sign-in window: tabs of the server's sign-in browser, where MCP servers and CLIs open their
// sign-in pages (through the URL opener) and Sign in buttons open provider pages. It runs on the
// machine running Claude, so a redirect to http://127.0.0.1:<port> reaches the waiting process.
// A tab closes itself once it reaches that callback.
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u || 'page';
  }
};

export default function SigninWindow({ pages, active, infos, onPick, onClose, onError }) {
  const cur = pages.find((p) => p.id === active) || pages[0];
  const info = cur ? infos[cur.id] : null;
  useEffect(() => {
    if (pages.length) return;
    const t = setTimeout(onClose, 2500);
    return () => clearTimeout(t);
  }, [pages.length, onClose]);
  return (
    <div className="modal signin-modal" onClick={onClose}>
      <div className="modal-card signin-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mtitle">Sign in{info?.server ? ` to ${info.server}` : ''}</span>
          {info?.from && <span className="muted signin-from">from {info.from.name}</span>}
          <span className="spacer" />
          <button className="icon-btn" title="Hide (pages stay open)" onClick={onClose}>
            ✕
          </button>
        </div>
        {pages.length > 1 && (
          <div className="signin-tabs">
            {pages.map((p) => (
              <button key={p.id} className={`signin-tab ${p.id === cur?.id ? 'on' : ''}`} onClick={() => onPick(p.id)}>
                {p.done ? '✓ ' : ''}
                {infos[p.id]?.server || hostOf(infos[p.id]?.url || p.url)}
              </button>
            ))}
          </div>
        )}
        <div className="signin-body">
          {cur ? (
            <BrowserView key={cur.id} sessionId={cur.id} onError={onError} />
          ) : (
            <div className="empty-box signin-empty">All sign-ins finished.</div>
          )}
        </div>
        <div className="signin-foot">
          <span className="muted">{cur?.done ? 'Signed in. This page closes by itself.' : 'Runs in the browser on the server. Your sign-in is kept there, so next time it may finish by itself.'}</span>
          {cur && !cur.done && (
            <button className="btn small ghost" onClick={() => api(`/api/signin-pages/${cur.id}/close`, { method: 'POST' }).catch(onError)}>
              Close this page
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
