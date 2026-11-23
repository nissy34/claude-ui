import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Input, Pill, Toggle } from './ui/index.jsx';

const SOURCE = { settings: 'Saved here', host: 'From the server', default: 'Default' };

/**
 * Settings > Account: the git name and email used for commits made in chats and terminals.
 * Saved values beat the server's ~/.gitconfig; a repository's own user.name/email still wins.
 */
export function GitIdentitySettings({ onError }) {
  const [s, setS] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const take = (r) => {
    setS(r);
    setName(r.saved?.name || '');
    setEmail(r.saved?.email || '');
  };
  useEffect(() => {
    api('/api/git-identity').then(take).catch(onError);
  }, []);
  if (!s) return <div className="muted">Checking…</div>;
  if (!s.available) return <p className="muted set-note">git is not installed on this server.</p>;

  const save = async (body) => {
    setBusy(true);
    setSaved(false);
    try {
      take(await api('/api/git-identity', { method: 'PUT', body }));
      setSaved(true);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const dirty = name.trim() !== (s.saved?.name || '') || email.trim() !== (s.saved?.email || '');
  const eff = s.effective;
  const usingDefault = eff.name.source === 'default' || eff.email.source === 'default';

  return (
    <>
      <p className="muted set-note">The name and email on commits Claude makes in chats and terminals. A repository's own git config still wins. Changes apply at once, also in open chats.</p>
      <div className="set-row">
        <div className="set-label">
          <div>Commits are made as</div>
          <div className="desc">
            {eff.name.value} &lt;{eff.email.value}&gt;
          </div>
        </div>
        <Pill tone={usingDefault ? undefined : 'green'}>{eff.name.source === eff.email.source ? SOURCE[eff.name.source] : 'Mixed'}</Pill>
      </div>
      {usingDefault && (
        <p className="set-note warn-box">
          No git identity is set on the server ({s.hostPath}), so chats use a default. Enter yours below so commits are linked to your account on GitHub or GitLab.
        </p>
      )}
      <label className="set-field">
        <span>Name</span>
        <Input value={name} placeholder={s.host?.name || s.default.name} onChange={(e) => (setName(e.target.value), setSaved(false))} spellCheck={false} />
      </label>
      <label className="set-field">
        <span>Email</span>
        <Input type="email" value={email} placeholder={s.host?.email || s.default.email} onChange={(e) => (setEmail(e.target.value), setSaved(false))} spellCheck={false} />
      </label>
      <div className="set-actions">
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => save({ name, email })}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {(s.saved?.name || s.saved?.email) && (
          <Button size="sm" disabled={busy} onClick={() => save({ name: '', email: '' })}>
            Clear
          </Button>
        )}
        {saved && !dirty && <span className="muted">Saved.</span>}
      </div>
      <p className="muted set-note">Leave a field empty to use the server's {s.hostPath}{s.host?.name || s.host?.email ? '' : ' (nothing set there now)'}.</p>
      <div className="set-row">
        <div className="set-label">
          <div>Credit Claude as co-author</div>
          <div className="desc">
            {s.coauthor ? (
              <>
                Commits end with a line like <code>Co-Authored-By: Claude Opus 4.5 &lt;noreply@anthropic.com&gt;</code>, naming the chat's model. This wins over a settings file that turns it off.
              </>
            ) : (
              'Commits have no Co-Authored-By line for Claude.'
            )}
          </div>
        </div>
        <Toggle value={s.coauthor} onChange={(v) => save({ coauthor: v })} />
      </div>
    </>
  );
}
