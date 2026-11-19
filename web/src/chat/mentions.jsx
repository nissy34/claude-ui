import React from 'react';
import Linkify from './Linkify.jsx';

/**
 * @-mentions in messages: "@chat:Some-chat-name" for another chat and "@path/to/file" for a file.
 * The text sent to Claude keeps these tokens as they are; the composer and the sent bubble show
 * them as chips (icon + short name, full token on hover).
 */

/** The token a chat is mentioned by (without the leading @). */
export const chatToken = (c) => 'chat:' + c.name.trim().replace(/\s+/g, '-').replace(/[^\w.\-֐-׿]/g, '').slice(0, 30);

// "@" at the start or after whitespace, then a run of non-space characters.
const AT_RE = /(^|\s)@([^\s@]+)/g;

/** Drop sentence punctuation from the end of a token ("see @a/b.js," -> "@a/b.js"). */
function trimToken(t) {
  return t.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * Split text into strings and mention parts { token, kind: 'chat' | 'file' | 'folder', value }.
 * A token counts as a mention when it is a chat token, looks like a path (has a / or a .), or is
 * in `known` (tokens the composer inserted from its suggestions, such as "@Makefile").
 */
export function splitMentions(text, known) {
  const s = String(text ?? '');
  const out = [];
  if (!s.includes('@')) return s ? [s] : out;
  let at = 0;
  for (const m of s.matchAll(AT_RE)) {
    const start = m.index + m[1].length;
    let value = m[2];
    const isChat = /^chat:./.test(value);
    if (!known?.has('@' + value)) value = trimToken(value);
    if (!value || value === 'chat:') continue;
    if (!isChat && !known?.has('@' + value) && !/[\\/]|\.[^.]/.test(value)) continue;
    if (start > at) out.push(s.slice(at, start));
    out.push({ token: '@' + value, value, kind: isChat ? 'chat' : /[\\/]$/.test(value) ? 'folder' : 'file' });
    at = start + 1 + value.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/** What a mention chip shows: the chat's title, or a file's base name. */
export function mentionLabel(part, chats) {
  if (part.kind === 'chat') {
    const c = (chats || []).find((x) => chatToken(x) === part.value);
    return { label: c?.name || part.value.slice(5).replace(/-/g, ' '), chat: c };
  }
  const trimmed = part.value.replace(/[\\/]+$/, '');
  return { label: trimmed.split(/[\\/]/).pop() || part.value };
}

const ICON = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true };
const PATHS = {
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />,
  file: <path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" strokeLinejoin="round" />,
  folder: <path d="M1.8 3.5h4.2l1.4 1.6h6.8v7.4H1.8z" strokeLinejoin="round" />,
};

/** The icon inside a chip, as React. */
export function MentionIcon({ kind, className = 'mention-ico' }) {
  return (
    <svg {...ICON} className={className}>
      {PATHS[kind] || PATHS.file}
    </svg>
  );
}

// The same icons as SVG markup, for chips the composer builds outside React.
const SVG_MARKUP = {
  chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" stroke-linejoin="round"/>',
  folder: '<path d="M1.8 3.5h4.2l1.4 1.6h6.8v7.4H1.8z" stroke-linejoin="round"/>',
};
export const mentionIconMarkup = (kind) =>
  `<svg class="mention-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${SVG_MARKUP[kind] || SVG_MARKUP.file}</svg>`;

/** Plain text with @-mentions shown as chips and bare URLs as links (the sent message bubble). */
export function MentionText({ text, chats, onOpenChat }) {
  const parts = splitMentions(text);
  if (!parts.some((p) => typeof p !== 'string')) return <Linkify text={text} />;
  return parts.map((p, i) => {
    if (typeof p === 'string') return <Linkify key={i} text={p} />;
    const { label, chat } = mentionLabel(p, chats);
    const open = p.kind === 'chat' && chat && onOpenChat ? () => onOpenChat(chat.id) : null;
    const Tag = open ? 'button' : 'span';
    return (
      <Tag key={i} className={`mention ${p.kind}`} title={p.kind === 'chat' ? `Chat: ${chat?.name || label}${open ? ' (click to open)' : ''}` : p.value} onClick={open || undefined} type={open ? 'button' : undefined}>
        <MentionIcon kind={p.kind} />
        <span className="mention-label">{label}</span>
      </Tag>
    );
  });
}
