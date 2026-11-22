import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Checkbox, Input, Pill, Toggle } from './ui/index.jsx';

// Whether Claude runs through a company AI gateway (any source), fetched once per page load.
let mode;
let inflight;
const subs = new Set();
function loadMode() {
  inflight ||= api('/api/gateway')
    .then((s) => setMode(s.mode || null))
    .catch(() => (inflight = null));
  return inflight;
}
function setMode(m) {
  mode = m;
  for (const fn of subs) fn(m);
}

/** { source, baseUrl } when chats use a gateway key instead of a Claude login, else null. */
export function useGatewayMode() {
  const [m, setM] = useState(mode ?? null);
  useEffect(() => {
    subs.add(setM);
    if (mode === undefined) loadMode();
    return () => subs.delete(setM);
  }, []);
  return m;
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
    setUrl(r.baseUrl || r.defaultUrl || '');
    setMode(r.mode || null);
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
  const fix = async () => {
    setBusy('fix');
    try {
      const r = await api('/api/gateway/fix-settings', { method: 'POST' });
      take(r.status);
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };

  const dirty = url.trim().replace(/\/+$/, '') !== (s.baseUrl || '') || !!key.trim();
  const canEnable = !!(url.trim() && (key.trim() || s.hasToken));

  return (
    <>
      <p className="muted set-note">
        Use your company's AI gateway (for example Bifrost) instead of a Claude login. Every chat, project, terminal, the Assistant and chat titles then send requests to the gateway with your personal key, and are billed to your team. On a machine with no browser, get the key on your laptop with <code>bifrost-auth-macos get-key</code> (or <code>bifrost-auth-linux get-key</code>) and paste it here.
      </p>

      {s.external && (
        <div className="set-note">
          <Pill tone="green">In use</Pill>{' '}
          <span className="muted">
            A gateway is already set up in {s.external.source === 'env' ? "this server's environment (.env)" : s.settingsPath}: {s.external.baseUrl}. You don't need to set it here.
          </span>
        </div>
      )}

      <div className="set-row">
        <div className="set-label">
          <div>Use the AI gateway</div>
          <div className="desc">{s.active ? 'On: new chats and helpers use the gateway. Running chats switch when they restart.' : 'Off: Claude Code uses its own login.'}</div>
        </div>
        <Toggle
          value={s.enabled}
          label="Use the AI gateway"
          disabled={!!busy || (!s.enabled && !canEnable)}
          onChange={(v) => save(v && dirty ? { enabled: true, baseUrl: url, token: key || undefined } : { enabled: v }, 'enable')}
        />
      </div>

      <label className="set-field">
        <span>Gateway address</span>
        <Input mono value={url} placeholder={s.defaultUrl} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="set-field">
        <span>Your key {s.hasToken && <span className="muted">(saved, ends {s.tokenHint}; paste a new one to replace it)</span>}</span>
        <Input mono type="password" value={key} placeholder={s.hasToken ? '••••••••••••' : 'Paste the key from get-key'} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="new-password" />
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
          <Button size="sm" disabled={!!busy} onClick={() => save({ enabled: false, token: '' }, 'remove')}>
            Remove key
          </Button>
        )}
      </div>
      {test && (
        <p className="set-note" style={{ color: test.ok ? undefined : 'var(--red)' }}>
          {test.ok ? `Connected. The gateway offers ${test.models.length} model${test.models.length === 1 ? '' : 's'}${test.models.length ? `: ${test.models.slice(0, 6).join(', ')}${test.models.length > 6 ? '…' : ''}` : ''}.` : test.error}
        </p>
      )}

      {s.settingsConflicts.length > 0 && (s.active || s.enabled) && (
        <div className="set-note warn-box">
          <b>{s.settingsPath} overrides the gateway.</b> It sets {s.settingsConflicts.join(', ')}, which Claude Code applies on top of what this server passes, so requests skip the gateway (for example straight to Bedrock).{' '}
          <Button size="sm" disabled={!!busy} onClick={fix}>
            {busy === 'fix' ? 'Removing…' : 'Remove them'}
          </Button>
          <div className="muted">A copy of the old file is kept as settings.json.before-gateway. This file is shared with Claude Code on the host.</div>
        </div>
      )}
      {s.active && s.envConflicts.length > 0 && (
        <p className="muted set-note">Not passed to Claude while the gateway is on: {s.envConflicts.join(', ')} (from this server's environment).</p>
      )}
      <p className="muted set-note">The key is kept in this server's data folder (gateway.json, readable only by its owner) and is never shown again. Claude's own tools in a chat can still see it in their environment, like any Claude Code key.</p>
    </>
  );
}
