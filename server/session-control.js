// Session control shared by the built-in sessions tools (chats managing other chats) and the
// handoff MCP (Claude Desktop / Claude Code): stop a turn, archive, rename, change options.
export async function controlSession(store, s, action, a = {}, by = 'another chat') {
  const m = s.meta;
  switch (action) {
    case 'stop': {
      if (m.kind !== 'chat') throw new Error('Only chats can be stopped this way.');
      if (s.state === 'idle') return { ok: true, note: 'It was not working on anything.' };
      await s.interrupt();
      s.record({ k: 'notice', text: `Stopped by ${by}` });
      return { ok: true, note: 'Stopped its current turn. Send it a message to continue.' };
    }
    case 'archive':
    case 'unarchive': {
      m.archived = action === 'archive';
      store.save();
      store.changed?.();
      return { ok: true, archived: m.archived };
    }
    case 'rename': {
      const title = String(a.title ?? a.name ?? '').trim().split('\n')[0].slice(0, 80);
      if (!title) throw new Error('title is required');
      m.name = title;
      m.customName = true;
      store.save();
      store.changed?.();
      s.broadcastState?.();
      return { ok: true, name: title };
    }
    case 'options': {
      if (m.kind !== 'chat') throw new Error('Only chats have a model, effort and permission mode.');
      const { model, effort, permission_mode: permissionMode } = a;
      if (model == null && effort == null && permissionMode == null) throw new Error('Give model, effort or permission_mode');
      const done = await s.setOptions({ model, effort, permissionMode });
      s.record({ k: 'notice', text: `Set ${done.join(', ')} (by ${by})` });
      return { ok: true, changed: done };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
