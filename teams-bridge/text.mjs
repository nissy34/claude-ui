// What the Teams bridge writes into the chat, and how it reads your replies.

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Light Markdown to Teams HTML: paragraphs, line breaks, **bold**, `code`, code blocks. */
export function md(text) {
  const parts = String(text ?? '').split(/```[^\n]*\n?/);
  return parts
    .map((p, i) =>
      i % 2
        ? `<pre>${esc(p.replace(/\n$/, ''))}</pre>`
        : esc(p)
            .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
    )
    .join('');
}

/** Teams HTML (or plain text) back to plain text. */
export function plain(html) {
  return String(html ?? '')
    .replace(/<attachment[^>]*><\/attachment>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const where = (x) => {
  const s = x.session;
  if (s?.project) return `${esc(s.project.name)}${s.thread && s.thread !== 'coordinator' ? ` · ${esc(s.thread)}` : ''}`;
  if (x.project) return `${esc(x.project.name)}${x.thread && x.thread !== 'coordinator' ? ` · ${esc(x.thread)}` : ''}`;
  return esc(s?.name || 'chat');
};

export const TAG = '<b>Claude</b> ›';
const how = (code, words) => `<br><i>Reply to this message with ${words}.</i>`;

/** The message for something waiting on you. `code` is the short number you can reply with. */
export function askHtml(item, code, { allowPermissions = true } = {}) {
  const head = `${TAG} ${where(item)}`;
  switch (item.kind) {
    case 'question': {
      const qs = item.questions || [];
      const body = qs
        .map((q, qi) => {
          const opts = (q.options || []).map((o, i) => `${i + 1}. ${esc(o.label)}${o.description ? ` · <i>${esc(clip(o.description, 120))}</i>` : ''}`).join('<br>');
          return `${qs.length > 1 ? `<b>Q${qi + 1}.</b> ` : ''}${esc(q.question)}${q.multiSelect ? ' <i>(pick one or more, comma separated)</i>' : ''}<br>${opts}`;
        })
        .join('<br><br>');
      return `${head} asks:<br>${body}${how(code, qs.length > 1 ? 'one answer per line (a number or your own words)' : 'a number or your own words')}`;
    }
    case 'decision': {
      const opts = item.options.map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${i === item.recommended ? ' (recommended)' : ''}${o.consequence ? ` · ${esc(o.consequence)}` : ''}`).join('<br>');
      return `${head} needs a decision${item.irreversible ? ' <b>(cannot be undone)</b>' : ''}:<br>${esc(item.question)}<br>${opts}${how(code, 'a number')}`;
    }
    case 'signin':
      return `${head} · <b>${esc(item.server || 'An MCP server')}</b> needs you to sign in.<br>${esc(item.message)}${item.url ? `<br><a href="${esc(item.url)}">${esc(clip(item.url, 120))}</a><br><i>Open the link, then reply <b>done</b>. Reply <b>no</b> to cancel.</i>` : '<br><i>This one is a form: fill it in in the web UI.</i>'}`;
    case 'plan':
      return `${head} has a plan and wants to start:<br>${md(clip(item.detail, 1500))}${allowPermissions ? how(code, '<b>yes</b> to start or <b>no</b> plus what to change') : '<br><i>Approve it in the web UI.</i>'}`;
    default:
      return `${head} wants to use <b>${esc(item.tool)}</b>${item.detail ? `:<br><code>${esc(clip(item.detail, 600))}</code>` : '.'}${allowPermissions ? how(code, `<b>yes</b>${item.canAlways ? ', <b>always</b>' : ''} or <b>no</b> (plus a reason)`) : '<br><i>Approving from Teams is off; answer in the web UI.</i>'}`;
  }
}

export function resolvedHtml(original, answer, by) {
  return `${original}<br><b>✓ ${by === 'bridge' ? 'Answered' : 'Answered in the web UI'}: ${esc(answer)}</b>`;
}

/** How a chat's turn report is headed: "finished" only when nothing is still running in the background. */
export function turnWord(ev) {
  if (ev.isError) return 'stopped with an error';
  if (ev.earlier) return 'update';
  if (ev.running) return `update (${ev.running === 1 ? 'a background task is' : `${ev.running} background tasks are`} still running)`;
  return 'finished';
}

export function postHtml(ev) {
  switch (ev.type) {
    case 'post':
      return `${TAG} <b>${esc(ev.project.name)}</b>:<br>${md(clip(ev.text, 3000))}`;
    case 'turn':
      return `${TAG} <b>${esc(ev.session.name)}</b> ${turnWord(ev)}${ev.text ? `:<br>${md(clip(ev.text, 3000))}` : '.'}`;
    case 'notify':
      return `${TAG} <b>${where(ev)}</b>: ${md(clip(ev.text, 2000))}`;
    default:
      return `${TAG} ${md(ev.text || '')}`;
  }
}

