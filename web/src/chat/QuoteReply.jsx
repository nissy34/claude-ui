import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { withQuote } from './quote.js';

// Select text in a message and reply to just that passage, like Claude Desktop.
// Mouse: a popover with the passage and a reply box appears by the selection.
// Touch: a small "Reply" button appears under the selection (clear of the system copy menu)
// and moves the passage into the main message box, where the keyboard has room.

const QUOTABLE = '.msg.assistant .md, .msg.user .bubble, .thinking-body';
const elOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

function ReplyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 3.5 2.5 7.5l4 4" />
      <path d="M2.5 7.5h7a4 4 0 0 1 4 4v1" />
    </svg>
  );
}

export function QuoteMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 9.5C3 6.5 4.6 4.4 7 3.6l.5 1C6 5.3 5.2 6.4 5.1 7.6c.2 0 .4-.1.6-.1 1.2 0 2.1.9 2.1 2.1S6.8 11.8 5.5 11.8C4 11.8 3 10.8 3 9.5zm6 0c0-3 1.6-5.1 4-5.9l.5 1c-1.5.7-2.3 1.8-2.4 3 .2 0 .4-.1.6-.1 1.2 0 2.1.9 2.1 2.1s-1 2.2-2.3 2.2C10 11.8 9 10.8 9 9.5z" />
    </svg>
  );
}

export default function QuoteReply({ listRef, onSend, onQuote, disabled }) {
  const [pop, setPop] = useState(null); // { text, range, touch }
  const [reply, setReply] = useState('');
  const [, setTick] = useState(0);
  const popRef = useRef(null);
  const taRef = useRef(null);
  const mouseDown = useRef(false);
  const lastPointer = useRef('mouse');
  const engaged = useRef(false); // a press inside the popover is in progress
  const state = useRef({});
  state.current = { pop, reply };

  const close = useCallback(() => {
    setPop(null);
    setReply('');
  }, []);

  const read = () => {
    const sel = window.getSelection();
    const list = listRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !list) return null;
    const range = sel.getRangeAt(0);
    const a = elOf(range.startContainer)?.closest(QUOTABLE);
    const b = elOf(range.endContainer)?.closest(QUOTABLE);
    if (!a || !b || !list.contains(a) || !list.contains(b)) return null;
    const text = sel.toString().replace(/\n{3,}/g, '\n\n').trim();
    return text ? { text, range: range.cloneRange() } : null;
  };

  useEffect(() => {
    let timer;
    const evaluate = () => {
      if (mouseDown.current) return;
      const got = read();
      const { pop: cur, reply: typed } = state.current;
      if (got) {
        if (!cur || cur.text !== got.text) {
          setReply('');
          setPop({ ...got, touch: lastPointer.current !== 'mouse' });
        }
        return;
      }
      // Selection went away: keep the popover while someone is using it.
      if (!cur || engaged.current || typed.trim()) return;
      if (popRef.current?.contains(document.activeElement)) return;
      close();
    };
    const onSel = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 120);
    };
    const onDown = (e) => {
      lastPointer.current = e.pointerType || 'mouse';
      if (popRef.current?.contains(e.target)) {
        engaged.current = true;
        return;
      }
      if (e.pointerType === 'mouse' && e.button === 0) mouseDown.current = true;
      // A press elsewhere dismisses an untouched popover; a new selection brings it back.
      const { pop: cur, reply: typed } = state.current;
      if (cur && !typed.trim()) close();
    };
    const onUp = () => {
      mouseDown.current = false;
      setTimeout(() => (engaged.current = false), 400);
      onSel();
    };
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    };
  }, [listRef, close]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the passage as the chat scrolls or the window resizes.
  useEffect(() => {
    if (!pop) return;
    const list = listRef.current;
    const bump = () => setTick((t) => t + 1);
    list?.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    window.visualViewport?.addEventListener('resize', bump);
    return () => {
      list?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      window.visualViewport?.removeEventListener('resize', bump);
    };
  }, [pop, listRef]);

  // Keep the passage highlighted after focus moves into the reply box.
  useEffect(() => {
    if (!hasHighlights || !pop || pop.touch) return;
    CSS.highlights.set('cw-quote', new Highlight(pop.range));
    return () => CSS.highlights.delete('cw-quote');
  }, [pop]);

  // Start typing while the popover is up and the keys go to the reply box (copy shortcuts still work).
  useEffect(() => {
    if (!pop || pop.touch) return;
    const onKey = (e) => {
      if (e.key === 'Escape') return close();
      const t = e.target;
      if (t.closest?.('textarea, input, [contenteditable="true"]')) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) taRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pop, close]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }, [reply]);

  if (!pop || !listRef.current) return null;

  const rects = [...pop.range.getClientRects()].filter((r) => r.width || r.height);
  const box = pop.range.getBoundingClientRect();
  if (!rects.length && !box.width) return null;
  const first = rects[0] || box;
  const last = rects[rects.length - 1] || box;
  const lr = listRef.current.getBoundingClientRect();
  const vw = window.innerWidth;

  const finish = () => {
    window.getSelection()?.removeAllRanges();
    close();
  };
  const toComposer = () => {
    onQuote(pop.text);
    finish();
  };
  const sendReply = () => {
    if (!reply.trim() || disabled) return;
    if (onSend(withQuote(pop.text, reply.trim())) !== false) finish();
  };

  let style;
  if (pop.touch) {
    // Under the selection: the system copy/paste menu sits above it.
    const w = 128;
    const top = Math.min(Math.max(last.bottom + 14, lr.top + 8), lr.bottom - 52);
    const left = Math.min(Math.max(last.right - w / 2, 8), vw - w - 8);
    style = { top, left };
  } else {
    const w = Math.min(380, vw - 16);
    const h = popRef.current?.offsetHeight || 112;
    const left = Math.min(Math.max(box.left + box.width / 2 - w / 2, 8), vw - w - 8);
    let top = first.top - h - 8;
    if (top < lr.top + 4) top = last.bottom + 8;
    top = Math.min(Math.max(top, lr.top + 4), lr.bottom - h - 4);
    style = { top, left, width: w };
  }

  return createPortal(
    pop.touch ? (
      <div className="qr-pill" ref={popRef} style={style}>
        <button onClick={toComposer}>
          <ReplyIcon /> Reply
        </button>
      </div>
    ) : (
      <div className="qr-pop" ref={popRef} style={style} role="dialog" aria-label="Reply to the selected text">
        <div className="qr-quote">{pop.text}</div>
        <div className="qr-row">
          <textarea
            ref={taRef}
            rows={1}
            value={reply}
            placeholder="Write a reply"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendReply();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          <button className="qr-btn" title="Quote in the message box instead" onClick={toComposer}>
            <QuoteMark />
          </button>
          <button className="qr-btn qr-send" title="Send reply (Enter)" disabled={!reply.trim() || disabled} onClick={sendReply}>
            <ReplyIcon />
          </button>
        </div>
      </div>
    ),
    document.body
  );
}
