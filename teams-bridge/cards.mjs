// Adaptive Cards for the Teams bridge. The bridge posts as you through Graph, so cards are
// read-only (no bot receives button taps): you answer by replying, as with plain messages.
// Links open the web UI when CW_PUBLIC_URL (or TEAMS_UI_LINK) says where it is.
import { turnWord } from './text.mjs';

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const T = (text, o = {}) => ({ type: 'TextBlock', text: String(text ?? ''), wrap: true, ...o });

function whereOf(x) {
  const s = x.session;
  if (s?.project) return `${s.project.name}${s.thread && s.thread !== 'coordinator' ? ` · ${s.thread}` : ''}`;
  if (x.project) return `${x.project.name}${x.thread && x.thread !== 'coordinator' ? ` · ${x.thread}` : ''}`;
  return s?.name || 'chat';
}

function link(base, x) {
  if (!base) return null;
  const b = base.replace(/\/$/, '');
  if (x.session?.id) return `${b}/#s=${x.session.id}`;
  if (x.project?.id) return `${b}/#p=${x.project.id}`;
  return b;
}

function card(body, url, urlTitle = 'Open in web UI') {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    ...(url ? { actions: [{ type: 'Action.OpenUrl', title: urlTitle, url }] } : {}),
  };
}

const header = (code, where, title, tone) => [
  { type: 'TextBlock', text: where, size: 'Small', isSubtle: true, wrap: true, spacing: 'None' },
  T(title, { weight: 'Bolder', size: 'Medium', spacing: 'Small', ...(tone ? { color: tone } : {}) }),
];

const hint = (text) => T(text, { size: 'Small', isSubtle: true, spacing: 'Medium' });

const code = (text) => ({ type: 'Container', style: 'emphasis', spacing: 'Small', items: [T(clip(text, 900), { fontType: 'Monospace', size: 'Small' })] });

/** A card for something waiting on you. Returns null for kinds that read better as text. */
export function askCard(item, n, { allowPermissions = true, uiUrl } = {}) {
  const where = whereOf(item);
  const url = link(uiUrl, item);
  switch (item.kind) {
    case 'permission':
      return card(
        [
          ...header(n, where, `Wants to use ${item.tool}`, 'Warning'),
          ...(item.detail ? [code(item.detail)] : []),
          ...(item.reason ? [T(item.reason, { size: 'Small', isSubtle: true })] : []),
          hint(allowPermissions ? `Reply to this message with yes${item.canAlways ? ', always' : ''} or no (and a reason).` : 'Approving from Teams is off; answer in the web UI.'),
        ],
        url
      );
    case 'plan':
      return card([...header(n, where, 'Has a plan and wants to start', 'Accent'), T(clip(item.detail, 1800), { spacing: 'Small' }), hint(allowPermissions ? 'Reply to this message with yes to start, or no plus what to change.' : 'Approve it in the web UI.')], url);
    case 'question': {
      const qs = item.questions || [];
      const body = [...header(n, where, qs.length > 1 ? 'Has questions' : clip(qs[0]?.question, 300), 'Accent')];
      qs.forEach((q, qi) => {
        if (qs.length > 1) body.push(T(`${qi + 1}. ${q.question}`, { weight: 'Bolder', spacing: 'Medium' }));
        body.push({ type: 'FactSet', spacing: 'Small', facts: (q.options || []).map((o, i) => ({ title: `${i + 1}`, value: o.description ? `**${o.label}** · ${clip(o.description, 140)}` : `**${o.label}**` })) });
        if (q.multiSelect) body.push(T('Pick one or more, comma separated.', { size: 'Small', isSubtle: true, spacing: 'None' }));
      });
      body.push(hint(qs.length > 1 ? 'Reply to this message with one answer per line (a number or your own words).' : 'Reply to this message with a number or your own words.'));
      return card(body, url);
    }
    case 'decision':
      return card(
        [
          ...header(n, where, item.question, 'Accent'),
          ...(item.irreversible ? [T('This cannot be undone.', { color: 'Attention', weight: 'Bolder', size: 'Small', spacing: 'Small' })] : []),
          { type: 'FactSet', spacing: 'Small', facts: item.options.map((o, i) => ({ title: `${i + 1}`, value: `**${o.label}**${i === item.recommended ? ' (recommended)' : ''}${o.consequence ? ` · ${clip(o.consequence, 200)}` : ''}` })) },
          hint('Reply to this message with a number.'),
        ],
        url
      );
    case 'signin':
      return card(
        [
          ...header(n, where, `${item.server || 'An MCP server'} needs you to sign in`, 'Warning'),
          T(clip(item.message, 500), { spacing: 'Small' }),
          hint(item.url ? 'Open the link and sign in, then reply to this message with done (or no to cancel).' : 'This one is a form: fill it in in the web UI.'),
        ],
        item.url || url,
        item.url ? 'Sign in' : 'Open in web UI'
      );
    default:
      return null;
  }
}

