// Quote-reply helpers: a quoted passage travels to Claude as a Markdown blockquote at the top of the message.

export function quoteMd(text) {
  return text
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

export function withQuote(quote, reply) {
  if (!quote) return reply;
  return `${quoteMd(quote)}\n\n${reply}`;
}

// Split a user message into its leading blockquote (if any) and the rest, for the bubble.
export function splitQuote(text) {
  const m = /^((?:>[^\n]*(?:\n|$))+)\n*/.exec(text || '');
  if (!m) return [null, text];
  const quote = m[1]
    .trimEnd()
    .split('\n')
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n');
  return [quote, text.slice(m[0].length)];
}
