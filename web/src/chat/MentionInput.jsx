import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { mentionIconMarkup, mentionLabel, splitMentions } from './mentions.jsx';

/**
 * The composer's text box: a plain-text editor that shows @-mentions as chips, like Claude Desktop.
 *
 * The value is still plain text ("@chat:Name @src/app.js fix this"), so what Claude gets is unchanged.
 * Typing edits the DOM directly; whenever the value changes from outside (a suggestion picked, a
 * draft restored, the box cleared) the DOM is rebuilt from the text and mention tokens become
 * chips. A chip is one non-editable unit: Backspace removes all of it.
 *
 * The ref mimics the bits of a textarea the composer used: focus() and setSelectionRange().
 */

/** Text for a DOM subtree: text nodes as is, chips as their token, <br> as a newline. */
function serialize(node) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType !== 1) continue;
      else if (c.dataset.token) out += c.dataset.token;
      else if (c.nodeName === 'BR') out += c.dataset.ph ? '' : '\n';
      else {
        // A browser may still wrap a line in a <div> (some mobile keyboards); treat it as a new line.
        if (/^(DIV|P)$/.test(c.nodeName) && out && !out.endsWith('\n')) out += '\n';
        if (c.childNodes.length === 1 && c.firstChild.nodeName === 'BR') continue;
        walk(c);
      }
    }
  };
  walk(node);
  return out;
}

function chipNode(part, chats) {
  const { label } = mentionLabel(part, chats);
  const el = document.createElement('span');
  el.className = `mention ${part.kind}`;
  el.contentEditable = 'false';
  el.dataset.token = part.token;
  el.title = part.kind === 'chat' ? `Chat: ${label}` : part.value;
  el.innerHTML = mentionIconMarkup(part.kind);
  const l = document.createElement('span');
  l.className = 'mention-label';
  l.textContent = label;
  el.appendChild(l);
  return el;
}

/** A trailing newline doesn't show a new line in a contenteditable, so add a placeholder <br>. */
function fixTrailing(root) {
  const last = root.lastChild;
  const wants = serialize(root).endsWith('\n');
  const has = last?.nodeName === 'BR' && last.dataset.ph;
  if (wants && !has) {
    const br = document.createElement('br');
    br.dataset.ph = '1';
    root.appendChild(br);
  } else if (!wants && has) last.remove();
}

function render(root, text, chats, known) {
  root.textContent = '';
  for (const p of splitMentions(text, known)) root.appendChild(typeof p === 'string' ? document.createTextNode(p) : chipNode(p, chats));
  fixTrailing(root);
}

/** Text offset of the caret (or of a given DOM point). */
function offsetOf(root, node, off) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, off);
  const div = document.createElement('div');
  div.appendChild(r.cloneContents());
  return serialize(div).length;
}

function caretOffset(root) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.focusNode)) return serialize(root).length;
  return offsetOf(root, sel.focusNode, sel.focusOffset);
}

/** Put the caret at a text offset. */
function setCaret(root, pos) {
  let left = pos;
  const sel = window.getSelection();
  const r = document.createRange();
  for (const c of root.childNodes) {
    const len = c.nodeType === 3 ? c.data.length : c.dataset?.token ? c.dataset.token.length : c.nodeName === 'BR' && !c.dataset.ph ? 1 : 0;
    if (c.nodeType === 3 && left <= len) {
      r.setStart(c, left);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    if (c.nodeType !== 3 && left < len) {
      // Inside a chip: go after it.
      r.setStartAfter(c);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    left -= len;
    if (left === 0 && c.nodeType !== 3) {
      r.setStartAfter(c);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
  }
  r.selectNodeContents(root);
  r.collapse(false);
  // Stay before a trailing placeholder <br>.
  if (root.lastChild?.dataset?.ph) r.setStartBefore(root.lastChild), r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

const insertText = (t) => {
  // execCommand keeps the browser's undo stack, but turns newlines into <br>/<div>, so text with
  // newlines (and browsers without it) go in as a plain text node.
  if (!t.includes('\n') && document.execCommand?.('insertText', false, t)) return;
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const n = document.createTextNode(t);
  r.insertNode(n);
  r.setStartAfter(n);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
};

const MentionInput = forwardRef(function MentionInput({ value, onChange, onKeyDown, onBlur, onPaste, placeholder, chats, known, className = '' }, ref) {
  const el = useRef(null);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    setSelectionRange: (_a, b) => el.current && setCaret(el.current, b),
    get selectionStart() {
      return el.current ? caretOffset(el.current) : 0;
    },
    get element() {
      return el.current;
    },
  }));

  // Rebuild the DOM when the text changed from outside (not from typing in the box).
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || serialize(root) === value) return;
    const focused = document.activeElement === root;
    const pos = focused ? caretOffset(root) : null;
    render(root, value, chatsRef.current, known);
    if (focused) setCaret(root, Math.min(pos, value.length));
  });

  // Chat titles can load after the box: relabel chat chips then.
  useLayoutEffect(() => {
    el.current?.querySelectorAll('.mention.chat').forEach((chip) => {
      const label = mentionLabel({ kind: 'chat', value: chip.dataset.token.slice(1) }, chats).label;
      const l = chip.querySelector('.mention-label');
      if (l && l.textContent !== label) l.textContent = label;
    });
  }, [chats]);

  // Keep the content flat (text, chips, newlines) instead of the browser's <div> lines. This needs
  // the native beforeinput event: React's onBeforeInput is a keypress polyfill that can't cancel it.
  const emitRef = useRef(null);
  useEffect(() => {
    const root = el.current;
    const onBefore = (e) => {
      if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;
      e.preventDefault();
      insertText('\n');
      emitRef.current();
    };
    root.addEventListener('beforeinput', onBefore);
    return () => root.removeEventListener('beforeinput', onBefore);
  }, []);

  const emit = () => {
    const root = el.current;
    // An emptied box can keep a stray <br>; clear it so the placeholder shows.
    if (!root.textContent && !root.querySelector('.mention')) root.textContent = '';
    else fixTrailing(root);
    onChange(serialize(root), caretOffset(root));
  };
  emitRef.current = emit;

  return (
    <div
      ref={el}
      className={`mention-input ${value ? '' : 'empty'} ${className}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      spellCheck
      onInput={emit}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onPaste={(e) => {
        onPaste?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        insertText(e.clipboardData.getData('text/plain'));
        emit();
      }}
      onCopy={(e) => {
        // Copy the tokens, not the chip labels.
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const div = document.createElement('div');
        div.appendChild(sel.getRangeAt(0).cloneContents());
        e.clipboardData.setData('text/plain', serialize(div));
        e.preventDefault();
      }}
      onCut={(e) => {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const div = document.createElement('div');
        div.appendChild(sel.getRangeAt(0).cloneContents());
        e.clipboardData.setData('text/plain', serialize(div));
        e.preventDefault();
        insertText('');
        emit();
      }}
      onDrop={(e) => {
        // Files dropped on the composer are handled by it; dropped text goes in as plain text.
        if (e.dataTransfer?.files?.length) return;
        const t = e.dataTransfer?.getData('text/plain');
        if (t == null) return;
        e.preventDefault();
        insertText(t);
        emit();
      }}
    />
  );
});

export default MentionInput;
