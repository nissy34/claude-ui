import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { getPrefs } from './prefs.js';
import { Button, Checkbox, IconButton, Menu, Modal, ModalHead, useDismiss } from './ui/index.jsx';
import { promptDialog } from './ui/dialogs.jsx';
import { EnvironmentDialog, ClonePanel, FolderIcon, EnvIcon, GitIcon, envSummary } from './Environments.jsx';

// What a new chat starts in: "No folder", a folder path, or "env:<id>". Remembered per browser.
export const NO_FOLDER = '__none__';
const ENV = 'env:';
const LAST_KEY = 'cw.lastFolder';
const WT_KEY = 'cw.worktree';
const DRAFT_KEY = 'cw.draft.new';
const SHOWN = 4; // entries in the Local group before "More"

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    v == null || v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {}
};

const LaptopIcon = () => (
  <svg className="pl-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6H3z M1.5 12.5h13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
);
const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M10.3 2.6h3.4l.5 2.6a7.6 7.6 0 0 1 1.9 1.1l2.5-.9 1.7 2.9-2 1.7a7.7 7.7 0 0 1 0 2.2l2 1.7-1.7 2.9-2.5-.9a7.6 7.6 0 0 1-1.9 1.1l-.5 2.6h-3.4l-.5-2.6a7.6 7.6 0 0 1-1.9-1.1l-2.5.9-1.7-2.9 2-1.7a7.7 7.7 0 0 1 0-2.2l-2-1.7 1.7-2.9 2.5.9a7.6 7.6 0 0 1 1.9-1.1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const StarIcon = ({ on }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
const Chev = ({ dir = 'right' }) => (
  <svg className="np-chev" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d={dir === 'down' ? 'M4 6l4 4 4-4' : dir === 'left' ? 'M10 3.5 5.5 8 10 12.5' : 'M6 3.5 10.5 8 6 12.5'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/**
 * The New chat page, like Claude Desktop: type the first message, pick where Claude works under
 * the composer (folder or environment) and whether it gets its own git worktree.
 */
export default function NewChat({ projects, sessions, onCreate, onReloadProjects, onError, onHistory, onMenu, missing, focusKey }) {
  const all = projects.projects || [];
  const [envs, setEnvs] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [sel, setSel] = useState(() => read(LAST_KEY) || NO_FOLDER);
  const [worktree, setWorktree] = useState(() => read(WT_KEY) === '1');
  const [text, setText] = useState(() => read(DRAFT_KEY) || '');
  const [busy, setBusy] = useState(false);
  const [editEnv, setEditEnv] = useState(null); // { env } to edit, { folders, name } for a new one
  const [cloning, setCloning] = useState(false);
  const ta = useRef(null);

  const loadEnvs = () =>
    api('/api/environments')
      .then((r) => (setEnvs(r.environments), setFavorites(r.favorites || [])))
      .catch(() => setEnvs([]));
  useEffect(() => {
    loadEnvs();
  }, []);
  useEffect(() => {
    ta.current?.focus();
  }, [focusKey]);
  useEffect(() => write(DRAFT_KEY, text), [text]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [text]);

  // A remembered folder or environment that is gone falls back to No folder.
  const selEnv = sel.startsWith(ENV) ? envs?.find((e) => ENV + e.id === sel) : null;
  const selProject = all.find((p) => p.path === sel);
  useEffect(() => {
    if (!envs || !projects.root) return;
    if ((sel.startsWith(ENV) && !selEnv) || (sel !== NO_FOLDER && !sel.startsWith(ENV) && !selProject)) setSel(NO_FOLDER);
  }, [envs, projects.root]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (key) => {
    setSel(key);
    write(LAST_KEY, key);
    ta.current?.focus();
  };

  // Worktree applies to the first folder. An environment can already ask for one on that folder.
  const mainGit = selEnv ? !!selEnv.folderInfo?.[0]?.git : !!selProject?.git;
  const envForcesWt = !!selEnv?.folders?.[0]?.worktree;
  const wtOn = mainGit && (worktree || envForcesWt);

  const label = sel === NO_FOLDER ? 'No folder' : selEnv ? selEnv.name : selProject ? selProject.name : sel.startsWith(ENV) ? 'Environment' : 'No folder';

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy || (sel.startsWith(ENV) && !envs)) return;
    setBusy(true);
    const target = sel === NO_FOLDER || (!selEnv && !selProject) ? { noFolder: true } : selEnv ? { envId: selEnv.id } : { cwd: sel };
    const s = await onCreate({ ...target, kind: 'chat', worktree: mainGit && worktree, prompt });
    setBusy(false);
    if (s) setText('');
  };

  const onKey = (e) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const enterSends = getPrefs().sendOnEnter ? !e.shiftKey && !touch : e.ctrlKey || e.metaKey;
    if (enterSends) (e.preventDefault(), send());
  };

  const star = async (key, on) => {
    setFavorites((f) => (on ? [key, ...f.filter((k) => k !== key)] : f.filter((k) => k !== key)));
    try {
      setFavorites((await api('/api/environments-favorites', { method: 'PUT', body: { key, on } })).favorites);
    } catch (e) {
      onError(e);
    }
  };

  const newFolder = async () => {
    const name = await promptDialog('New folder', '', { placeholder: 'new-project', ok: 'Create' });
    if (!name) return;
    try {
      const { path } = await api('/api/projects', { method: 'POST', body: { name } });
      await onReloadProjects();
      pick(path);
    } catch (e) {
      onError(e);
    }
  };

  const envSaved = (env) => {
    setEnvs((l) => [...(l || []).filter((e) => e.id !== env.id), env].sort((a, b) => a.name.localeCompare(b.name)));
    pick(ENV + env.id);
    setEditEnv(null);
  };

  const historyDir = sel === NO_FOLDER ? projects.scratch : selEnv ? selEnv.folders[0]?.path || projects.scratch : selProject ? sel : null;

  return (
    <div className="empty new-chat-page">
      <div className="topbar">
        <IconButton className="menu-btn" onClick={onMenu} aria-label="Menu">
          ☰
        </IconButton>
      </div>
      <div className="nc-body">
        <div className="nc-hero">
          <span className="mark">&gt;_</span>
          <h2>{missing ? 'That chat no longer exists' : greeting()}</h2>
        </div>
        <div className="nc-compose">
          <div className="composer">
            <textarea
              ref={ta}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Describe a task or ask a question"
              aria-label="First message"
              disabled={busy}
            />
            <div className="composer-bar">
              <span className="spacer" />
              <button className="send" disabled={!text.trim() || busy} onClick={send} title="Start chat (Enter)" aria-label="Start chat">
                {busy ? <span className="spinner" /> : '↑'}
              </button>
            </div>
          </div>
          <div className="nc-bar">
            <EnvPicker
              label={label}
              sel={sel}
              projects={all}
              envs={envs}
              sessions={sessions}
              favorites={favorites}
              onPick={pick}
              onStar={star}
              onEditEnv={(env) => setEditEnv({ env })}
              onFolderSettings={(p) => setEditEnv({ folders: [{ path: p.path, git: p.git, exists: true }], name: p.name })}
              onNewEnv={() => setEditEnv({})}
              onNewFolder={newFolder}
              onClone={() => setCloning(true)}
            />
            <Checkbox
              checked={wtOn}
              disabled={!mainGit || envForcesWt}
              onChange={(v) => (setWorktree(v), write(WT_KEY, v ? '1' : ''))}
              title={
                !mainGit
                  ? 'Worktrees need a folder that is a git repository'
                  : envForcesWt
                    ? 'This environment always starts its main folder in a worktree'
                    : 'Claude works in its own copy of the repository on a new branch, so your checkout and other chats are not touched'
              }
            >
              Worktree
            </Checkbox>
            <span className="spacer" />
            {historyDir && (
              <button type="button" className="link-btn nc-resume" onClick={() => onHistory(historyDir)}>
                Resume a past conversation
              </button>
            )}
          </div>
          {projects.rootCaseHint && (
            <div className="pl-warn">
              The projects folder is set as <code>{projects.root}</code>, but your home folder is spelled with different capitals. Set <code>CW_PROJECTS_ROOT={projects.rootCaseHint}</code> in <code>.env</code> and restart, so these chats line up
              with Claude on your computer.
            </div>
          )}
        </div>
      </div>
      {editEnv && (
        <EnvironmentDialog
          env={editEnv.env || null}
          initialFolders={editEnv.folders}
          initialName={editEnv.name}
          projects={projects}
          onSaved={envSaved}
          onDeleted={(id) => (setEnvs((l) => l.filter((e) => e.id !== id)), setFavorites((f) => f.filter((k) => k !== ENV + id)), setEditEnv(null), sel === ENV + id && pick(NO_FOLDER))}
          onClose={() => setEditEnv(null)}
          onError={onError}
        />
      )}
      {cloning && (
        <Modal onClose={() => setCloning(false)} className="clone-modal">
          <ModalHead title="Clone from git" onClose={() => setCloning(false)} />
          <div className="modal-body">
            <ClonePanel
              root={projects.root}
              onCancel={() => setCloning(false)}
              onDone={async (path) => {
                await onReloadProjects();
                setCloning(false);
                pick(path);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The environment chip and its popover: search, Local group (starred, then recent, then More), actions. */
function EnvPicker({ label, sel, projects, envs, sessions, favorites, onPick, onStar, onEditEnv, onFolderSettings, onNewEnv, onNewFolder, onClone }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef(null);
  const close = () => (setOpen(false), setMore(false), setQ(''));
  useDismiss(open, close, root);

  // Every choice as one list. Environments count as used when a chat started in them.
  const items = useMemo(() => {
    const envUsed = {};
    for (const s of sessions || []) if (s.envId) envUsed[s.envId] = Math.max(envUsed[s.envId] || 0, s.lastActivity || s.createdAt || 0);
    const list = [
      ...(envs || []).map((e) => ({ key: ENV + e.id, kind: 'env', name: e.name, sub: envSummary(e), env: e, used: envUsed[e.id] || e.updatedAt || e.createdAt || 0 })),
      ...projects.map((p) => ({ key: p.path, kind: 'folder', name: p.name, git: p.git, project: p, used: p.lastUsed || 0 })),
    ];
    const fav = (k) => favorites.indexOf(k);
    return list.sort((a, b) => {
      const fa = fav(a.key);
      const fb = fav(b.key);
      if (fa >= 0 || fb >= 0) return fa < 0 ? 1 : fb < 0 ? -1 : fa - fb;
      return b.used - a.used || a.name.localeCompare(b.name);
    });
  }, [envs, projects, sessions, favorites]);

  const needle = q.trim().toLowerCase();
  const matches = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;
  const top = items.slice(0, SHOWN);
  // Keep the current choice visible even when it isn't among the first few.
  const cur = items.find((i) => i.key === sel);
  if (cur && !top.includes(cur)) top[top.length ? top.length - 1 : 0] = cur;
  const rest = items.filter((i) => !top.includes(i));
  const showNone = !needle || 'no folder'.includes(needle);

  const choose = (key) => (onPick(key), close());
  const row = (i) => {
    const on = i.key === sel;
    const starred = favorites.includes(i.key);
    return (
      <div key={i.key} className={`np-row ${on ? 'on' : ''}`}>
        <button type="button" role="menuitemradio" aria-checked={on} className="np-main" onClick={() => choose(i.key)} title={i.kind === 'folder' ? i.project.path : i.sub}>
          {i.kind === 'env' ? <EnvIcon /> : <FolderIcon />}
          <span className="menu-label ellipsis">
            {i.name}
            {i.kind === 'env' && <span className="desc">{i.sub}</span>}
          </span>
          {i.git && <span className="tag">git</span>}
          {on && <span className="check">✓</span>}
        </button>
        <span className="np-acts">
          <IconButton size="sm" type="button" title={i.kind === 'env' ? 'Edit environment' : 'Make an environment from this folder'} aria-label={`Settings for ${i.name}`} onClick={() => (close(), i.kind === 'env' ? onEditEnv(i.env) : onFolderSettings(i.project))}>
            <GearIcon />
          </IconButton>
          <IconButton size="sm" type="button" on={starred} className={starred ? 'starred' : ''} title={starred ? 'Unstar' : 'Star, to keep it at the top'} aria-label={starred ? `Unstar ${i.name}` : `Star ${i.name}`} aria-pressed={starred} onClick={() => onStar(i.key, !starred)}>
            <StarIcon on={starred} />
          </IconButton>
        </span>
      </div>
    );
  };

  const none = (
    <div className={`np-row ${sel === NO_FOLDER ? 'on' : ''}`}>
      <button type="button" role="menuitemradio" aria-checked={sel === NO_FOLDER} className="np-main" onClick={() => choose(NO_FOLDER)} title="Just chat. Claude works in a scratch folder.">
        <LaptopIcon />
        <span className="menu-label">No folder</span>
        {sel === NO_FOLDER && <span className="check">✓</span>}
      </button>
    </div>
  );

  return (
    <div className="menu-wrap np" ref={root}>
      <button type="button" className={`np-chip ${open ? 'open' : ''}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open} title="Where Claude works">
        {sel.startsWith(ENV) ? <EnvIcon /> : sel === NO_FOLDER ? <LaptopIcon /> : <FolderIcon />}
        <span className="ellipsis">{label}</span>
        <Chev dir="down" />
      </button>
      {open && (
        <Menu place="up" className="np-pop" aria-label="Choose where Claude works">
          <input
            className="np-search"
            autoFocus={!window.matchMedia('(pointer: coarse)').matches}
            placeholder="Search environments and folders"
            value={q}
            onChange={(e) => (setQ(e.target.value), setMore(false))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (matches[0]) choose(matches[0].key);
                else if (needle && showNone) choose(NO_FOLDER);
              }
            }}
            aria-label="Search environments and folders"
          />
          <div className="np-list">
            {needle ? (
              <>
                {showNone && none}
                {matches.map(row)}
                {!matches.length && !showNone && <div className="pad muted">Nothing matches</div>}
              </>
            ) : more ? (
              <>
                <button type="button" className="np-back" onClick={() => setMore(false)}>
                  <Chev dir="left" />
                  <span className="menu-label">All folders and environments</span>
                </button>
                {rest.map(row)}
              </>
            ) : (
              <>
                <div className="np-group">Local</div>
                {none}
                {top.map(row)}
                {rest.length > 0 && (
                  <button type="button" className="np-more" onClick={() => setMore(true)}>
                    <LaptopIcon />
                    <span className="menu-label">More</span>
                    <span className="muted">{rest.length}</span>
                    <Chev />
                  </button>
                )}
              </>
            )}
          </div>
          <div className="sep" />
          <button type="button" onClick={() => (close(), onNewFolder())}>
            <FolderIcon />
            <span className="menu-label">New folder</span>
          </button>
          <button type="button" onClick={() => (close(), onClone())}>
            <GitIcon />
            <span className="menu-label">Clone from git</span>
          </button>
          <button type="button" onClick={() => (close(), onNewEnv())}>
            <span className="np-plus">＋</span>
            <span className="menu-label">New environment</span>
          </button>
        </Menu>
      )}
    </div>
  );
}
