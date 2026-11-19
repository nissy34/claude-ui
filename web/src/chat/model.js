// Turns the flat event log from the server into renderable items.

// Chats saved before pictures were kept show Claude Code's note for the saved copy instead.
const SOURCE_RE = /\[Image: source: ([^\]\n]+?[\\/]tool-results[\\/][^\]\n\\/]+\.(?:png|jpe?g|gif|webp))\]/gi;

function resultOf(e) {
  if (e.images?.length || typeof e.text !== 'string' || !e.text.includes('[Image: source:')) return { text: e.text, isError: e.isError, images: e.images || [] };
  const images = [...e.text.matchAll(SOURCE_RE)].map((m) => `/api/tool-result-image?path=${encodeURIComponent(m[1].trim())}`);
  if (!images.length) return { text: e.text, isError: e.isError, images: [] };
  const text = e.text.replace(SOURCE_RE, '').replace(/^\[image\]$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, isError: e.isError, images };
}

export function buildItems(events, deltas, offset = 0) {
  const items = [];
  const tools = new Map(); // tool_use id -> item
  const perms = new Map();
  let lastText = null;

  const push = (it) => {
    items.push(it);
    lastText = null;
  };

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    // Sub-agent activity is folded into its parent Task card.
    if (e.parent && e.k !== 'perm' && e.k !== 'perm_done' && e.k !== 'elicit' && e.k !== 'elicit_done') {
      const parent = tools.get(e.parent);
      if (parent) {
        if (e.k === 'block' && e.block.type === 'tool_use') {
          const child = { type: 'tool', id: e.block.id, name: e.block.name, input: e.block.input, result: null, children: [] };
          parent.children.push(child);
          tools.set(e.block.id, child);
        } else if (e.k === 'tool_result') {
          const t = tools.get(e.toolUseId);
          if (t) t.result = resultOf(e);
        }
      }
      continue;
    }
    switch (e.k) {
      case 'user':
        push({ type: 'user', text: e.text, images: e.images || 0, refs: e.refs || [], from: e.from || null, ts: e.ts, index: idx + offset });
        break;
      case 'block': {
        const b = e.block;
        if (b.type === 'text') {
          if (!b.text?.trim()) break;
          if (lastText && lastText.msgId === e.msgId) lastText.text += '\n\n' + b.text;
          else {
            const it = { type: 'text', msgId: e.msgId, text: b.text };
            push(it);
            lastText = it;
          }
        } else if (b.type === 'thinking') {
          if (b.thinking?.trim()) push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          const it = { type: 'tool', id: b.id, name: b.name, input: b.input || {}, result: null, children: [] };
          tools.set(b.id, it);
          push(it);
        }
        break;
      }
      case 'tool_result': {
        const t = tools.get(e.toolUseId);
        if (t) t.result = resultOf(e);
        break;
      }
      case 'perm': {
        const it = { type: 'perm', ...e, done: null };
        perms.set(e.reqId, it);
        // Show the request attached to its tool card when we have one, otherwise inline.
        const t = e.toolUseId && tools.get(e.toolUseId);
        if (t) t.perm = it;
        else push(it);
        break;
      }
      case 'elicit': {
        const it = { type: 'elicit', req: e, done: null };
        perms.set('el:' + e.reqId, it);
        push(it);
        break;
      }
      case 'elicit_done': {
        const it = perms.get('el:' + e.reqId);
        if (it) it.done = e.action;
        break;
      }
      case 'perm_done': {
        const p = perms.get(e.reqId);
        if (p) p.done = e.behavior;
        break;
      }
      case 'result':
        push({ type: 'result', ...e });
        break;
      case 'error':
        push({ type: 'error', text: e.text, resumable: !!e.resumable || /^Claude exited/.test(e.text || '') });
        break;
      case 'shell':
        push({ type: 'shell', cmd: e.cmd, text: e.text, code: e.code });
        break;
      case 'notice':
        push({ type: 'notice', text: e.text });
        break;
    }
  }

  // Live streaming text that hasn't been finalized into a block yet.
  const streaming = [];
  for (const d of Object.values(deltas || {})) if (!d.parent && d.text) streaming.push(d);
  streaming.sort((a, b) => a.order - b.order);
  for (const d of streaming) items.push({ type: d.kind === 'thinking' ? 'thinking' : 'text', text: d.text, streaming: true, key: d.key });

  return items;
}

export function shortPath(p, cwd) {
  if (!p) return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/** update_plan steps -> the TodoWrite shape the task list renders. */
export function planTodos(input) {
  return (input?.steps || []).map((x) => ({ content: String(x.step ?? x.title ?? x.content ?? ''), status: x.status || 'pending' }));
}

export const isPublishTool = (name) => name === 'mcp__ui__publish_artifact';
// The published file's absolute path, from publish_artifact's JSON result.
export function publishedPath(text) {
  try {
    return JSON.parse(text || '').path || null;
  } catch {
    return /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text || '')?.[1]?.replace(/\\(.)/g, '$1') || null;
  }
}
export function publishedTitle(text) {
  try {
    return JSON.parse(text || '').title || null;
  } catch {
    return null;
  }
}
export const isPlanTool = (name) => /^mcp__ui__update_plan$/.test(name || '');

/** The chat's current task list: the latest update_plan or TodoWrite call. */
export function lastTodos(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k !== 'block' || e.block.type !== 'tool_use' || e.parent) continue;
    if (isPlanTool(e.block.name)) {
      // A later update often leaves the title out: keep the one given earlier.
      let title = e.block.input?.title || '';
      for (let j = i - 1; j >= 0 && !title; j--) {
        const f = events[j];
        if (f.k === 'user') break;
        if (f.k === 'block' && f.block.type === 'tool_use' && !f.parent && isPlanTool(f.block.name)) title = f.block.input?.title || '';
      }
      return { title, items: planTodos(e.block.input) };
    }
    if (e.block.name === 'TodoWrite') return { title: '', items: e.block.input?.todos || [] };
  }
  return null;
}
