import React from 'react';

// Keys that phones don't have, laid out for Claude Code's TUI.
const KEYS = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '⇧Tab', seq: '\x1b[Z', title: 'Cycle permission mode' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '⏎', seq: '\r' },
  { label: '^C', seq: '\x03', title: 'Interrupt' },
  { label: '/', seq: '/' },
  { label: '1', seq: '1' },
  { label: '2', seq: '2' },
  { label: '3', seq: '3' },
];

export default function KeyBar({ onKey, ctrl, onCtrl, onPaste }) {
  // preventDefault on pointerdown keeps the on-screen keyboard from closing.
  const keep = (e) => e.preventDefault();
  return (
    <div className="keybar">
      <button className={`key ${ctrl ? 'on' : ''}`} onPointerDown={keep} onClick={onCtrl} title="Ctrl: applies to the next key you type">
        Ctrl
      </button>
      {KEYS.map((k) => (
        <button key={k.label} className="key" title={k.title} onPointerDown={keep} onClick={() => onKey(k.seq)}>
          {k.label}
        </button>
      ))}
      <button className="key" onPointerDown={keep} onClick={onPaste}>
        Paste
      </button>
    </div>
  );
}
