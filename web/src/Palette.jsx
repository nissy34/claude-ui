// Search palette (Ctrl/⌘ K), like Desktop's: chats, words in chats, projects, files in the open
// chat's folder, artifacts, scheduled tasks and app actions, in one list you drive from the keyboard.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo } from './api.js';
import { setThemePref, getThemePref } from './theme.js';

const RECENT_KEY = 'cw.recentChats';

export function rememberChat(id) {
  if (!id) return;
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list].slice(0, 20)));
  } catch {}
}

function recentIds() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;

function Hl({ text, q }) {
  if (!q || !text) return text || null;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export default function Palette({ sessions, cprojects = [], active, onClose, onSelect, onOpenProject, onOpenArtifact, onOpenFile, actions }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState({ messages: [], artifacts: [], schedules: [], files: [], q: '' });
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const needle = q.trim().replace(/^>\s*/, '');
  const actionsOnly = q.trim().startsWith('>');

  useEffect(() => inputRef.current?.focus(), []);

  // Words in chats, artifacts and scheduled tasks come from the server; files from the open chat's folder.
  useEffect(() => {
    if (actionsOnly || needle.length < 2) return setRemote({ messages: [], artifacts: [], schedules: [], files: [], q: needle });
    let stop = false;
    const t = setTimeout(async () => {
      const [found, files] = await Promise.all([
        api(`/api/search?q=${encodeURIComponent(needle)}`).catch(() => ({})),
        active && active.kind === 'chat' && !active.noFolder ? api(`/api/files?session=${active.id}&q=${encodeURIComponent(needle)}`).catch(() => ({})) : {},
      ]);
      if (!stop) setRemote({ messages: found.messages || [], artifacts: found.artifacts || [], schedules: found.schedules || [], files: (files.files || []).slice(0, 8), q: needle });
    }, 140);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [needle, actionsOnly, active]);

  const items = useMemo(() => {
    const lower = needle.toLowerCase();
    const has = (...parts) => parts.join(' ').toLowerCase().includes(lower);
    const chats = sessions.filter((s) => s.kind === 'chat' && !s.cproject);
    const out = [];
    const add = (section, list) => list.forEach((it) => out.push({ section, ...it }));
    const chatItem = (s) => ({
      key: 'c:' + s.id,
      icon: '◌',
      label: s.name,
      sub: `${s.noFolder ? 'No folder' : base(s.project || s.cwd)}${s.archived ? ' · archived' : ''}`,
      meta: timeAgo(s.lastActivity),
      run: () => onSelect(s.id),
    });
    const acts = actions.filter((a) => !needle || has(a.label, a.keywords || ''));

    if (!needle) {
      const byId = new Map(chats.map((s) => [s.id, s]));
      const recent = recentIds()
        .map((id) => byId.get(id))
        .filter((s) => s && !s.archived && s.id !== active?.id);
      for (const s of [...chats].filter((s) => !s.archived).sort((a, b) => b.lastActivity - a.lastActivity)) if (recent.length < 6 && !recent.includes(s) && s.id !== active?.id) recent.push(s);
      if (!actionsOnly) add('Recent chats', recent.slice(0, 6).map(chatItem));
      add('Actions', acts);
      return out;
    }
    if (actionsOnly) {
      add('Actions', acts);
      return out;
    }
    add(
      'Chats',
      chats
        .filter((s) => has(s.name, s.cwd))
        .sort((a, b) => !!a.archived - !!b.archived || b.lastActivity - a.lastActivity)
        .slice(0, 8)
        .map(chatItem),
    );
    add(
      'Projects',
      cprojects
        .filter((p) => has(p.name || '', p.description || ''))
        .slice(0, 5)
        .map((p) => ({ key: 'p:' + p.id, icon: '▣', label: p.name, sub: 'Project', run: () => onOpenProject(p.id) })),
    );
    add('Actions', acts.slice(0, 5));
    if (remote.q === needle) {
      add(
        'In chats',
        remote.messages
          .filter((m) => !m.cproject)
          .map((m, i) => ({
            key: `m:${m.sessionId}:${i}`,
            icon: m.who === 'you' ? '›' : '✳',
            label: m.snippet,
            sub: `${m.who === 'you' ? 'You' : 'Claude'} in ${m.name}`,
            meta: m.ts ? timeAgo(m.ts) : '',
            run: () => onSelect(m.sessionId),
            wrap: true,
          })),
      );
      add(
        `Files in ${active ? base(active.cwd) : 'this chat'}`,
        remote.files.map((f) => ({ key: 'f:' + f, icon: '▤', label: base(f), sub: f, mono: true, run: () => onOpenFile(active.id, f) })),
      );
      add(
        'Artifacts',
        remote.artifacts.map((a) => ({ key: 'a:' + a.sessionId + a.path, icon: '◇', label: a.title || a.name, sub: `${a.name} · ${a.sessionName}`, meta: a.mtime ? timeAgo(a.mtime) : '', run: () => onOpenArtifact(a) })),
      );
      add(
        'Scheduled',
        remote.schedules.map((t) => ({ key: 't:' + t.id, icon: '◷', label: t.name || t.prompt, sub: t.prompt, run: () => actions.find((a) => a.id === 'scheduled')?.run() })),
      );
    }
    return out;
  }, [needle, actionsOnly, sessions, cprojects, remote, active, actions, onSelect, onOpenProject, onOpenArtifact, onOpenFile]);

  useEffect(() => setSel(0), [needle]);
  useEffect(() => {
    listRef.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (it) => {
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) (e.preventDefault(), setSel((i) => Math.min(items.length - 1, i + 1)));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
    else if (e.key === 'Enter') (e.preventDefault(), run(items[sel]));
    else if (e.key === 'Escape') (e.preventDefault(), onClose());
  };

  const loading = needle.length >= 2 && !actionsOnly && remote.q !== needle;
  let last = null;
  return (
    <div className="pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="pal-input">
          <span className="pal-ico">⌕</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Search chats, files, artifacts… or > for actions" aria-label="Search" spellCheck={false} />
          {loading && <span className="pal-spin" />}
          <kbd className="pal-esc" onClick={onClose}>
            Esc
          </kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {items.map((it, i) => {
            const head = it.section !== last ? <div className="pal-section">{it.section}</div> : null;
            last = it.section;
            return (
              <React.Fragment key={it.key}>
                {head}
                <button className={`pal-item ${i === sel ? 'sel' : ''} ${it.wrap ? 'wrap' : ''}`} onMouseMove={() => sel !== i && setSel(i)} onClick={() => run(it)}>
                  <span className="pal-item-ico">{it.icon}</span>
                  <span className="pal-item-main">
                    <span className={`pal-item-label ${it.mono ? 'mono' : ''}`}>
                      <Hl text={it.label} q={needle} />
                    </span>
                    {it.sub && <span className="pal-item-sub">{it.sub}</span>}
                  </span>
                  {it.kbd ? <kbd>{it.kbd}</kbd> : it.meta ? <span className="pal-item-meta">{it.meta}</span> : null}
                </button>
              </React.Fragment>
            );
          })}
          {!items.length && !loading && <div className="pal-empty">Nothing matches “{needle}”.</div>}
        </div>
        <div className="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>&gt;</kbd> actions
          </span>
        </div>
      </div>
    </div>
  );
}

export function themeActions() {
  const cur = getThemePref();
  return ['light', 'dark', 'system']
    .filter((t) => t !== cur)
    .map((t) => ({ id: 'theme-' + t, icon: '◐', label: `Theme: ${t[0].toUpperCase() + t.slice(1)}`, keywords: 'appearance dark light mode', run: () => setThemePref(t) }));
}
