import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { setSignIn } from './Gateway.jsx';
import { Button, Input, Pill, Segmented } from './ui/index.jsx';

/**
 * Settings > Account: sign chats in with a Claude OAuth token (from `claude setup-token`) instead
 * of the server's interactive Claude login. The token is write-only: never shown again.
 */
export function ClaudeTokenSettings({ onError, onChange, gateway }) {
  const [s, setS] = useState(null);
  const [tok, setTok] = useState('');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);

  const take = (r) => {
    setS(r);
    setSignIn(r);
    onChange?.(r);
  };
  useEffect(() => {
    api('/api/claude-token').then(take).catch(onError);
  }, []);
  // A gateway change can put the gateway in front of the token (or take it away): ask again.
  useEffect(() => {
    if (s) api('/api/claude-token').then(take).catch(() => {});
  }, [gateway?.active, gateway?.failoverUntil]);
  if (!s) return <div className="muted">Checking…</div>;

  const save = async (body, what) => {
    setBusy(what);
    try {
      take(await api('/api/claude-token', { method: 'PUT', body }));
      setTok('');
      setTest(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await api('/api/claude-token/test', { method: 'POST', body: { token: tok.trim() || undefined } }));
    } catch (e) {
      setTest({ ok: false, error: e.message });
    } finally {
      setBusy('');
    }
  };

  const choice = s.use === 'token' ? 'token' : 'login';
  const canToken = !!(tok.trim() || s.hasToken);
  const choose = (v) => {
    if (v === choice && s.use) return;
    if (v === 'token') save(tok.trim() ? { use: 'token', token: tok } : { use: 'token' }, 'use');
    else save({ use: 'login' }, 'use');
  };
  const external = !s.use && (s.settingsToken || s.envToken);

  return (
    <>
      <p className="muted set-note">
        Chats can use the Claude login on the server, or a long-lived OAuth token made with <code>claude setup-token</code> on any computer where you are signed in to Claude. The token uses the same subscription, needs no browser on the server and lasts a year.
      </p>

      {external && (
        <div className="set-note">
          <Pill tone="green">In use</Pill>{' '}
          <span className="muted">
            A token is set in {s.settingsToken ? s.settingsPath : "this server's environment (.env)"}. Chats use it until you pick an option below. From then on that choice alone decides.
          </span>
        </div>
      )}

      <div className="set-row">
        <div className="set-label">
          <div>Sign in with</div>
          <div className="desc">
            {choice === 'token' ? 'Every chat uses the OAuth token below.' : "Every chat uses the server's Claude login."} Open chats switch with their next message.
          </div>
        </div>
        <div className={!canToken && choice !== 'token' ? 'disabled' : undefined} title={!canToken && choice !== 'token' ? 'Paste a token first' : undefined}>
          <Segmented
            options={[
              ['login', 'Claude login'],
              ['token', 'OAuth token'],
            ]}
            value={choice}
            onChange={(v) => (v === 'login' || canToken ? choose(v) : null)}
          />
        </div>
      </div>

      {s.gateway && (
        <p className="set-note warn-box">
          {s.gateway === 'failover' ? (
            <>
              <b>The AI gateway is standing in right now</b> because the subscription reached a limit. Chats go back to this token when it resets.
            </>
          ) : (
            <>
              <b>The AI gateway is set to Always</b>, so chats use the gateway key, not this token. Set the gateway to Off or As fallback to use the token.
            </>
          )}
        </p>
      )}
      {s.apiKeyHelper && choice === 'token' && (
        <p className="muted set-note">{s.settingsPath} sets apiKeyHelper. Chats here turn it off while they use the token; Claude Code run directly on the host still uses it.</p>
      )}

      <label className="set-field">
        <span>OAuth token {s.hasToken && <span className="muted">(saved, ends {s.tokenHint}; paste a new one to replace it)</span>}</span>
        <Input mono type="password" value={tok} placeholder={s.hasToken ? '••••••••••••' : 'sk-ant-oat01-…'} onChange={(e) => setTok(e.target.value)} spellCheck={false} autoComplete="new-password" />
      </label>
      <div className="set-actions">
        <Button variant="primary" size="sm" disabled={!!busy || !tok.trim()} onClick={() => save(choice === 'token' || !s.hasToken ? { token: tok, use: 'token' } : { token: tok }, 'save')}>
          {busy === 'save' ? 'Saving…' : choice === 'token' || !s.hasToken ? 'Save and use' : 'Save'}
        </Button>
        <Button size="sm" disabled={!!busy || !canToken} onClick={runTest}>
          {busy === 'test' ? 'Testing…' : 'Test token'}
        </Button>
        {s.hasToken && (
          <Button size="sm" disabled={!!busy} onClick={() => save({ token: '' }, 'remove')}>
            Remove token
          </Button>
        )}
      </div>
      {test && (
        <p className="set-note" style={{ color: test.ok ? undefined : 'var(--red)' }}>
          {test.ok ? test.note || 'The token works. Claude answered a one-word test with the smallest model.' : test.error}
        </p>
      )}
      <p className="muted set-note">The token is kept in this server's data folder (claude-token.json, readable only by its owner) and is never shown again. Claude's own tools in a chat can still see it in their environment, like any Claude Code credential.</p>
    </>
  );
}