/** The same card with the answer shown under it. */
export function answeredCard(c, answer, by) {
  const out = JSON.parse(JSON.stringify(c));
  out.body.push(T(`✓ ${by === 'bridge' ? 'Answered' : 'Answered in the web UI'}: ${answer}`, { color: 'Good', weight: 'Bolder', spacing: 'Medium' }));
  delete out.actions;
  return out;
}

/** Coordinator posts, finished chats, notify_user. */
export function postCard(ev, { uiUrl } = {}) {
  const title = ev.type === 'post' ? ev.project.name : ev.type === 'turn' ? `${ev.session.name} ${turnWord(ev)}` : whereOf(ev);
  return card([T(title, { weight: 'Bolder', color: ev.isError ? 'Attention' : 'Default' }), ...(ev.text ? [T(clip(ev.text, 3000), { spacing: 'Small' })] : [])], link(uiUrl, ev.type === 'post' ? { project: ev.project } : { session: ev.session }));
}

/**
 * The same request with buttons, for a Teams workflow ("Post card in a chat and wait for a response").
 * Each button sends back { cw: nonce, a, n? } plus the inputs; the workflow posts that back as a
 * "cw:{…}" message, which the bridge reads. Null when there is nothing to tap.
 */
export function flowCard(item, nonce, { allowPermissions = true, uiUrl } = {}, reply = null) {
  const base = askCard(item, 0, { allowPermissions, uiUrl });
  if (!base) return null;
  const body = base.body.slice(0, -1); // everything but the "reply to this message" hint
  // `say` is what the workflow's reply shows in the thread ("✅ Yes"); the bridge reads the rest.
  // `done` is the small card the workflow posts after a tap ("✅ Yes"): the workflow puts what you
  // tapped, base64, in place of CWDATA, in a hidden line the bridge reads. Nobody sees JSON.
  const about = clip(item.kind === 'question' ? item.questions?.[0]?.question : item.kind === 'decision' ? item.question : item.kind === 'permission' ? `${item.tool}${item.detail ? `: ${item.detail}` : ''}` : item.kind === 'plan' ? 'The plan' : item.server || '', 160);
  const done = (say) => JSON.stringify({ type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [T(`✅ ${say}`, { weight: 'Bolder' }), ...(about ? [T(about, { size: 'Small', isSubtle: true, spacing: 'None' })] : []), { type: 'TextBlock', text: 'cw64:CWDATA', isVisible: false }] });
  // `reply` (when the bridge knows where the request was posted): each button also carries a ready
  // quote reply to that message (`url` + `post`), which the workflow sends as you through "Send a
  // Microsoft Graph HTTP request". The bridge then reads it like a reply you typed.
  const quote = (text) =>
    JSON.stringify({
      body: { contentType: 'html', content: `<attachment id="${reply.msgId}"></attachment>${text}` },
      attachments: [{ id: reply.msgId, contentType: 'messageReference', contentUrl: null, content: JSON.stringify({ messageId: reply.msgId, messagePreview: clip(reply.preview, 120), messageSender: { user: reply.user || null } }) }],
    });
  const submit = (title, data, style) => {
    const words = { yes: 'yes', always: 'always', no: 'no', choice: String(data.n) }[data.a];
    return { type: 'Action.Submit', title, data: { cw: nonce, say: data.say || title, done: done(data.say || title), ...(reply && words ? { url: reply.url, post: quote(words) } : {}), ...data }, ...(style ? { style } : {}) };
  };
  const actions = [];
  switch (item.kind) {
    case 'permission':
    case 'plan':
      if (!allowPermissions) return null;
      // With quote replies, a reason is a reply you type in the thread.
      if (!reply) body.push({ type: 'Input.Text', id: 'text', isMultiline: true, placeholder: item.kind === 'plan' ? 'What to change (with No)' : 'Reason (with No)', spacing: 'Medium' });
      actions.push(submit('Yes', { a: 'yes' }, 'positive'));
      if (item.kind === 'permission' && item.canAlways) actions.push(submit('Always', { a: 'always' }));
      actions.push(submit('No', { a: 'no' }, 'destructive'));
      break;
    case 'question': {
      const qs = item.questions || [];
      if (qs.length === 1 && !qs[0].multiSelect && (qs[0].options || []).length) {
        // One question: a button per option (the options stay listed above with their descriptions).
        qs[0].options.slice(0, 6).forEach((o, i) => actions.push(submit(clip(o.label, 40), { a: 'choice', n: i + 1, q0: String(i + 1) })));
        break;
      }
      // Several questions or several picks: answered by a reply in the thread when buttons send quote replies.
      if (reply) return null;
      // Otherwise inputs and Send.
      const head = body.slice(0, 2);
      body.length = 0;
      body.push(...head);
      qs.forEach((q, i) => {
        if (qs.length > 1) body.push({ type: 'TextBlock', text: `${i + 1}. ${q.question}`, weight: 'Bolder', wrap: true, spacing: 'Medium' });
        body.push({ type: 'Input.ChoiceSet', id: `q${i}`, style: 'expanded', isMultiSelect: !!q.multiSelect, choices: (q.options || []).map((o, j) => ({ title: o.description ? `${o.label} · ${o.description}`.slice(0, 200) : o.label, value: String(j + 1) })) });
        body.push({ type: 'Input.Text', id: `o${i}`, placeholder: 'Or your own words', spacing: 'Small' });
      });
      actions.push(submit('Send', { a: 'answer', say: 'Answered' }, 'positive'));
      break;
    }
    case 'decision':
      item.options.forEach((o, i) => actions.push(submit(o.label.slice(0, 40), { a: 'choice', n: i + 1 }, i === item.recommended ? 'positive' : undefined)));
      break;
    case 'signin':
      if (!item.url) return null;
      actions.push({ type: 'Action.OpenUrl', title: 'Sign in', url: item.url }, submit('Done', { a: 'yes' }, 'positive'), submit('Cancel', { a: 'no' }));
      break;
    default:
      return null;
  }
  const link = base.actions?.find((x) => x.title === 'Open in web UI');
  if (link) actions.push(link);
  return { ...base, body, actions };
}

/** Turn what a workflow card sent back into the words a reply would have used. Null when empty. */
export function flowAnswer(item, d) {
  const extra = String(d.text || '').trim();
  if (d.a === 'yes') return 'yes';
  if (d.a === 'always') return 'always';
  if (d.a === 'no') return extra ? `no ${extra}` : 'no';
  if (d.a === 'choice') return String(Number(d.n) || '');
  if (d.a === 'answer') {
    const qs = item.questions || [{}];
    const lines = qs.map((_, i) => String(d[`o${i}`] || '').trim() || String(d[`q${i}`] || '').trim());
    return lines.every((l) => !l) ? null : lines.join('\n');
  }
  return null;
}
