import React, { useEffect, useState } from 'react';
import { api, timeAgo } from './api.js';
import { Button, Pill, Textarea } from './ui/index.jsx';
import { copyText } from './ui/clipboard.js';

const WORDS = {
  ok: ['Connected', 'green'],
  signin: ['Waiting for a device code sign-in', 'warn'],
  'signin-browser': ['Waiting for you to sign in', 'warn'],
  'signin-error': ["Sign-in didn't work", 'red'],
  'device-failed': ["Device code sign-in didn't work", 'warn'],
  expired: ['The Microsoft sign-in expired', 'red'],
};

/** Settings > Teams: the Teams bridge's state, its Microsoft sign-in, and how to set it up. */
export default function TeamsTab({ onError }) {
  const [status, setStatus] = useState(undefined);
  const [link, setLink] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [token, setToken] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api('/api/bridge-status')
        .then((r) => {
          if (!alive) return;
          setStatus(r.status || null);
          setToken(r.enabled ? r.token : false);
          if (r.status?.state === 'signin-browser' && r.status.url) setLink(r.status.url);
          if (r.status?.state === 'ok') setSending(false);
          if (r.status?.state === 'signin-error') setSending(false);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const finish = async () => {
    const url = reply.trim();
    if (!url) return;
    setSending(true);
    try {
      await api('/api/bridge-signin', { method: 'POST', body: { url } });
      setReply('');
    } catch (e) {
      setSending(false);
      onError(e);
    }
  };

  const [word, tone] = status ? WORDS[status.state] || [status.state, ''] : [];
  const browser = status && ['signin-browser', 'signin-error'].includes(status.state) && link;

  return (
    <>
      <p className="muted set-note">
        The Teams bridge lets you talk to your agents from Microsoft Teams: permission prompts, questions and decisions show up in your Teams chat with yourself, and you answer by replying. It runs as a separate service next to this server (see teams-bridge/README.md).
      </p>

      <h4 className="set-h">Status</h4>
      {status === undefined ? (
        <div className="muted">Loading…</div>
      ) : !status ? (
        <p className="muted set-note">
          The bridge hasn't reported in since this server started. Set TEAMS_TENANT_ID and TEAMS_CLIENT_ID in .env and start it with <code>docker compose --profile teams up -d</code>.
        </p>
      ) : (
        <div className="set-note">
          <Pill tone={tone}>{word}</Pill> <span className="muted">{timeAgo(status.at)}</span>
          {status.message && <div className="muted" style={{ marginTop: 6 }}>{status.state === 'signin' && status.code ? `Open ${status.url || 'https://microsoft.com/devicelogin'} and enter ${status.code}.` : status.message}</div>}
        </div>
      )}

      {browser && (
        <>
          <h4 className="set-h">Sign in to Microsoft</h4>
          <ol className="set-note teams-steps">
            <li>
              <Button size="sm" variant="primary" as="a" href={link} target="_blank" rel="noopener noreferrer">
                Sign in to Microsoft
              </Button>{' '}
              <span className="muted">in any browser where you can use your work account.</span>
            </li>
            <li>
              The browser ends on <code>http://localhost/?code=…</code> with a "can't be reached" error. That's expected.
            </li>
            <li>
              Copy that whole address and paste it here:
              <Textarea mono rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="http://localhost/?code=…" aria-label="Address the browser ended on" />
              <Button size="sm" variant="primary" disabled={!reply.trim() || sending} onClick={finish}>
                {sending ? 'Finishing…' : 'Finish sign-in'}
              </Button>
            </li>
          </ol>
        </>
      )}

      <h4 className="set-h">Bridge token</h4>
      {token === null ? null : token ? (
        <>
          <div className="token-row">
            <code className="token">{show ? token : '•'.repeat(24)}</code>
            <Button size="sm" onClick={() => setShow(!show)}>
              {show ? 'Hide' : 'Show'}
            </Button>
            <Button size="sm" onClick={() => copyText(token)}>
              Copy
            </Button>
          </div>
          <p className="muted set-note">The bridge reads it from ~/.claude-web/bridge-token. Only needed when the bridge runs on another machine (set CW_BRIDGE_TOKEN there).</p>
        </>
      ) : (
        <p className="muted set-note">The bridge API is turned off (CW_BRIDGE_API=0).</p>
      )}
    </>
  );
}
