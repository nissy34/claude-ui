import React from 'react';

// Bare http(s) URLs in plain text. Stops at whitespace, quotes and angle brackets;
// trailing punctuation is trimmed afterwards in trimUrl().
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

const PAIRS = { ')': '(', ']': '[', '}': '{' };

/** Drop sentence punctuation and unbalanced closing brackets from the end of a URL match. */
export function trimUrl(url) {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?*]/.test(last)) {
      u = u.slice(0, -1);
    } else if (PAIRS[last]) {
      const opens = u.split(PAIRS[last]).length - 1;
      const closes = u.split(last).length - 1;
      if (closes > opens) u = u.slice(0, -1);
      else break;
    } else break;
  }
  return u;
}

/** Split text into strings and { url } parts. */
export function splitLinks(text) {
  const out = [];
  const s = String(text ?? '');
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length <= 'https://'.length) continue;
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push({ url });
    at = m.index + url.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/** Renders plain text with bare URLs turned into links that open in a new tab. */
export default function Linkify({ text }) {
  if (!text || !/https?:\/\//i.test(text)) return text || null;
  return splitLinks(text).map((p, i) =>
    typeof p === 'string' ? (
      <React.Fragment key={i}>{p}</React.Fragment>
    ) : (
      <a key={i} className="autolink" href={p.url} target="_blank" rel="noopener noreferrer">
        {p.url}
      </a>
    ),
  );
}
