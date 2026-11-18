// Handoff MCP: lets the Claude Desktop app (or any MCP client on your network) talk to this UI.
// Desktop can list chats, ask what a chat did, hand a task off to a new chat here (to run now or
// to wait for you), send a chat a message, and share notes both ways.
//
// Transport is MCP "Streamable HTTP" at POST /mcp with JSON responses, authenticated with a
// bearer token. Claude Desktop only launches local (stdio) servers from its config file, so it
// connects through a tiny bridge script (server/desktop-bridge.mjs, also served at
// /mcp/bridge.mjs) or through `npx mcp-remote`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loginAllowed, loginFailed } from './auth.js';
import * as notes from './notes.js';

const TOKEN_FILE = path.join(config.dataDir, 'mcp-token');
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-bridge.mjs');
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const DESKTOP = { id: 'desktop', name: 'Claude Desktop', role: 'desktop' };

let token = process.env.CW_MCP_TOKEN || '';
if (!token) {
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {}
  if (!token) rotateToken();
}

export function getToken() {
  return token;
}

export function rotateToken() {
  if (process.env.CW_MCP_TOKEN) throw new Error('The token comes from CW_MCP_TOKEN; change it there.');
  token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const got = m ? m[1].trim() : '';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return !!got && crypto.timingSafeEqual(a, b);
}

const MODES = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the project folders on the Claude Code machine. Use a project name (or full path) as "project" in handoff.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sessions',
    description:
      "List the Claude Code chats on the user's machine (newest activity first) with their state (idle, busy, waiting for permission), folder and a preview of the latest reply. Use it to find a chat before get_session or send_message.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Only chats whose name or folder contains these words.' },
        limit: { type: 'number', description: 'Default 20, at most 100.' },
        include_archived: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_session',
    description:
      'Answer "what did you do?" for one chat: its status, the conversation (user messages and Claude\'s replies), which files it edited, which commands it ran, and the uncommitted git changes in its folder. Set wait_seconds to wait for a busy chat to finish first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id from list_sessions.' },
        max_chars: { type: 'number', description: 'Most transcript characters to return, newest kept (default 20000, at most 100000).' },
        wait_seconds: { type: 'number', description: 'If the chat is busy, wait up to this long (at most 120) for it to finish.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'handoff',
    description:
      "Hand work off to Claude Code on the user's machine: creates a new chat there with the task, the context so far and the next steps. " +
      'With start_now=true (default) it starts working right away; with start_now=false the chat waits with the brief in its message box, so the user can review and send it later (for example "continue tonight"). ' +
      'Write a complete, self-contained brief: the new chat cannot see this conversation. Returns the session id; check on it later with get_session.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, in one or two sentences.' },
        context: { type: 'string', description: 'Everything the new chat needs to know: what was decided, what was tried, relevant files, links, constraints.' },
        next_steps: { type: 'string', description: 'Concrete next steps, one per line.' },
        project: { type: 'string', description: 'Project folder name (from list_projects) or absolute path. Required.' },
        name: { type: 'string', description: 'Short chat title shown in the sidebar.' },
        start_now: { type: 'boolean', description: 'Start working now (default true), or leave the brief for the user to send.' },
        worktree: { type: 'boolean', description: 'Run in a fresh git worktree on its own branch.' },
        model: { type: 'string', description: 'Model alias or id, e.g. opus, sonnet, haiku. Default: the account default.' },
        effort: { type: 'string', enum: EFFORTS },
        permission_mode: { type: 'string', enum: MODES, description: 'Default "default" (asks the user before edits and commands, so an unattended chat stops at the first prompt). Use acceptEdits or auto only if the user asked for it.' },
      },
      required: ['task', 'project'],
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to an existing chat to continue it (for example new instructions, or "continue with the next step"). If the chat is busy, the message is queued and delivered when its current turn ends. Check the result later with get_session.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, message: { type: 'string' } },
      required: ['id', 'message'],
    },
  },
  {
    name: 'list_notes',
    description:
      'List the shared notes (newest first). Notes are shared between Claude Desktop and the Claude Code chats on the user\'s machine: handoffs, decisions, preferences, things to remember. Check them when the user refers to earlier work.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for.' }, tag: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'read_note',
    description: 'Read one shared note in full, by id or exact title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id or exact title.' } }, required: ['id'] },
  },
  {
    name: 'write_note',
    description: 'Create or update a shared note. A note with the same title (or the given id) is replaced, or added to with append=true.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown.' },
        tags: { type: 'array', items: { type: 'string' } },
        append: { type: 'boolean', description: 'Add to the end of the existing note instead of replacing it.' },
        id: { type: 'string', description: 'Update this note (by id) instead of matching by title.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a shared note by id or exact title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const ago = (ms) => (ms ? new Date(ms).toISOString() : null);

function summary(s) {
  const m = s.meta;
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    folder: m.cwd,
    state: m.kind === 'chat' ? s.state : s.running ? 'running' : 'exited',
    lastActivity: ago(m.lastActivity),
    parentId: m.parentId || null,
    ...(m.archived ? { archived: true } : {}),
    ...(m.worktree ? { branch: m.worktree.branch } : {}),
    ...(m.draft ? { waitingToBeSent: true } : {}),
  };
}

