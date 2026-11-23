import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Checkbox, Input, Pill, Segmented } from './ui/index.jsx';

// How chats sign in, fetched once per page load: whether Claude runs through a company AI gateway
// (any source), and whether it uses a Claude OAuth token instead of the server's Claude login.
let mode;
let login;
let inflight;
const subs = new Set();
function loadMode() {
  inflight ||= api('/api/gateway')
    .then(setSignIn)
    .catch(() => (inflight = null));
  return inflight;
}
/** Takes a /api/gateway answer (or a /api/claude-token one, which has only the login part). */
export function setSignIn(s) {
  if ('baseUrl' in s) mode = s.mode || null;
  login = ('login' in s ? s.login : s.mode) || null;
  for (const fn of subs) fn();
}
function useSignIn(pick) {
  const [v, setV] = useState(() => pick() ?? null);
  useEffect(() => {
    const fn = () => setV(pick() ?? null);
    subs.add(fn);
    if (mode === undefined) loadMode();
    return () => subs.delete(fn);
  }, []);
  return v;
}

/** { source, baseUrl } when chats use a gateway key instead of a Claude login, else null. */
export function useGatewayMode() {
  return useSignIn(() => mode);
}

/** { source } when chats sign in with a Claude OAuth token (claude setup-token), else null. */
export function useOAuthTokenMode() {
  return useSignIn(() => login);
}

