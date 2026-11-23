import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, IconButton } from '../ui/index.jsx';
import { useResizable } from '../ui/resizable.jsx';
import { PrCard } from './SidePanel.jsx';
import { contextWindowFor } from './Composer.jsx';
import { needsSignIn } from './McpAuth.jsx';

// The session details rail beside a chat, like Desktop's: where the chat runs, how full its
// context is, what Claude made, and the folder's changes with the branch's pull request.

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const fmtTok = (n) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n || 0));
// The UI's own MCP servers (chat tools, browser, notes): always there, so not worth listing.
const BUILTIN_MCP = new Set(['project', 'sessions', 'schedule', 'ui', 'notes', 'browser']);
const EXT_ICON = {
  html: '◧',
  htm: '◧',
  svg: '◇',
  png: '▣',
  jpg: '▣',
  jpeg: '▣',
  gif: '▣',
  webp: '▣',
  md: '¶',
  pdf: '▤',
  csv: '▦',
};

function Section({ title, action, children }) {
  return (
    <section className="rail-sec">
      <div className="rail-head">
        <span className="rail-title">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function statusOf(meta, state, conn) {
  if (conn !== 'open')
    return {
      text: conn === 'reconnecting' ? 'Reconnecting' : 'Connecting',
      tone: 'warn',
    };
  if (state === 'waiting') return { text: 'Needs you', tone: 'warn' };
  if (state === 'busy') return { text: 'Working', tone: 'busy' };
  if (meta.live) return { text: 'Ready', tone: 'on' };
  return {
    text: 'Asleep',
    tone: 'off',
    title: 'The Claude process is stopped. It resumes on your next message.',
  };
}

export default function SessionRail({
  sessionId,
  meta,
  state,
  conn,
  refreshKey,
  busy,
  liveTasks,
  parent,
  onSelect,
  onOpenArtifact,
  onOpenChanges,
  onOpenTasks,
  onAllOutputs,
  onCompact,
  onPrompt,
  onSignIn,
  onInfo,
  onClose,
  onError,
}) {
  const resize = useResizable('rail', { edge: 'left', min: 220, max: 480, label: 'Resize details panel' });
  const [changes, setChanges] = useState(null);
  const [outputs, setOutputs] = useState(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let off = false;
    api(`/api/sessions/${sessionId}/changes`)
      .then((d) => !off && setChanges(d))
      .catch((e) => !off && setChanges({ error: e.message }));
    api(`/api/artifacts?session=${encodeURIComponent(sessionId)}`)
      .then((d) => !off && setOutputs(d.artifacts || []))
      .catch(() => !off && setOutputs([]));
    return () => {
      off = true;
    };
  }, [sessionId, refreshKey]);

  const st = statusOf(meta, state, conn);
  const used = meta.contextTokens || 0;
  const win = contextWindowFor({
    used,
    window: meta.contextWindow,
    compactWindow: meta.compactWindow,
    model: meta.model,
  });
  const pct = used ? Math.min(1, used / win) : 0;
  const folder = meta.noFolder ? 'No folder' : base(meta.project || meta.cwd);
  const branch = changes?.branch || meta.worktree?.branch;
  const add = changes?.files?.reduce((n, f) => n + (f.add || 0), 0) || 0;
  const del = changes?.files?.reduce((n, f) => n + (f.del || 0), 0) || 0;
  const nFiles = changes?.files?.length || 0;
  const shown = more ? outputs || [] : (outputs || []).slice(0, 6);
  const mcp = (meta.mcpServers || []).filter((m) => !BUILTIN_MCP.has(m.name));
  const mcpBad = mcp.filter((m) => m.status !== 'connected');

  return (
    <>
      <div className="rail-scrim" onClick={onClose} />
      <aside className="session-rail" aria-label="Session details" ref={resize.ref} style={resize.style}>
        {resize.handle}
        <div className="rail-top">
          <span className="rail-top-title">Details</span>
          <IconButton size="sm" title="Session info and usage" onClick={onInfo}>
            ⓘ
          </IconButton>
          <IconButton size="sm" title="Hide details" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="rail-body">
          <Section
            title="Environment"
            action={
              <span className={`rail-status ${st.tone}`} title={st.title}>
                <span className="dot" /> {st.text}
              </span>
            }
          >
            <div className="rail-row" title={meta.envName ? 'Environment' : 'Runs on the server'}>
              <span className="ri">⌂</span>
              <span className="rv">{meta.envName || 'Local'}</span>
            </div>
            <div className="rail-row" title={meta.cwd}>
              <span className="ri">▢</span>
              <span className="rv">{folder}</span>
            </div>
            {(meta.addDirs || []).map((d) => (
              <div key={d} className="rail-row sub" title={d}>
                <span className="ri">+</span>
                <span className="rv">{base(d)}</span>
              </div>
            ))}
            {branch && (
              <div className="rail-row" title={meta.worktree ? `Worktree: ${meta.worktree.path || ''}` : 'Branch'}>
                <span className="ri">⎇</span>
                <span className="rv mono">{branch}</span>
                {meta.worktree && <span className="pill rail-tag">worktree</span>}
              </div>
            )}
            {parent && (
              <button className="rail-row link" onClick={() => onSelect(parent.id)} title="Open the parent chat">
                <span className="ri">↰</span>
                <span className="rv">{parent.name}</span>
              </button>
            )}
          </Section>

          <Section
            title="Context"
            action={
              used > 0 && (
                <button className="rail-link" onClick={onCompact} disabled={busy} title="Summarize the conversation to free up context">
                  Compact
                </button>
              )
            }
          >
            {used > 0 ? (
              <>
                <div className={`meter ${pct > 0.8 ? 'hot' : ''}`}>
                  <span style={{ width: `${pct * 100}%` }} />
                </div>
                <div className="rail-note">
                  {Math.round(pct * 100)}% used · {fmtTok(used)} of {fmtTok(win)} tokens
                </div>
              </>
            ) : (
              <div className="rail-note">Shown after the first reply.</div>
            )}
            {meta.totalCost > 0 && <div className="rail-note">${meta.totalCost.toFixed(2)} this chat (API-equivalent)</div>}
          </Section>

          <Section
            title="Outputs"
            action={
              outputs?.length > 0 && (
                <button className="rail-link" onClick={onAllOutputs}>
                  All {outputs.length}
                </button>
              )
            }
          >
            {!outputs && <div className="rail-note">Loading…</div>}
            {outputs?.length === 0 && <div className="rail-note">Pages, images and documents Claude writes show here.</div>}
            {shown.map((a) => (
              <button key={a.path} className="rail-row link" title={a.path} onClick={() => onOpenArtifact(a.path, a.title)}>
                <span className="ri">{EXT_ICON[a.ext] || '▢'}</span>
                <span className="rv">{a.title || a.name}</span>
                {a.published && <span className="pill rail-tag">published</span>}
              </button>
            ))}
            {!more && outputs?.length > 6 && (
              <button className="rail-link more" onClick={() => setMore(true)}>
                {outputs.length - 6} more
              </button>
            )}
          </Section>

          <Section
            title="Changes"
            action={
              changes?.git && (
                <button className="rail-link" onClick={onOpenChanges}>
                  Review
                </button>
              )
            }
          >
            {!changes && <div className="rail-note">Loading…</div>}
            {changes?.error && <div className="rail-note">{changes.error}</div>}
            {changes && !changes.error && !changes.git && <div className="rail-note">Not a git repository.</div>}
            {changes?.git &&
              (nFiles ? (
                <button className="rail-row link" onClick={onOpenChanges}>
                  <span className="ri">±</span>
                  <span className="rv">
                    {nFiles} file{nFiles === 1 ? '' : 's'} changed
                  </span>
                  <span className="rail-diffstat">
                    <span className="add">+{add}</span> <span className="del">−{del}</span>
                  </span>
                </button>
              ) : (
                <div className="rail-note">No uncommitted changes.</div>
              ))}
            {changes?.git && <PrCard sessionId={sessionId} refreshKey={refreshKey} onPrompt={onPrompt} busy={busy} onError={onError} compact />}
          </Section>

          {liveTasks.length > 0 && (
            <Section title="Background">
              <button className="rail-row link" onClick={onOpenTasks}>
                <span className="ri">◌</span>
                <span className="rv">
                  {liveTasks.length} task{liveTasks.length === 1 ? '' : 's'} running
                </span>
              </button>
            </Section>
          )}

          {mcp.length > 0 && (
            <Section title="MCP servers" action={<span className="rail-note">{mcpBad.length ? `${mcpBad.length} not connected` : 'All connected'}</span>}>
              {(mcpBad.length ? mcpBad : mcp).slice(0, 8).map((m) => (
                <div key={m.name} className="rail-row">
                  <span className={`dot ${m.status === 'connected' ? 'on' : m.status === 'pending' ? 'busy' : 'off'}`} />
                  <span className="rv">{m.name}</span>
                  {needsSignIn(m) ? (
                    <Button size="sm" variant="primary" onClick={() => onSignIn(m.name)}>
                      Sign in
                    </Button>
                  ) : (
                    <span className="rail-note">{m.status}</span>
                  )}
                </div>
              ))}
            </Section>
          )}
        </div>
      </aside>
    </>
  );
}