export const HELP = [
  `${TAG} Here's what I understand:`,
  '• Just write what you want: the Assistant works out what you mean ("tell the Claude UI project to add dark mode", "yes to the npm one", "what\'s going on?").',
  '• Reply to one of my messages to answer it or to continue that conversation.',
  '• <b>/waiting</b> posts again everything waiting on you.',
  '• <b>/project &lt;name&gt;: &lt;message&gt;</b> sends to a project coordinator.',
  '• <b>/new &lt;folder&gt;: &lt;task&gt;</b> starts a new chat in a folder. <b>/folders</b> lists folders.',
  '• <b>/to &lt;project or chat&gt;</b> switches who plain text goes to.',
  '• <b>/status</b> shows what is running. <b>/stop &lt;chat&gt;</b> stops a chat.',
].join('<br>');

/** Parse one message you wrote. Returns a command object. */
export function parseCommand(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = /^#(\d+)\s*([\s\S]*)$/.exec(t))) return { cmd: 'answer', code: Number(m[1]), text: m[2].trim() };
  if ((m = /^\/(\w+)\s*([\s\S]*)$/.exec(t))) {
    const name = m[1].toLowerCase();
    const rest = m[2].trim();
    const split = (s) => {
      const i = s.search(/[:\n]/);
      return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    };
    switch (name) {
      case 'new': {
        const [folder, task] = split(rest);
        return { cmd: 'new', folder, text: task };
      }
      case 'project':
      case 'p': {
        const [project, msg] = split(rest);
        return { cmd: 'project', project, text: msg };
      }
      case 'to':
        return { cmd: 'to', name: rest };
      case 'status':
        return { cmd: 'status' };
      case 'stop':
        return { cmd: 'stop', name: rest };
      case 'waiting':
      case 'pending':
        return { cmd: 'waiting' };
      case 'folders':
        return { cmd: 'folders' };
      case 'help':
      case 'start':
        return { cmd: 'help' };
      default:
        return { cmd: 'unknown', name };
    }
  }
  return { cmd: 'text', text: t };
}

/** Turn a reply to a permission prompt into allow / always / deny. Null when it isn't one. */
export function permissionReply(text) {
  const t = String(text || '').trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/[.!]+$/, '');
  if (['yes', 'y', 'ok', 'okay', 'allow', 'approve', 'approved', 'sure', 'go', '1', 'done', 'start'].includes(w)) return { behavior: 'allow' };
  if (['always', 'a', '2'].includes(w)) return { behavior: 'always' };
  if (['no', 'n', 'deny', 'denied', 'stop', 'cancel', '3'].includes(w)) return { behavior: 'deny', text: m[2].trim() };
  return null;
}

/** A quoted passage as a Markdown blockquote above the reply: the same shape the web UI's quote reply sends. */
export function withQuote(quote, reply) {
  const q = String(quote ?? '').trim();
  if (!q) return reply;
  return `${q
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')}\n\n${reply}`;
}

const parseJson = (s) => {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * What a Teams quote reply quotes. Graph marks a reply with a "messageReference" attachment (and an
 * <attachment> tag in the body); some clients put a <blockquote itemtype=".../Reply"> in the body instead.
 * `sent` holds our own messages by id, so a reply to one of them quotes it in full, not just the preview.
 * Returns { quote, text }: the quoted words (or null) and your own words without the quote.
 */
export function replyParts(msg, sent = {}) {
  let html = String(msg?.body?.content ?? '');
  let fromBody = '';
  const bq = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html);
  if (bq) {
    const inner = bq[1];
    const preview = /<p\b[^>]*itemprop=["']?preview["']?[^>]*>([\s\S]*?)<\/p>/i.exec(inner);
    fromBody = plain(preview ? preview[1] : inner.replace(/<(strong|span)\b[^>]*itemprop=["']?(mri|time)["']?[^>]*>[\s\S]*?<\/\1>/gi, ''));
    html = html.slice(0, bq.index) + html.slice(bq.index + bq[0].length);
  }
  const ref = (msg?.attachments || []).find((a) => a.contentType === 'messageReference');
  let quote = '';
  if (ref) {
    const c = parseJson(ref.content) || {};
    const id = c.messageId || ref.id;
    const mine = id && sent[id];
    quote = (mine?.html && plain(mine.html)) || plain(c.messagePreview || '') || fromBody;
  } else quote = fromBody;
  quote = quote.replace(/^Claude ›\s*/, '').trim();
  return { quote: quote ? clip(quote, 2000) : null, text: plain(html) };
}