/** Settings > Account: the gateway address and personal key (the key is never shown again). */
export function GatewaySettings({ onError, onChange }) {
  const [s, setS] = useState(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);

  const take = (r) => {
    setS(r);
    setUrl(r.baseUrl || '');
    setSignIn(r);
    onChange?.(r);
  };
  useEffect(() => {
    api('/api/gateway').then(take).catch(onError);
  }, []);
  if (!s) return <div className="muted">Checking…</div>;

  const save = async (body, what) => {
    setBusy(what);
    try {
      take(await api('/api/gateway', { method: 'PUT', body }));
      setKey('');
      return true;
    } catch (e) {
      onError(e);
      return false;
    } finally {
      setBusy('');
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await api('/api/gateway/test', { method: 'POST', body: { baseUrl: url, token: key || undefined } }));
    } catch (e) {
      setTest({ ok: false, error: e.message });
    } finally {
      setBusy('');
    }
  };
  const post = async (path, what) => {
    setBusy(what);
    try {
      take(await api(path, { method: 'POST' }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };
  const takeOver = async () => {
    setBusy('import');
    try {
      take(await api('/api/gateway/import', { method: 'POST' }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };
  const dirty = url.trim().replace(/\/+$/, '') !== (s.baseUrl || '') || !!key.trim();
  const canEnable = !!(url.trim() && (key.trim() || s.hasToken));

  const mode = s.enabled ? 'always' : s.failover.enabled ? 'fallback' : 'off';
  const chooseMode = (m) => {
    const body = { enabled: m === 'always', failover: { enabled: m === 'fallback' } };
    save(m !== 'off' && dirty ? { ...body, baseUrl: url, token: key || undefined } : body, 'mode');
  };
  const until = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <p className="muted set-note">
        Send Claude's requests through your company's AI gateway with your personal key, always or only when your subscription runs out. It covers every chat, project, terminal, the Assistant and chat titles.
      </p>

      {s.external?.source === 'env' && (
        <div className="set-note">
          <Pill tone="green">In use</Pill>{' '}
          <span className="muted">
            A gateway is set up in this server's environment (.env): {s.external.baseUrl}. Chats use it until you pick an option below. From then on that choice alone decides.
          </span>
        </div>
      )}
      {s.settingsGateway && (
        <div className="set-note warn-box">
          {s.external?.source === 'settings' ? <b>Chats use the gateway from {s.settingsPath} ({s.external.baseUrl}).</b> : <b>{s.settingsPath} also has a gateway.</b>}{' '}
          {s.external?.source === 'settings' ? 'Move it here to control it from this page.' : 'Chats here ignore it and follow this page; Claude Code run directly on the host still uses it.'}{' '}
          <Button size="sm" variant={s.external ? 'primary' : undefined} disabled={!!busy} onClick={takeOver}>
            {busy === 'import' ? 'Moving…' : 'Move it here'}
          </Button>
          <div className="muted">Saves its address and key here, sets "Always", and removes those lines from settings.json (a copy is kept as settings.json.before-gateway). That file is shared with Claude Code on the host.</div>
        </div>
      )}
      {s.apiKeyHelper && !s.active && (
        <p className="set-note warn-box">
          <b>{s.settingsPath} sets apiKeyHelper</b>, so Claude Code takes its key from that helper instead of the Claude login. Remove it from that file to use your subscription.
        </p>
      )}

      <label className="set-field">
        <span>Gateway address</span>
        <Input mono value={url} placeholder="https://gateway.example.com/anthropic" onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="set-field">
        <span>Your key {s.hasToken && <span className="muted">(saved, ends {s.tokenHint}; paste a new one to replace it)</span>}</span>
        <Input mono type="password" value={key} placeholder={s.hasToken ? '••••••••••••' : 'Paste your gateway key'} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="new-password" />
      </label>
      <Checkbox className="set-check" checked={s.discovery} disabled={!!busy} onChange={(v) => save({ discovery: v }, 'discovery')}>
        List the gateway's models in the model picker
      </Checkbox>
      <div className="set-actions">
        <Button variant="primary" size="sm" disabled={!!busy || !dirty} onClick={() => save({ baseUrl: url, token: key || undefined }, 'save')}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" disabled={!!busy || !url.trim() || !(key.trim() || s.hasToken)} onClick={runTest}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        {s.hasToken && (
          <Button size="sm" disabled={!!busy} onClick={() => save({ enabled: false, failover: { enabled: false }, token: '' }, 'remove')}>
            Remove key
          </Button>
        )}
      </div>
      {test && (
        <p className="set-note" style={{ color: test.ok ? undefined : 'var(--red)' }}>
          {test.ok ? `Connected. The gateway offers ${test.models.length} model${test.models.length === 1 ? '' : 's'}${test.models.length ? `: ${test.models.slice(0, 6).join(', ')}${test.models.length > 6 ? '…' : ''}` : ''}.` : test.error}
        </p>
      )}

      <div className="set-row gw-mode">
        <div className="set-label">
          <div>Use the gateway</div>
          <div className="desc">
            {mode === 'always'
              ? 'Every chat uses the gateway.'
              : mode === 'fallback'
                ? 'Chats use your Claude subscription, and move to the gateway only while a limit ticked below is reached. They come back when it resets.'
                : 'Every chat uses your Claude subscription.'}{' '}
            Open chats switch with their next message.
          </div>
        </div>
        <div className={!canEnable && mode === 'off' ? 'disabled' : undefined} title={!canEnable && mode === 'off' ? 'Enter the address and key first' : undefined}>
          <Segmented
            options={[
              ['off', 'Off'],
              ['always', 'Always'],
              ['fallback', 'As fallback'],
            ]}
            value={mode}
            onChange={(m) => (m === 'off' || canEnable ? chooseMode(m) : null)}
          />
        </div>
      </div>
      {mode === 'fallback' && (
        <div className="set-checks">
          <span className="muted">Switch when the subscription reaches</span>
          <Checkbox checked={s.failover.weekly} disabled={!!busy} onChange={(v) => save({ failover: { weekly: v } }, 'failover')}>
            the weekly limit
          </Checkbox>
          <Checkbox checked={s.failover.fiveHour} disabled={!!busy} onChange={(v) => save({ failover: { fiveHour: v } }, 'failover')}>
            the 5-hour limit
          </Checkbox>
        </div>
      )}
      {s.failoverUntil > 0 && (
        <div className="set-note warn-box">
          <b>The gateway is standing in now.</b> The subscription reached its {s.failoverKind === 'five_hour' ? '5-hour' : 'weekly'} limit, so every chat uses the gateway until it resets on {until(s.failoverUntil)}.{' '}
          <Button size="sm" disabled={!!busy} onClick={() => post('/api/gateway/end-failover', 'end')}>
            {busy === 'end' ? 'Switching…' : 'Back to subscription now'}
          </Button>
        </div>
      )}
      <p className="muted set-note">The key is kept in this server's data folder (gateway.json, readable only by its owner) and is never shown again. Claude's own tools in a chat can still see it in their environment, like any Claude Code key.</p>
    </>
  );
}
