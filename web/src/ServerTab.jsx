import React, { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from './api.js';
import { Button, Input, Pill, Spinner, Toggle } from './ui/index.jsx';

const RUN_WORDS = {
  running: ['Updating…', 'warn'],
  ok: ['Updated', 'green'],
  'rolled-back': ['Rolled back: the new server failed its health check', 'red'],
  failed: ['Failed: the running server was not changed', 'red'],
  'waiting-timed-out': ['Chats were still working; nothing restarted', 'warn'],
  interrupted: ['Interrupted', 'warn'],
};

/**
 * Settings > Server: the running commit, the session runner, what is working, and self-update
 * (any branch from here; chats can update from main only, with your approval).
 */
export default function ServerTab({ onError }) {
  const [st, setSt] = useState(null);
  const [upd, setUpd] = useState(undefined); // updater status; null = not set up
  const [ref, setRef] = useState('main');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [runner, setRunner] = useState(false);
  const [run, setRun] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api('/api/server/status')
        .then((r) => alive && setSt(r))
        .catch(() => {}); // the server restarts during an update
      api('/api/update/status')
        .then((r) => {
          if (!alive) return;
          setUpd(r);
          if (r.running) setRun((cur) => (cur && cur.id !== r.running.id ? cur : r.running));
        })
        .catch((e) => alive && e.status && e.status !== 503 && setUpd(e.status === 501 ? null : { error: e.message }));
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Follow a run until it ends (through the server's own restart).
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const t = setInterval(() => {
      api(`/api/update/runs/${run.id}`)
        .then((r) => setRun(r))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.output]);

  const doCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await api(`/api/update/check?ref=${encodeURIComponent(ref.trim() || 'main')}`));
    } catch (e) {
      onError(e);
    } finally {
      setChecking(false);
    }
  };

  const doUpdate = async () => {
    try {
      setRun(await api('/api/update/run', { method: 'POST', body: { ref: ref.trim() || 'main', runner } }));
    } catch (e) {
      onError(e);
    }
  };

  const drain = async (on) => {
    try {
      setSt(await api('/api/server/drain', { method: 'POST', body: { on, reason: 'Settings' } }));
    } catch (e) {
      onError(e);
    }
  };

  const running = run?.status === 'running' || !!upd?.running;
  const [word, tone] = run ? RUN_WORDS[run.status] || [run.status, ''] : [];

  return (
    <>
      <h4 className="set-h">Running</h4>
      {!st ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="set-note">
          <div>
            Commit <code>{st.commit || 'unknown'}</code>
            {upd?.branch && (
              <>
                {' '}
                on <code>{upd.branch}</code>
              </>
            )}{' '}
            <span className="muted">· started {timeAgo(st.startedAt)}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            Session runner:{' '}
            {!st.runner.configured ? (
              <span className="muted">off. Chats are child processes of the server, so a restart stops them (they resume by themselves).</span>
            ) : st.runner.up ? (
              <>
                <Pill tone="green">Connected</Pill> <span className="muted">chats keep running when the server restarts</span>
              </>
            ) : (
              <Pill tone="red">Not connected: new chats start inside the server</Pill>
            )}
          </div>
          <div style={{ marginTop: 6 }}>
            {st.busy.idle ? <span className="muted">No chat is working.</span> : <>Working: {st.busy.chats.map((c) => c.name).join(', ')}</>}
            {st.busy.terminals.length > 0 && <span className="muted"> · {st.busy.terminals.length} terminal{st.busy.terminals.length > 1 ? 's' : ''} open</span>}
          </div>
          {st.draining ? (
            <div style={{ marginTop: 8 }}>
              <Pill tone="warn">Draining</Pill> <span className="muted">since {timeAgo(st.draining.since)}: new messages wait in their queues.</span>{' '}
              <Button size="sm" onClick={() => drain(false)}>
                Stop draining
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <h4 className="set-h">Update</h4>
      {upd === undefined ? (
        <div className="muted">Loading…</div>
      ) : upd === null ? (
        <p className="muted set-note">
          Self-update needs the updater service from <code>docker-compose.yml</code>. Without it, update with <code>scripts/deploy.sh</code> on the server.
        </p>
      ) : upd.error ? (
        <p className="muted set-note">The updater isn't answering: {upd.error}</p>
      ) : (
        <>
          <p className="muted set-note">
            Pulls the branch, rebuilds and restarts the web server. Chats keep running through it. Chats can also update the server themselves, from main only and only after you approve it.
          </p>
          <div className="set-row">
            <div className="set-label">Branch</div>
            <div className="set-ctl fields sm" style={{ display: 'flex', gap: 8 }}>
              <Input size="sm" mono value={ref} onChange={(e) => (setRef(e.target.value), setCheck(null))} placeholder="main" style={{ maxWidth: 220 }} />
              <Button size="sm" onClick={doCheck} disabled={checking || running}>
                {checking ? <Spinner /> : 'Check'}
              </Button>
            </div>
          </div>
          {check && (
            <div className="set-note">
              {check.upToDate ? (
                <span className="muted">
                  Up to date: <code>{check.head}</code> is the latest on {check.ref}.
                </span>
              ) : (
                <>
                  <div>
                    <code>{check.head}</code> → <code>{check.target}</code> ({check.behind} commit{check.behind === 1 ? '' : 's'}
                    {check.branch !== check.ref ? `, switching from ${check.branch}` : ''})
                  </div>
                  <ul className="muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {check.commits.map((c) => (
                      <li key={c.sha}>
                        <code>{c.sha}</code> {c.subject}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {check.dirty && <div style={{ marginTop: 6, color: 'var(--red)' }}>The checkout on the server has uncommitted changes, so an update would stop before building.</div>}
            </div>
          )}
          <div className="set-row">
            <div className="set-label">
              Also restart the runner
              <div className="desc">For a new Claude Code version. Waits until no chat is working; chats cut off resume by themselves.</div>
            </div>
            <div className="set-ctl fields sm">
              <Toggle value={runner} onChange={setRunner} label="Also restart the runner" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <Button variant="primary" onClick={doUpdate} disabled={running}>
              {running ? 'Updating…' : `Update to ${ref.trim() || 'main'}`}
            </Button>
            {upd.last && !run && (
              <span className="muted">
                Last update {timeAgo(upd.last.startedAt)}: {(RUN_WORDS[upd.last.status] || [upd.last.status])[0]} ({upd.last.from} → {upd.last.to || '…'}, from {upd.last.requestedBy || upd.last.source})
              </span>
            )}
          </div>
          {run && (
            <div className="set-note" style={{ marginTop: 10 }}>
              <Pill tone={tone}>{word}</Pill>{' '}
              <span className="muted">
                {run.from} → {run.to || (run.status === 'running' ? '…' : run.from)}
              </span>
              <pre ref={logRef} className="mono" style={{ maxHeight: 260, overflow: 'auto', marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {run.output || ''}
              </pre>
            </div>
          )}
        </>
      )}
    </>
  );
}
