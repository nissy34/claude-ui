import { useState } from 'react';
import { api } from '../api.js';

// MCP sign-in (OAuth) from any device. Claude's flow redirects to http://localhost:<port>/callback
// on the machine running Claude. From a phone or another computer that page fails to load, so the
// user pastes its address here and the server hands it to the waiting sign-in.

export const LOCAL_CALLBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/\S*[?&](code|error)=\S*$/i;

export const needsSignIn = (s) => s && (s.status === 'needs-auth' || (s.status === 'failed' && /auth|401|unauthori[sz]ed|oauth/i.test(s.error || '')));

/** Start a sign-in. Must be called from a click, so the new tab isn't blocked. */
export async function startSignIn(sessionId, name, onError) {
  const w = window.open('', '_blank');
  try {
    if (w) w.document.write('<p style="font:15px system-ui;padding:24px">Starting sign-in…</p>');
  } catch {}
  try {
    const r = await api(`/api/sessions/${sessionId}/mcp/auth`, { method: 'POST', body: { name } });
    if (r.done) {
      w?.close();
      return r;
    }
    if (w && !w.closed) w.location.href = r.authUrl;
    else window.open(r.authUrl, '_blank');
    return r;
  } catch (e) {
    w?.close();
    onError?.(e);
    return null;
  }
}

export async function deliverCallback(url, sessionId) {
  return api('/api/oauth/callback', { method: 'POST', body: { url: url.trim(), sessionId } });
}

/** Bar above the composer while a sign-in waits for its callback. */
export function McpSignInBar({ sessionId, flows, onError, onDone }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState({});
  const shown = (flows || []).filter((f) => !hidden[f.name + f.at]);
  if (!shown.length) return null;
  const names = shown.map((f) => f.name).join(', ');
  const submit = async (e) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await deliverCallback(url, sessionId);
      setUrl('');
      onDone?.(r);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inbox-bar mcp-auth-bar" onSubmit={submit}>
      <div className="mcp-auth-text">
        <span className="dot-pulse" /> Signing in to <b>{names}</b>. Approve access in the tab that opened. If it ends on a page that can’t load (<code>localhost</code>), copy that page’s address and paste it here.
      </div>
      <div className="mcp-auth-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (LOCAL_CALLBACK.test(t.trim())) setTimeout(() => setUrl(t.trim()), 0);
          }}
          placeholder="http://localhost:…/callback?code=…"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn primary" disabled={busy || !url.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      <div className="mcp-auth-links">
        {shown.map((f) => (
          <span key={f.name}>
            <a href={f.authUrl} target="_blank" rel="noreferrer">
              Open {f.name} sign-in again
            </a>
            {' · '}
            <button type="button" className="linklike" onClick={() => setHidden((h) => ({ ...h, [f.name + f.at]: true }))}>
              Hide
            </button>
          </span>
        ))}
      </div>
    </form>
  );
}

/** A localhost sign-in started anywhere else (a terminal's /mcp, an MCP server's own login). */
export function PasteCallback({ onError }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const r = await deliverCallback(url);
      setUrl('');
      setMsg(r.server ? `Signed in to ${r.server}.` : r.ok ? `Delivered. The app answered: ${r.body || `HTTP ${r.status}`}` : `Delivered, but the app answered HTTP ${r.status}: ${r.body}`);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="paste-callback" onSubmit={submit}>
      <div className="label">Finish a sign-in from another device</div>
      <p className="muted set-note">
        A server whose sign-in sends you to <code>http://localhost:…</code> can’t reach this machine from your phone or another computer. Approve access, then paste the address of the page that failed to load. Works for chats, a terminal’s <code>/mcp</code>, and servers with their own login.
      </p>
      <div className="mcp-auth-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:…/callback?code=…" autoComplete="off" spellCheck={false} />
        <button className="btn primary" disabled={busy || !url.trim()}>
          {busy ? 'Delivering…' : 'Deliver'}
        </button>
      </div>
      {msg && <p className="muted set-note">{msg}</p>}
    </form>
  );
}
