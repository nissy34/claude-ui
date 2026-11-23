/**
 * Drag-to-resize for side columns (left chat sidebar, right panels).
 *
 *   const rs = useResizable('panel', { edge: 'left', min: 320, max: () => innerWidth - 480 });
 *   <aside ref={rs.ref} style={rs.style}> {rs.handle} … </aside>
 *
 * The width lives in a CSS variable (--<name>-w) that the column's own rule reads with
 * its default as the fallback, e.g. `.side-panel { width: var(--panel-w, min(46%, 640px)) }`.
 * So the phone layout, which sets `width` outright in a media query, is untouched, and an
 * untouched column keeps its default. Widths are saved per column in localStorage.
 *
 * edge: which side of the column the handle sits on ('right' for the left sidebar,
 * 'left' for right-hand panels). Drag, or focus the handle and use the arrow keys
 * (Shift for bigger steps, Home/End for min/max). Double-click or Enter resets.
 */
import React, { useEffect, useRef, useState } from 'react';

const KEY = (name) => 'cw.width.' + name;

function readWidth(name) {
  try {
    const v = Number(localStorage.getItem(KEY(name)));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveWidth(name, w) {
  try {
    if (w == null) localStorage.removeItem(KEY(name));
    else localStorage.setItem(KEY(name), String(Math.round(w)));
  } catch {}
}

export function useResizable(name, { edge = 'left', min = 200, max = 800, label = 'Resize panel', ref: outerRef } = {}) {
  const ownRef = useRef(null);
  const ref = outerRef || ownRef;
  const [, bump] = useState(0);
  const cssVar = `--${name}-w`;
  const maxNow = () => Math.max(min, typeof max === 'function' ? max() : max);
  const clamp = (w) => Math.min(maxNow(), Math.max(min, w));
  const saved = readWidth(name);
  const width = saved == null ? null : clamp(saved);

  // A saved width can be too wide for a smaller window: re-clamp when the window changes.
  useEffect(() => {
    if (saved == null) return;
    const on = () => bump((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [saved == null]);

  const set = (w) => {
    saveWidth(name, w == null ? null : clamp(w));
    if (w == null) ref.current?.style.removeProperty(cssVar);
    bump((n) => n + 1);
  };
  const current = () => ref.current?.getBoundingClientRect().width || width || min;
  const sign = edge === 'right' ? 1 : -1;

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    let w = startW;
    const move = (ev) => {
      w = clamp(startW + sign * (ev.clientX - startX));
      // Live updates go straight to the element so the panel's contents don't re-render per pixel.
      el.style.setProperty(cssVar, `${w}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('pane-dragging', 'across');
      if (w !== startW) set(w);
    };
    document.body.classList.add('pane-dragging', 'across');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 64 : 16;
    let next;
    if (e.key === 'ArrowLeft') next = current() - sign * step;
    else if (e.key === 'ArrowRight') next = current() + sign * step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = maxNow();
    else if (e.key === 'Enter') return e.preventDefault(), set(null);
    else return;
    e.preventDefault();
    set(next);
  };

  const handle = (
    <div
      className={`resize-handle edge-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={Math.round(maxNow())}
      aria-valuenow={Math.round(width ?? ref.current?.getBoundingClientRect().width ?? min)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => set(null)}
      onKeyDown={onKeyDown}
    />
  );

  return { ref, style: width == null ? undefined : { [cssVar]: `${width}px` }, handle, width, reset: () => set(null) };
}
