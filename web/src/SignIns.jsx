import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Toggle } from './ui/index.jsx';

const LABEL = {
  ok: 'Signed in',
  expired: 'Access expired, will refresh',
  'no-refresh': 'No refresh token',
  'no-expiry': 'No expiry given',
  'signed-out': 'Needs sign-in',
  ending: 'Login ends soon',
  'long-lived': 'Long-lived token',
};
const DOT = { ok: 'on', 'long-lived': 'on', expired: 'busy', 'no-expiry': 'off', 'no-refresh': 'busy', ending: 'busy', 'signed-out': 'err' };

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function detail(r, enabled) {
  if (r.kind === 'claude') {
    const bits = [r.note];
    if (r.hardLimitAt) bits.push(`Fixed end: ${when(r.hardLimitAt)}.`);
    return bits.filter(Boolean).join(' ');
  }
  const exp = r.expiresAt ? (r.expiresAt > Date.now() ? `Access token valid until ${when(r.expiresAt)}.` : `Access token expired ${when(r.expiresAt)}.`) : '';
  if (r.state === 'signed-out') return 'Sign in again under MCP servers.';
  if (r.state === 'no-refresh') return `${exp} The server gave no refresh token, so it will need a new sign-in when this runs out.`;
  if (r.state === 'no-expiry') return 'The server did not say when this expires, so it cannot be refreshed ahead of time. Claude refreshes it if the server rejects it.';
  if (!enabled) return `${exp} Auto-refresh is off.`;
  return `${exp}${r.nextAt ? ` Next refresh ${r.nextAt <= Date.now() ? 'now' : `around ${when(r.nextAt)}`}.` : ''}`;
}

export default function SignInsTab({ onError }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () =>
    api('/api/sign-ins')
      .then(setS)
      .catch((e) => (setS({ rows: [] }), onError?.(e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const post = async (action, body, key) => {
    setBusy(key);
    try {
      setS(await api(`/api/sign-ins/${action}`, { method: 'POST', body }));
    } catch (e) {
      onError?.(e);
    } finally {
      setBusy('');
    }
  };
  if (!s) return <div className="muted">Checking sign-ins…</div>;
  const rows = s.rows || [];
  return (
    <>
      <div className="set-row">
        <div className="set-label">
          Keep sign-ins refreshed
          <div className="desc">A few minutes before an MCP server's access token runs out, the server reconnects it in the background so Claude refreshes the login. Refresh tokens stay in use even when nobody is chatting.</div>
        </div>
        <div className="set-ctl fields sm">
          <Toggle value={s.enabled} disabled={busy === 'enable'} onChange={(v) => post('enable', { enabled: v }, 'enable')} />
        </div>
      </div>
      {s.note && <p className="muted set-note">{s.note}</p>}
      {rows.length === 0 && <div className="empty-box">No saved sign-ins yet. MCP servers you sign in to show up here.</div>}
      <div className="item-list">
        {rows.map((r) => (
          <div key={r.id} className="item card">
            <span className={`dot ${DOT[r.state] || 'off'}`} />
            <div className="item-main">
              <div className="item-title">
                {r.name} <span className="tag">{r.kind === 'claude' ? 'Claude login' : r.host || 'MCP'}</span> <span className="tag">{LABEL[r.state] || r.state}</span>
              </div>
              <div className="item-sub full">{detail(r, s.enabled)}</div>
              {r.last && (
                <div className="item-sub full" style={{ color: r.last.ok ? undefined : 'var(--red)' }}>
                  Last refresh {when(r.last.at)}: {r.last.message}
                </div>
              )}
            </div>
            {r.kind === 'mcp' && r.hasRefresh && (
              <Button size="sm" disabled={!!busy || r.busy} onClick={() => post('refresh', { id: r.id }, r.id)}>
                {busy === r.id || r.busy ? 'Refreshing…' : 'Refresh now'}
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="muted set-note">
        Some logins cannot be kept alive by refreshing: a company sign-in that forces a new login every day or week, a refresh token the server revokes, and the Claude Code login's own fixed end date. Those still need a fresh sign-in when they end.
      </p>
    </>
  );
}