/** Files edited, commands run and tool counts, from the chat's event log. */
function activity(events) {
  const files = new Map();
  const commands = [];
  const counts = {};
  for (const e of events) {
    if (e.k !== 'block' || e.block?.type !== 'tool_use') continue;
    const { name, input = {} } = e.block;
    counts[name] = (counts[name] || 0) + 1;
    const f = input.file_path || input.notebook_path;
    if (f && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) files.set(f, (files.get(f) || 0) + 1);
    if (name === 'Bash' && input.command) commands.push(String(input.command).slice(0, 300));
  }
  return { filesEdited: [...files.keys()], commands: commands.slice(-25), commandCount: commands.length, toolCounts: counts };
}

export function createDesktopMcp({ store, resolveDir, createWorktree, getChanges, listProjects }) {
  function chat(id) {
    const s = store.get(String(id || '').trim());
    if (!s) throw new Error(`No session "${id}". list_sessions shows the ids.`);
    return s;
  }

  async function run(name, a = {}) {
    switch (name) {
      case 'list_projects':
        return listProjects();
      case 'list_sessions': {
        const words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        let list = [...store.sessions.values()].filter((s) => a.include_archived || !s.meta.archived);
        if (words.length) list = list.filter((s) => words.every((w) => `${s.meta.name} ${s.meta.cwd}`.toLowerCase().includes(w)));
        list.sort((x, y) => (y.meta.lastActivity || 0) - (x.meta.lastActivity || 0));
        const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return {
          sessions: list.slice(0, limit).map((s) => ({ ...summary(s), ...(s.meta.kind === 'chat' ? { lastReplyPreview: s.lastReply().slice(0, 300) } : {}) })),
          total: list.length,
        };
      }
      case 'get_session': {
        const s = chat(a.id);
        if (s.meta.kind !== 'chat') return { session: summary(s), note: 'This is a terminal session; only chats have a readable transcript.' };
        const wait = Math.min(Math.max(Number(a.wait_seconds) || 0, 0), 120);
        const until = Date.now() + wait * 1000;
        while (wait && s.state === 'busy' && Date.now() < until && store.get(s.id)) await new Promise((r) => setTimeout(r, 1000));
        const max = Math.min(Math.max(Number(a.max_chars) || 20000, 1000), 100_000);
        let changes = null;
        try {
          const c = await getChanges(s.meta.cwd);
          if (c.git) changes = { branch: c.branch, files: c.files.map((f) => ({ path: f.path, status: f.status, add: f.add, del: f.del })) };
        } catch {}
        return {
          session: summary(s),
          waitingForPermission: s.pending.size > 0 ? [...s.pending.values()].map((p) => p.tool) : false,
          queuedMessages: s.inbox.length,
          ...(s.meta.draft ? { draftWaitingToBeSent: s.meta.draft } : {}),
          activity: activity(s.events),
          uncommittedChanges: changes,
          transcript: s.transcriptText(max),
        };
      }
      case 'handoff': {
        const task = String(a.task || '').trim();
        if (!task) throw new Error('task is required');
        if (!a.project) throw new Error('project is required: a folder name from list_projects, or an absolute path.');
        if (a.permission_mode && !MODES.includes(a.permission_mode)) throw new Error(`permission_mode must be one of ${MODES.join(', ')}`);
        if (a.effort && !EFFORTS.includes(a.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
        const dir = resolveDir(String(a.project));
        const title = String(a.name || task).trim().split('\n')[0].slice(0, 80);
        const wt = a.worktree ? await createWorktree(dir, title) : null;
        let brief = task;
        if (a.context?.trim()) brief += `\n\n## Context\n${a.context.trim()}`;
        if (a.next_steps?.trim()) brief += `\n\n## Next steps\n${a.next_steps.trim()}`;
        const s = store.create({
          cwd: wt ? wt.path : dir,
          kind: 'chat',
          name: title,
          permissionMode: a.permission_mode && a.permission_mode !== 'default' ? a.permission_mode : undefined,
          model: a.model && a.model !== 'default' ? a.model : undefined,
          effort: a.effort && a.effort !== 'default' ? a.effort : undefined,
        });
        s.meta.customName = true;
        s.meta.project = dir;
        s.meta.handoff = { from: 'desktop', at: Date.now() };
        if (wt) s.meta.worktree = wt;
        const startNow = a.start_now !== false;
        if (startNow) {
          s.send({ text: brief, from: { ...DESKTOP, kind: 'handoff' } });
        } else {
          s.meta.draft = brief;
          s.meta.attention = true;
          s.record({ k: 'notice', text: 'Handed off from Claude Desktop. The brief is in the message box: review it and press Send to start.' });
        }
        store.save();
        store.changed?.();
        return {
          session: summary(s),
          note: startNow
            ? 'Started. It works on its own in the UI; check on it with get_session. If it needs a permission it waits for the user in the UI.'
            : 'Created and waiting: the brief is in its message box for the user to send.',
        };
      }
      case 'send_message': {
        const s = chat(a.id);
        if (s.meta.kind !== 'chat') throw new Error('That is a terminal session; send_message works on chats.');
        const text = String(a.message || '').trim();
        if (!text) throw new Error('message is required');
        if (s.meta.draft) {
          // Sending to a chat that is still waiting with its handoff brief: send the brief first.
          const draft = s.meta.draft;
          s.meta.draft = undefined;
          s.deliver({ text: draft, from: { ...DESKTOP, kind: 'handoff' } });
        }
        const r = s.deliver({ text, from: DESKTOP });
        return { ok: true, session: summary(s), note: r.held ? "Held: the chat can't take messages right now (it may be open in the terminal); delivered when it can." : r.queued ? `Queued: the chat is busy; ${r.queued} message(s) are delivered in order when its turn ends.` : 'Delivered; it is working on it.' };
      }
      case 'list_notes':
        return { notes: notes.listNotes(a) };
      case 'read_note':
        return notes.getNote(a.id ?? a.title);
      case 'write_note':
        return notes.writeNote({ ...a, source: 'Claude Desktop' });
      case 'delete_note':
        return notes.deleteNote(a.id ?? a.title);
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    try {
      switch (method) {
        case 'initialize': {
          const v = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
          return ok({
            protocolVersion: v,
            capabilities: { tools: {} },
            serverInfo: { name: 'claude-ui', version: '1.0.0' },
            instructions:
              "Connects to Claude Code running in the user's own web UI on their computer. Use it to hand work off there (handoff), check what a chat did (list_sessions, get_session), continue a chat (send_message), and share notes both ways (list_notes, read_note, write_note).",
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call':
          try {
            const out = await run(params?.name, params?.arguments || {});
            return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
          } catch (e) {
            return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
        case 'resources/list':
          return ok({ resources: [] });
        case 'prompts/list':
          return ok({ prompts: [] });
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
    }
  }

  /** Mount before the cookie-auth middleware for /api. */
  function mount(app) {
    app.get('/mcp/bridge.mjs', (req, res) => res.type('text/javascript').sendFile(BRIDGE));
    app.all('/mcp', async (req, res) => {
      // Only non-browser clients: a web page can't send a bearer token across origins without CORS,
      // but refuse any Origin anyway so DNS rebinding can't reach it.
      if (req.headers.origin) return res.status(403).json({ error: 'Browser requests are not allowed' });
      const ip = req.ip;
      if (!loginAllowed(ip)) return res.status(429).json({ error: 'Too many failed attempts, try again later.' });
      if (!tokenOk(req)) {
        loginFailed(ip);
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: 'Missing or wrong token. Copy it from Settings > Claude Desktop.' });
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Use POST' });
      }
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      const batch = Array.isArray(body);
      const out = (await Promise.all((batch ? body : [body]).map(handle))).filter(Boolean);
      if (!out.length) return res.status(202).end();
      res.json(batch ? out : out[0]);
    });
  }

  return { mount, run, tools: TOOLS };
}
