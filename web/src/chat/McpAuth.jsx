import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button } from '../ui/index.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';

// MCP sign-in (OAuth). Claude's flow redirects to http://localhost:<port>/callback on the machine
// running Claude. Sign-in pages open in the sign-in window (the server's own browser, on that
// machine), so the redirect lands by itself. Only when the server has no browser (WITH_BROWSER=0)
// does the page open on this device, and then the failed localhost address is pasted back.

let browserOn = false;
export function setBrowserAvailable(v) {
  browserOn = v;
}
export const showSigninWindow = (detail) => window.dispatchEvent(new CustomEvent('cw-show-signin', { detail }));

export const LOCAL_CALLBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/\S*[?&](code|error)=\S*$/i;

export const needsSignIn = (s) => s && (s.status === 'needs-auth' || (s.status === 'failed' && /auth|401|unauthori[sz]ed|oauth/i.test(s.error || '')));

/** Start a sign-in. Must be called from a click, so a device tab (no server browser) isn't blocked. */
export async function startSignIn(sessionId, name, onError) {
  return openSignIn(() => api(`/api/sessions/${sessionId}/mcp/auth`, { method: 'POST', body: { name } }), onError);
}

export async function openSignIn(begin, onError) {
  // With a server browser, the server opens the page in the sign-in window, which pops up here.
  const w = browserOn ? null : window.open('', '_blank');
  try {
    if (w) w.document.write('<p style="font:15px system-ui;padding:24px">Starting sign-in…</p>');
  } catch {}
  try {
    const r = await begin();
    if (r?.inBrowser) showSigninWindow({ server: r.server });
    if (r?.done || !r?.authUrl || r.inBrowser) {
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

/** Bar above the composer while a sign-in waits. */
export function McpSignInBar({ sessionId, flows, onError, onDone }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState({});
  const shown = (flows || []).filter((f) => !hidden[f.name + f.at]);
  if (!shown.length) return null;
  const names = shown.map((f) => f.name).join(', ');
  const hide = () => setHidden((h) => ({ ...h, ...Object.fromEntries(shown.map((f) => [f.name + f.at, true])) }));
  if (browserOn)
    return (
      <div className="inbox-bar mcp-auth-bar">
        <div className="mcp-auth-text">
          <span className="dot-pulse" /> Signing in to <b>{names}</b> in the sign-in window.{' '}
          <button type="button" className="linklike" onClick={() => showSigninWindow({ server: names })}>
            Show it
          </button>
          {' · '}
          <button type="button" className="linklike" onClick={hide}>
            Hide
          </button>
        </div>
      </div>
    );
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
      <div className="mcp-auth-row fields sm">
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
        <Button variant="primary" disabled={busy || !url.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
      <div className="mcp-auth-links">
        {shown.map((f) => (
          <a key={f.name} href={f.authUrl} target="_blank" rel="noreferrer">
            Open {f.name} sign-in again
          </a>
        ))}
        <button type="button" className="linklike" onClick={hide}>
          Hide
        </button>
      </div>
    </form>
  );
}

/** No server browser: a localhost sign-in started elsewhere (a terminal's /mcp, a server's own login). */
export function PasteCallback({ onError }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (browserOn) return null;
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
    <details className="paste-callback">
      <summary className="muted">A sign-in ended on a localhost page that can’t load?</summary>
      <form onSubmit={submit}>
        <p className="muted set-note">This server has no built-in browser, so sign-in pages open on your device. Paste the address of the page that failed to load.</p>
        <div className="mcp-auth-row fields sm">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:…/callback?code=…" autoComplete="off" spellCheck={false} />
          <Button variant="primary" disabled={busy || !url.trim()}>
            {busy ? 'Delivering…' : 'Deliver'}
          </Button>
        </div>
        {msg && <p className="muted set-note">{msg}</p>}
      </form>
    </details>
  );
}

// ---------- MCP elicitation: a form (or a link) an MCP server asks the user for ----------
const SECRET = /pass(word|code|phrase)?|secret|token|api[_-]?key|\bpin\b|otp|credential/i;

function fieldsOf(schema, order) {
  const props = schema?.properties || {};
  const keys = order?.length ? order.filter((k) => props[k]) : Object.keys(props);
  const req = new Set(schema?.required || []);
  return keys.map((k) => ({ key: k, ...props[k], required: req.has(k) }));
}

function Field({ f, value, onChange }) {
  const label = f.title || f.key;
  const options = f.enum ? f.enum.map((v, i) => ({ value: v, label: f.enumNames?.[i] ?? v })) : f.oneOf ? f.oneOf.map((o) => ({ value: o.const, label: o.title ?? o.const })) : null;
  if (f.type === 'boolean')
    return (
      <label className="elicit-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  let input;
  if (options)
    input = (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required}>
        <option value="" disabled>
          Choose…
        </option>
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  else {
    const num = f.type === 'number' || f.type === 'integer';
    const type = num ? 'number' : SECRET.test(`${f.key} ${f.title || ''}`) ? 'password' : f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : 'text';
    input = (
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(num ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        required={f.required}
        minLength={f.minLength}
        maxLength={f.maxLength}
        min={f.minimum}
        max={f.maximum}
        step={f.type === 'integer' ? 1 : 'any'}
        autoComplete={type === 'password' ? 'current-password' : /user|login|email/i.test(f.key) ? 'username' : 'off'}
        spellCheck={false}
      />
    );
  }
  return (
    <label className="elicit-field">
      <span>
        {label}
        {f.required && <span className="req"> *</span>}
      </span>
      {input}
      {f.description && <small className="muted">{f.description}</small>}
    </label>
  );
}

/** Answer with onAnswer({ reqId, action: 'accept'|'decline'|'cancel', content }). */
export function Elicitation({ req, done, onAnswer }) {
  const fields = fieldsOf(req.schema, req.order);
  const [vals, setVals] = useState(() => Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])));
  const [opened, setOpened] = useState(false);
  const answer = (action, content) => onAnswer({ reqId: req.reqId, action, content });
  if (done)
    return (
      <div className="elicit done card">
        <span className="muted">
          {req.server}: {done === 'accept' ? 'sent' : done === 'decline' ? 'declined' : 'cancelled'}
        </span>
      </div>
    );
  const submit = (e) => {
    e.preventDefault();
    const content = {};
    for (const f of fields) if (vals[f.key] !== undefined && vals[f.key] !== '') content[f.key] = vals[f.key];
    answer('accept', content);
  };
  return (
    <form className="elicit card fields" onSubmit={submit} autoComplete="on">
      <div className="elicit-head">
        <b>{req.title || req.server}</b> <span className="muted">asks</span>
      </div>
      {req.message && <div className="elicit-msg">{req.message}</div>}
      {req.mode === 'url' ? (
        <div className="elicit-url">
          {browserOn ? (
            <Button
              type="button"
              variant="primary" size="sm"
              onClick={() => (setOpened(true), api('/api/signin-page', { method: 'POST', body: { url: req.url, server: req.server } }).catch(() => {}))}
            >
              Open in the sign-in window
            </Button>
          ) : (
            <Button as="a" variant="primary" size="sm" href={req.url} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
              Open {(() => {
                try {
                  return new URL(req.url).host;
                } catch {
                  return 'link';
                }
              })()}
            </Button>
          )}
          {opened && <span className="muted">Finish there, then press Done.</span>}
        </div>
      ) : (
        fields.map((f) => <Field key={f.key} f={f} value={vals[f.key]} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} />)
      )}
      <div className="elicit-actions">
        {req.mode === 'url' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => answer('accept')}>
            Done
          </Button>
        ) : (
          <Button variant="primary" size="sm">Submit</Button>
        )}
        <Button type="button" size="sm" onClick={() => answer('decline')}>
          Decline
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => answer('cancel')}>
          Cancel
        </Button>
      </div>
      {req.mode !== 'url' && fields.some((f) => SECRET.test(`${f.key} ${f.title || ''}`)) && <small className="muted">Goes straight to {req.server}. Not saved in this chat.</small>}
    </form>
  );
}

