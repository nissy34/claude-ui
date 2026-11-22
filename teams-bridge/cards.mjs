// Adaptive Cards for the Teams bridge. The bridge posts as you through Graph, so cards are
// read-only (no bot receives button taps): you answer by replying, as with plain messages.
// Links open the web UI when CW_PUBLIC_URL (or TEAMS_UI_LINK) says where it is.

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
  { type: 'TextBlock', text: `#${code} · ${where}`, size: 'Small', isSubtle: true, wrap: true, spacing: 'None' },
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
          hint(allowPermissions ? `Reply to this card with yes${item.canAlways ? ', always' : ''} or no (and a reason), or write #${n} yes.` : 'Approving from Teams is off; answer in the web UI.'),
        ],
        url
      );
    case 'plan':
      return card([...header(n, where, 'Has a plan and wants to start', 'Accent'), T(clip(item.detail, 1800), { spacing: 'Small' }), hint(allowPermissions ? `Reply yes to start, or no plus what to change (#${n} …).` : 'Approve it in the web UI.')], url);
    case 'question': {
      const qs = item.questions || [];
      const body = [...header(n, where, qs.length > 1 ? 'Has questions' : clip(qs[0]?.question, 300), 'Accent')];
      qs.forEach((q, qi) => {
        if (qs.length > 1) body.push(T(`${qi + 1}. ${q.question}`, { weight: 'Bolder', spacing: 'Medium' }));
        body.push({ type: 'FactSet', spacing: 'Small', facts: (q.options || []).map((o, i) => ({ title: `${i + 1}`, value: o.description ? `**${o.label}** · ${clip(o.description, 140)}` : `**${o.label}**` })) });
        if (q.multiSelect) body.push(T('Pick one or more, comma separated.', { size: 'Small', isSubtle: true, spacing: 'None' }));
      });
      body.push(hint(qs.length > 1 ? `Reply with one answer per line (a number or your own words), or #${n} …` : `Reply with a number or your own words, or #${n} …`));
      return card(body, url);
    }
    case 'decision':
      return card(
        [
          ...header(n, where, item.question, 'Accent'),
          ...(item.irreversible ? [T('This cannot be undone.', { color: 'Attention', weight: 'Bolder', size: 'Small', spacing: 'Small' })] : []),
          { type: 'FactSet', spacing: 'Small', facts: item.options.map((o, i) => ({ title: `${i + 1}`, value: `**${o.label}**${i === item.recommended ? ' (recommended)' : ''}${o.consequence ? ` · ${clip(o.consequence, 200)}` : ''}` })) },
          hint(`Reply with a number, or #${n} 2.`),
        ],
        url
      );
    case 'signin':
      return card(
        [
          ...header(n, where, `${item.server || 'An MCP server'} needs you to sign in`, 'Warning'),
          T(clip(item.message, 500), { spacing: 'Small' }),
          hint(item.url ? 'Open the link and sign in, then reply done. Reply no to cancel.' : 'This one is a form: fill it in in the web UI.'),
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
  const title = ev.type === 'post' ? ev.project.name : ev.type === 'turn' ? `${ev.session.name} ${ev.isError ? 'stopped with an error' : 'finished'}` : whereOf(ev);
  return card([T(title, { weight: 'Bolder', color: ev.isError ? 'Attention' : 'Default' }), ...(ev.text ? [T(clip(ev.text, 3000), { spacing: 'Small' })] : [])], link(uiUrl, ev.type === 'post' ? { project: ev.project } : { session: ev.session }));
}
