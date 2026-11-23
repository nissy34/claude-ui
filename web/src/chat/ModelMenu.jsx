import React, { useEffect, useRef, useState } from 'react';
import { modelLabel, useModels } from '../models.js';
import { Menu, useDismiss } from '../ui/index.jsx';
import { promptDialog } from '../ui/dialogs.jsx';

function ModelItem({ m, on, kbd, onPick }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} className={on ? 'on' : ''} onClick={onPick}>
      <span className="check">{on ? '✓' : ''}</span>
      <span className="menu-label">
        {m.displayName}
        {m.description && <span className="desc">{m.description}</span>}
      </span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

/**
 * The model chip and its menu, shared by a chat's composer, the project chat and a project thread.
 * The main models are numbered: with the menu open, 1–9 picks one. Full model ids sit under
 * "More models", and "Other model…" takes any name or alias.
 *
 * value: the picked id ('' = default). active: the model actually running (for the label).
 * open/onOpen: pass both to control the menu (the chat composer shares one open-menu slot);
 * otherwise it manages itself. note: a muted line under the list. footer: extra rows at the end.
 */
export default function ModelMenu({ value, active, onPick, open: openIn, onOpen, note, footer, className = 'chip', title, wrapClassName = '', align }) {
  const models = useModels();
  const [openSelf, setOpenSelf] = useState(false);
  const controlled = onOpen != null;
  const open = controlled ? !!openIn : openSelf;
  const setOpen = controlled ? onOpen : setOpenSelf;
  const [more, setMore] = useState(false);
  const wrap = useRef(null);
  useDismiss(open && !controlled, () => setOpenSelf(false), wrap);
  useEffect(() => {
    if (!open) setMore(false);
  }, [open]);

  const picked = value || '';
  const main = models.length ? models.filter((m) => !m.id.startsWith('claude-') || m.id === picked) : [{ id: '', displayName: 'Default', description: '' }];
  const extra = models.filter((m) => m.id.startsWith('claude-') && m.id !== picked);
  const choose = (id) => {
    setOpen(false);
    if (id !== picked) onPick(id);
  };

  // 1–9 picks a numbered model while the menu is open (not while typing somewhere).
  const mainRef = useRef(main);
  mainRef.current = main;
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const m = mainRef.current[Number(e.key) - 1];
      if (!m) return;
      e.preventDefault();
      choose(m.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`menu-wrap ${wrapClassName}`} ref={wrap}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // Keep focus in the composer so typing goes on, but let the number keys reach the menu.
          e.currentTarget.focus();
          setOpen(!open);
        }}
        title={title || (active ? `Running ${active}` : 'Model')}
      >
        {modelLabel(models, picked, active)} <span className="chev">▾</span>
      </button>
      {open && (
        <Menu place="up" align={align} className="model-pop">
          {main.map((m, i) => (
            <ModelItem key={m.id} m={m} on={m.id === picked} kbd={i < 9 ? String(i + 1) : null} onPick={() => choose(m.id)} />
          ))}
          {extra.length > 0 && (
            <>
              <div className="sep" />
              <button type="button" onClick={() => setMore(!more)}>
                <span className="check" />
                <span className="menu-label">More models</span> <span className="chev">{more ? '▴' : '▸'}</span>
              </button>
              {more && extra.map((m) => <ModelItem key={m.id} m={m} on={false} onPick={() => choose(m.id)} />)}
            </>
          )}
          <div className="sep" />
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              const v = await promptDialog('Model name or alias', picked, {
                ok: 'Use model',
                placeholder: 'e.g. sonnet or claude-sonnet-5-5',
              });
              if (v != null && v.trim() !== picked) onPick(v.trim());
            }}
          >
            <span className="check" />
            <span className="menu-label">Other model…</span>
          </button>
          {typeof footer === 'function' ? footer(() => setOpen(false)) : footer}
          {note && (
            <>
              <div className="sep" />
              <div className="model-note">{note}</div>
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