// ---------- Settings → MCP logins ----------
const canSignOut = (s) => /^(http|sse|ws|claudeai-proxy)/.test(s.transport || '') && s.status === 'connected';

export function McpLogins({ cwd, onError, onChange }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState('');
  const load = () =>
    api(`/api/mcp-logins${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
      .then(setData)
      .catch((e) => (setData({ servers: [], oauth: [], elicits: [] }), onError(e)));
  useEffect(() => {
    setData(null);
    load();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep it fresh while servers start, a sign-in waits, or a server asks for input.
  const live = data && (data.servers.some((s) => s.status === 'pending') || data.oauth.length || data.elicits.length);
  // Keep the server list above in step when a login changes a server's status.
  const statusKey = (data?.servers || []).map((s) => s.name + s.status).join();
  useEffect(() => {
    if (statusKey) onChange?.();
  }, [statusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (action, body) => {
    setBusy(body.name || action);
    try {
      setData(await api(`/api/mcp-logins/${action}`, { method: 'POST', body: { cwd, ...body } }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };
  const signIn = (name) =>
    openSignIn(async () => {
      const r = await api('/api/mcp-logins/signin', { method: 'POST', body: { cwd, name } });
      setData(r);
      return r;
    }, onError);
  const deliver = async (e) => {
    e.preventDefault();
    try {
      await deliverCallback(paste);
      setPaste('');
      setTimeout(load, 1500);
    } catch (err) {
      onError(err);
    }
  };
  const servers = (data?.servers || []).filter((s) => !['sessions', 'schedule', 'browser'].includes(s.name) || s.scope !== 'dynamic');
  return (
    <div className="mcp-logins">
      <div className="label">Logins</div>
      <p className="muted set-note">Sign in to servers that use a browser login, sign out, or retry. A sign-in here applies to every chat.</p>
      {!data && <div className="muted">Starting Claude to check servers…</div>}
      {data && servers.length === 0 && <div className="empty-box">No MCP servers.</div>}
      {data?.elicits.map((r) => (
        <Elicitation key={r.reqId} req={r} onAnswer={(a) => act('elicit', a)} />
      ))}
      <div className="item-list">
        {servers.map((s) => {
          const flow = data.oauth.find((f) => f.name === s.name);
          return (
            <div key={s.name} className="item card">
              <span className={`dot ${s.status === 'connected' ? 'on' : s.status === 'pending' || flow ? 'busy' : s.status === 'disabled' ? 'off' : 'err'}`} />
              <div className="item-main">
                <div className="item-title">
                  {s.name} {s.scope && <span className="tag">{s.scope}</span>}
                </div>
                <div className={`item-sub ${s.status === 'failed' ? 'err' : ''}`}>{flow ? (browserOn ? 'Signing in, in the sign-in window' : 'Approve in the tab that opened, then paste the localhost address below') : s.status === 'needs-auth' ? 'Needs sign-in' : s.status}{s.error && !flow ? ` · ${s.error}` : ''}</div>
              </div>
              <div className="login-actions">
                {flow ? (
                  <>
                    {browserOn ? (
                      <Button size="sm" onClick={() => showSigninWindow({ server: s.name })}>
                        Show sign-in
                      </Button>
                    ) : (
                      <Button as="a" size="sm" href={flow.authUrl} target="_blank" rel="noreferrer">
                        Open again
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => act('cancel', { name: s.name })}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    {needsSignIn(s) && (
                      <Button variant="primary" size="sm" disabled={busy === s.name} onClick={() => signIn(s.name)}>
                        Sign in
                      </Button>
                    )}
                    {canSignOut(s) && (
                      <Button size="sm" disabled={busy === s.name} onClick={async () => (await confirmDialog(`Sign out of ${s.name}? Chats lose access until you sign in again.`, { ok: 'Sign out', danger: true })) && act('signout', { name: s.name })}>
                        Sign out
                      </Button>
                    )}
                    {s.status === 'failed' && !needsSignIn(s) && (
                      <Button size="sm" disabled={busy === s.name} onClick={() => act('reconnect', { name: s.name })}>
                        Retry
                      </Button>
                    )}
                  </>
                )}
              </div>
              {flow && !browserOn && (
                <form className="mcp-auth-row login-paste fields sm" onSubmit={deliver}>
                  <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the http://localhost:…/callback?code=… address" autoComplete="off" spellCheck={false} />
                  <Button variant="primary" size="sm" disabled={!paste.trim()}>
                    Connect
                  </Button>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
