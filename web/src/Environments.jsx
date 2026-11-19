import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Button, Checkbox, IconButton, Modal, ModalHead } from './ui/index.jsx';
import { confirmDialog } from './ui/dialogs.jsx';

export const FolderIcon = () => (
  <svg className="pl-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
export const EnvIcon = () => (
  <svg className="pl-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.8 14.2 5 8 8.2 1.8 5z M1.8 8 8 11.2 14.2 8 M1.8 11 8 14.2 14.2 11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
export const GitIcon = () => (
  <svg className="pl-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-3 2.2-6.2 4" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;

export function envToText(env) {
  return Object.entries(env || {})
    .map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`)
    .join('\n');
}

export function envSummary(e) {
  const f = e.folders.length;
  const v = Object.keys(e.env || {}).length;
  const wt = e.folders.some((x) => x.worktree);
  const parts = [f === 1 ? base(e.folders[0].path) : f ? `${f} folders` : 'No folder', wt ? 'worktree' : '', v ? `${v} variable${v > 1 ? 's' : ''}` : ''];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Create or edit a Local environment: name, folders (first is where Claude works, each with a
 * branch and an optional worktree), env vars. initialFolders/initialName prefill a new one.
 */
export function EnvironmentDialog({ env, initialFolders, initialName, projects, onSaved, onDeleted, onClose, onError }) {
  const all = projects?.projects || [];
  const [name, setName] = useState(env?.name || initialName || defaultName(all));
  const [folders, setFolders] = useState(() => (env ? env.folderInfo || [] : initialFolders || []).map((f) => ({ path: f.path, git: f.git, exists: f.exists, branch: f.branch || '', worktree: !!f.worktree })));
  const [vars, setVars] = useState(envToText(env?.env));
  const [showVars, setShowVars] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const varCount = vars.split('\n').filter((l) => /^\s*[^#\s][^=]*=/.test(l)).length;

  const add = (path, git) => {
    if (!folders.some((f) => f.path === path)) setFolders((l) => [...l, { path, git, exists: true, branch: '', worktree: false }]);
    setAdding(false);
  };
  const remove = (path) => setFolders((l) => l.filter((f) => f.path !== path));
  const patch = (path, p) => setFolders((l) => l.map((f) => (f.path === path ? { ...f, ...p } : f)));
  const makeMain = (path) => setFolders((l) => [l.find((f) => f.path === path), ...l.filter((f) => f.path !== path)]);

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const body = { name, folders: folders.map((f) => ({ path: f.path, branch: f.branch || undefined, worktree: f.worktree || undefined })), env: vars };
      const { environment } = env ? await api(`/api/environments/${env.id}`, { method: 'PUT', body }) : await api('/api/environments', { method: 'POST', body });
      onSaved(environment);
    } catch (e2) {
      setErr(e2.message);
      if (/variable|KEY=value|set by Claude UI/.test(e2.message) && !/branch/i.test(e2.message)) setShowVars(true);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!(await confirmDialog(`Delete the environment "${env.name}"? Its folders are not touched.`, { ok: 'Delete', danger: true }))) return;
    try {
      await api(`/api/environments/${env.id}`, { method: 'DELETE' });
      onDeleted(env.id);
    } catch (e) {
      onError(e);
    }
  };

  return (
    <Modal as="form" onClose={(e) => (e.stopPropagation(), onClose())} overlayClassName="env-modal" className="env-dialog" onSubmit={save}>
      <ModalHead title={env ? 'Edit environment' : 'New environment'} onClose={onClose} />
      <div className="modal-body">
        <label className="env-label" htmlFor="env-name">
          Name
        </label>
        <input id="env-name" className="field env-field" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!env} maxLength={60} />

        <div className="env-row-head">
          <span className="env-label">
            Folders <span className="muted">(optional)</span>
          </span>
          <Button type="button" size="sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            ＋ Add
          </Button>
        </div>
        {adding && <FolderPicker projects={all} taken={folders.map((f) => f.path)} onPick={add} onCancel={() => setAdding(false)} />}
        {folders.length > 0 ? (
          <div className="env-box card">
            {folders.map((f, i) => (
              <FolderRow key={f.path} f={f} main={i === 0 && folders.length > 1} canMakeMain={i > 0} onChange={(p) => patch(f.path, p)} onMakeMain={() => makeMain(f.path)} onRemove={() => remove(f.path)} />
            ))}
          </div>
        ) : (
          !adding && <div className="env-box card env-empty muted">No folders. Chats in this environment work in a scratch folder.</div>
        )}

        <div className="env-box card">
          <button type="button" className="env-vars-head" onClick={() => setShowVars((s) => !s)} aria-expanded={showVars}>
            <span>
              <span className="ev-title">Environment variables</span>
              <span className="ev-sub muted">{varCount ? `${varCount} variable${varCount > 1 ? 's' : ''}` : 'None for this environment'}</span>
            </span>
            <svg className={`ev-chev ${showVars ? 'open' : ''}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d={showVars ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showVars && (
            <div className="env-vars-body">
              <textarea className="field mono" rows={5} spellCheck={false} placeholder={'API_URL=https://staging.example.com\nDEBUG=1'} value={vars} onChange={(e) => setVars(e.target.value)} aria-label="Environment variables" />
              <div className="muted small-note">One KEY=value per line. Passed to Claude and the commands it runs. Stored on the server in plain text.</div>
            </div>
          )}
        </div>
        {err && <div className="pl-warn err">{err}</div>}
      </div>
      <div className="modal-foot">
        {env && (
          <Button type="button" variant="danger" className="soft" onClick={del}>
            Delete environment
          </Button>
        )}
        <span className="spacer" />
        <Button type="button"  onClick={onClose}>
          Cancel
        </Button>
        <Button variant="dark" disabled={busy || !name.trim()}>
          {env ? 'Save' : 'Create environment'}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * One folder of an environment: name, branch picker (Current or a branch) and Worktree, like
 * Claude Desktop. Without a worktree, a picked branch is checked out in the folder itself when a
 * chat starts; with one, the chat's new branch starts from it.
 */
function FolderRow({ f, main, canMakeMain, onChange, onMakeMain, onRemove }) {
  const [info, setInfo] = useState(null); // { git, current, branches }
  useEffect(() => {
    if (!f.exists) return;
    let live = true;
    api(`/api/git/branches?path=${encodeURIComponent(f.path)}`)
      .then((r) => live && setInfo(r))
      .catch(() => live && setInfo({ git: false, branches: [] }));
    return () => {
      live = false;
    };
  }, [f.path, f.exists]);
  const git = info ? info.git : f.git;
  const branches = info?.branches || [];
  const shown = f.branch || info?.current || '';
  return (
    <div className="env-folder" title={f.path}>
      <FolderIcon />
      <span className="ef-name">{base(f.path)}</span>
      {main && <span className="tag">main</span>}
      {!f.exists ? (
        <span className="ef-git muted">Missing</span>
      ) : git ? (
        <>
          <label className="ef-branch" title={f.branch ? `Starts on ${f.branch}` : 'Uses whatever branch is checked out'}>
            {shown && <span className="mono">{shown}</span>}
            <span className="ef-branch-kind">{f.branch ? '' : 'Current'}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <select value={f.branch} onChange={(e) => onChange({ branch: e.target.value })} aria-label={`Branch for ${base(f.path)}`}>
              <option value="">Current{info?.current ? ` (${info.current})` : ''}</option>
              {f.branch && !branches.includes(f.branch) && <option value={f.branch}>{f.branch}</option>}
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <Checkbox checked={f.worktree} onChange={(v) => onChange({ worktree: v })} title="Each chat gets its own copy of this repository on a new branch">
            Worktree
          </Checkbox>
        </>
      ) : (
        <span className="ef-git muted">{info || f.git === false ? 'Not a Git repository' : ''}</span>
      )}
      {canMakeMain && (
        <button type="button" className="link-btn" onClick={onMakeMain} title="Claude starts in the main folder; the others are added to its workspace">
          Make main
        </button>
      )}
      <IconButton type="button" size="sm" onClick={onRemove} aria-label={`Remove ${base(f.path)}`}>
        ✕
      </IconButton>
    </div>
  );
}

function defaultName(all) {
  return all.length ? 'Folders' : 'My environment';
}

function FolderPicker({ projects, taken, onPick, onCancel }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const typed = /^([~/\\]|[A-Za-z]:)/.test(q.trim());
  const list = projects.filter((p) => !taken.includes(p.path) && (!needle || p.name.toLowerCase().includes(needle)));
  return (
    <div className="env-picker">
      <input
        className="field"
        autoFocus
        placeholder="Search folders, or type a full path"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onCancel());
          if (e.key === 'Enter') {
            e.preventDefault();
            if (typed) onPick(q.trim());
            else if (list[0]) onPick(list[0].path, list[0].git);
          }
        }}
      />
      <div className="pick-list">
        {typed && (
          <button type="button" onClick={() => onPick(q.trim())}>
            <FolderIcon />
            <span className="pl-name">Use {q.trim()}</span>
          </button>
        )}
        {list.map((p) => (
          <button type="button" key={p.path} onClick={() => onPick(p.path, p.git)}>
            <FolderIcon />
            <span className="pl-name">{p.name}</span>
            {p.git && <span className="tag">git</span>}
          </button>
        ))}
        {!typed && list.length === 0 && <div className="pad muted">No more folders</div>}
      </div>
    </div>
  );
}

/** Clone a git repository into the projects root, with live progress. Calls onDone(path). */
export function ClonePanel({ root, onDone, onCancel }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState(null); // { phase, percent, line } while running
  const [err, setErr] = useState('');
  const ctl = useRef(null);
  const guess = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '') || '';

  const run = async (e) => {
    e.preventDefault();
    setErr('');
    setState({ line: 'Starting…' });
    ctl.current = new AbortController();
    try {
      const res = await fetch('/api/projects/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), name: name.trim() || undefined }),
        credentials: 'same-origin',
        signal: ctl.current.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (msg.progress) setState((s) => ({ ...s, ...msg.progress, ...(msg.progress.percent == null ? { percent: s?.percent, phase: s?.phase } : {}) }));
          if (msg.error) throw new Error(msg.error);
          if (msg.path) return onDone(msg.path);
        }
      }
      throw new Error('The server stopped before the clone finished');
    } catch (e2) {
      if (e2.name !== 'AbortError') setErr(e2.message);
      setState(null);
    }
  };

  const cancel = () => {
    if (ctl.current && state) ctl.current.abort();
    else onCancel();
  };

  return (
    <form className="clone-panel card" onSubmit={run}>
      <div className="clone-head">
        <GitIcon />
        <span>Clone from git</span>
      </div>
      <input className="field" autoFocus placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!state} aria-label="Repository address" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancel())} />
      <div className="row">
        <input className="field" placeholder={guess ? `Folder name (${guess})` : 'Folder name'} value={name} onChange={(e) => setName(e.target.value)} disabled={!!state} aria-label="Folder name" />
        <Button type="button" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!url.trim() || !!state}>
          Clone
        </Button>
      </div>
      {state ? (
        <div className="clone-progress" aria-live="polite">
          <div className="bar">
            <span style={{ width: `${state.percent ?? 4}%` }} className={state.percent == null ? 'indet' : ''} />
          </div>
          <div className="muted">{state.phase ? `${state.phase} ${state.percent}%` : state.line}</div>
        </div>
      ) : err ? null : (
        <div className="muted small-note">
          Goes into {root}. Private repositories use this server's git login (credential helper or SSH key).
        </div>
      )}
      {err && (
        <div className="pl-warn err" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
          {err}
        </div>
      )}
    </form>
  );
}
