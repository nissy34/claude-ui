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
import { controlSession } from './session-control.js';

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

// Projects: a coordinator conversation that runs parallel threads (see server/cprojects.js).
const PROJECT_TOOLS = [
  {
    name: 'projects_list',
    description:
      "List the user's Projects in the web UI. A Project is a conversation with a coordinator that hands work to parallel threads (Claude Code sessions in their own worktrees). Shows each project's id, name, goal, thread counts by status and how many need the user.",
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
  },
  {
    name: 'project_create',
    description: 'Create a Project. folders: folder names from list_folders (the first is where threads work, each in its own git worktree). Optionally send the first message to its coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        goal: { type: 'string', description: 'One line.' },
        folders: { type: 'array', items: { type: 'string' } },
        instructions: { type: 'string', description: 'Standing rules for every session in the project.' },
        coordinator_model: { type: 'string', description: 'e.g. sonnet (default), opus, haiku.' },
        coordinator_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        thread_model: { type: 'string', description: 'e.g. opus (default), sonnet.' },
        thread_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        max_running: { type: 'number', description: 'Thread turns at once (default 3).' },
        message: { type: 'string', description: 'First message to the coordinator.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_status',
    description: 'One project at a glance: threads with status (Waiting on you, Ready for review, Working, Queued, Idle, Snoozed, Resolved), checklist progress and last post; open decision cards; the recent project chat; usage.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Project id or exact name.' }, chat_messages: { type: 'number', description: 'Recent project chat messages to include (default 15, at most 100).' } }, required: ['project_id'] },
  },
  {
    name: 'project_send',
    description: "Post a message to a project's chat, to its coordinator. It is labelled as coming from Claude Desktop on the user's behalf. The coordinator answers in the project chat; read it later with project_status.",
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, message: { type: 'string' } }, required: ['project_id', 'message'] },
  },
  {
    name: 'project_thread',
    description: "Read one thread of a project: status, checklist, posts, and its transcript (newest kept). Use get_session with the same id for files edited and git changes.",
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, thread_id: { type: 'string' }, max_chars: { type: 'number' } }, required: ['project_id', 'thread_id'] },
  },
  {
    name: 'project_message_thread',
    description: 'Send a message straight to a thread (more work, an answer). Labelled as Claude Desktop on behalf of the user. Delivered when the thread is idle.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, thread_id: { type: 'string' }, message: { type: 'string' } }, required: ['project_id', 'thread_id', 'message'] },
  },
  {
    name: 'project_answer_decision',
    description: "Answer an open decision card for the user, when the user told you their choice. Cards about steps that can't be undone can only be answered in the web UI.",
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, decision_id: { type: 'string' }, choice: { type: 'number', description: 'Option index from 0.' }, note: { type: 'string' } }, required: ['project_id', 'decision_id', 'choice'] },
  },
  {
    name: 'project_answer_suggestion',
    description: 'Start or dismiss a thread the coordinator suggested (openSuggestions in project_status), when the user told you to.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, suggestion_id: { type: 'string' }, action: { type: 'string', enum: ['start', 'dismiss'] } }, required: ['project_id', 'suggestion_id', 'action'] },
  },
  {
    name: 'project_move_chat',
    description: 'Move an existing regular chat (a session id from list_sessions) into a project as a thread. It keeps its folder, branch and history, and the coordinator is told.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, session_id: { type: 'string' } }, required: ['project_id', 'session_id'] },
  },
  {
    name: 'project_update',
    description: "Change a project's settings: name, goal, instructions, models per role, the running cap, proactivity (quiet/normal/chatty), or archive it.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        name: { type: 'string' },
        goal: { type: 'string' },
        instructions: { type: 'string' },
        coordinator_model: { type: 'string' },
        coordinator_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        thread_model: { type: 'string' },
        thread_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        max_running: { type: 'number' },
        proactivity: { type: 'string', enum: ['quiet', 'normal', 'chatty'] },
        budget_usd: { type: 'number', description: 'Pause the project once it has cost this much (0 = no budget).' },
        archived: { type: 'boolean' },
      },
      required: ['project_id'],
    },
  },
];

const TOOLS = [
  ...PROJECT_TOOLS,
  {
    name: 'list_folders',
    description: 'List the folders (code repositories) on the Claude Code machine. Use a folder name (or full path) as "folder" in handoff and the note tools. Not the same as Projects (coordinator + threads): see projects_list.',
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
        folder: { type: 'string', description: 'Folder name (from list_folders) or absolute path. Required.' },
        name: { type: 'string', description: 'Short chat title shown in the sidebar.' },
        start_now: { type: 'boolean', description: 'Start working now (default true), or leave the brief for the user to send.' },
        worktree: { type: 'boolean', description: 'Run in a fresh git worktree on its own branch.' },
        model: { type: 'string', description: 'Model alias or id, e.g. opus, sonnet, haiku. Default: the account default.' },
        effort: { type: 'string', enum: EFFORTS },
        permission_mode: { type: 'string', enum: MODES, description: 'Default "default" (asks the user before edits and commands, so an unattended chat stops at the first prompt). Use acceptEdits or auto only if the user asked for it.' },
      },
      required: ['task', 'folder'],
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to an existing chat to continue it (for example new instructions, or "continue with the next step"). If the chat is busy, the message is queued and delivered when its current turn ends, unless steer=true. Check the result later with get_session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        message: { type: 'string' },
        steer: { type: 'boolean', description: 'Steer immediately: if the chat is busy, stop its current turn and send this message right away (like the user pressing Send now) instead of queueing it. Use only when it must change what the chat is doing now, e.g. it is working from wrong information. Default false.' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'stop_session',
    description: "Stop a chat's current turn (like pressing Stop in the UI). It keeps its conversation; send_message continues it.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'archive_session',
    description: 'Archive a chat (hidden from the sidebar, nothing deleted), or unarchive it with archived=false.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, archived: { type: 'boolean', description: 'Default true.' } }, required: ['id'] },
  },
  {
    name: 'rename_session',
    description: "Set a chat's title in the sidebar.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
  },
  {
    name: 'set_session_options',
    description: "Change a chat's model, effort or permission mode. Takes effect from its next message (model and mode also mid-turn).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        model: { type: 'string', description: 'Model alias or id, e.g. opus, sonnet, haiku; "default" for the account default.' },
        effort: { type: 'string', enum: EFFORTS },
        permission_mode: { type: 'string', enum: MODES },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_notes',
    description:
      "List notes. With folder: that folder's notes, which live in Claude Code's memory for the folder (every Claude Code session there loads them, and they include what Claude remembered on its own), plus global notes. Without folder: only global notes (preferences and things that span folders). Check them when the user refers to earlier work.",
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Folder name (from list_folders) or path.' }, query: { type: 'string', description: 'Words to search for.' }, tag: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'read_note',
    description: 'Read one note in full, by id or title. With folder, looks in that folder first, then global notes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id or title.' }, folder: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'write_note',
    description:
      "Create or update a note. With folder, it goes into that folder's Claude Code memory, so every future session there sees it. Without folder it is a global note (use for preferences and things that span folders). A note with the same title (or id) is replaced, or added to with append=true.",
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name (from list_folders) or path. Leave out for a global note.' },
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown.' },
        description: { type: 'string', description: 'One line for the memory index (defaults to the first line of content).' },
        tags: { type: 'array', items: { type: 'string' } },
        append: { type: 'boolean', description: 'Add to the end of the existing note instead of replacing it.' },
        id: { type: 'string', description: 'Update this note (by id) instead of matching by title.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by id or title. With folder, from that folder (then global).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, folder: { type: 'string' } }, required: ['id'] },
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

/** The latest task list the chat showed (update_plan or TodoWrite). */
function currentPlan(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k !== 'block' || e.block?.type !== 'tool_use' || e.parent) continue;
    const { name, input = {} } = e.block;
    if (/__update_plan$/.test(name)) {
      const earlier = events.slice(0, i).reverse().find((f) => f.k === 'block' && f.block?.type === 'tool_use' && !f.parent && /__update_plan$/.test(f.block.name) && f.block.input?.title);
      return { title: input.title || earlier?.block.input.title || null, steps: (input.steps || []).map((x) => ({ step: x.step ?? x.title ?? x.content, status: x.status })) };
    }
    if (name === 'TodoWrite') return { title: null, steps: (input.todos || []).map((x) => ({ step: x.content, status: x.status })) };
  }
  return null;
}

/** Settings patch from the MCP's flat arguments. */
function projectPatch(a) {
  const patch = {};
  for (const k of ['name', 'goal', 'instructions', 'archived']) if (a[k] != null) patch[k] = a[k];
  const models = {};
  if (a.coordinator_model != null || a.coordinator_effort != null) models.coordinator = { ...(a.coordinator_model != null ? { model: a.coordinator_model } : {}), ...(a.coordinator_effort != null ? { effort: a.coordinator_effort } : {}) };
  if (a.thread_model != null || a.thread_effort != null) models.thread = { ...(a.thread_model != null ? { model: a.thread_model } : {}), ...(a.thread_effort != null ? { effort: a.thread_effort } : {}) };
  if (Object.keys(models).length) patch.models = models;
  const policy = {};
  if (a.max_running != null) policy.maxRunning = a.max_running;
  if (a.proactivity != null) policy.proactivity = a.proactivity;
  if (a.budget_usd != null) policy.budgetUsd = a.budget_usd;
  if (Object.keys(policy).length) patch.policy = policy;
  return patch;
}

export function createDesktopMcp({ store, resolveDir, createWorktree, getChanges, listProjects, engine }) {
  function proj(id) {
    if (!engine) throw new Error('Projects are not available on this server.');
    const key = String(id || '').trim();
    if (engine.projects.has(key)) return engine.projects.get(key);
    const byName = [...engine.projects.values()].filter((p) => p.settings.name.toLowerCase() === key.toLowerCase());
    if (byName.length === 1) return byName[0];
    throw new Error(`No project "${id}". projects_list shows the ids.`);
  }
  const projThread = (p, id) => {
    const tid = String(id || '').trim();
    if (p.state.threads[tid]) return tid;
    const byTitle = Object.values(p.state.threads).filter((t) => t.title.toLowerCase() === tid.toLowerCase());
    if (byTitle.length === 1) return byTitle[0].id;
    throw new Error(`No thread "${id}" in this project. project_status lists them.`);
  };

  function chat(id) {
    const s = store.get(String(id || '').trim());
    if (!s) throw new Error(`No session "${id}". list_sessions shows the ids.`);
    return s;
  }

  async function run(name, a = {}) {
    switch (name) {
      case 'projects_list':
        return { projects: (engine ? engine.list() : []).filter((p) => a.include_archived || !p.archived).map((p) => ({ id: p.id, name: p.name, goal: p.goal, threads: p.threadCount, byStatus: p.counts, needsUser: p.attention, openDecisions: p.openDecisions, coordinatorWorking: p.coordinatorBusy, paused: p.paused?.reason || null, lastActivity: ago(p.lastActivity) })) };
      case 'project_create': {
        if (!engine) throw new Error('Projects are not available on this server.');
        const patch = projectPatch(a);
        patch.folders = (Array.isArray(a.folders) ? a.folders : a.folders ? [a.folders] : []).map((f) => ({ path: resolveDir(String(f)) }));
        const p = await engine.create(patch, { by: 'desktop' });
        if (a.message?.trim()) engine.userMessage(p, a.message, { from: 'desktop' });
        return { project_id: p.id, name: p.settings.name, settings: p.settings, note: a.message ? 'Created; the coordinator is working on your message. Check with project_status.' : 'Created. Send its coordinator work with project_send.' };
      }
      case 'project_status': {
        const p = proj(a.project_id);
        const d = p.detail();
        const n = Math.min(Math.max(Number(a.chat_messages) || 15, 0), 100);
        const chat = d.feed.filter((e) => e.type === 'user.message' || e.type === 'chat.post').slice(-n).map((e) => ({ id: e.id, at: ago(e.ts), from: e.type === 'chat.post' ? 'coordinator' : e.from?.kind === 'desktop' ? 'Claude Desktop' : 'user', text: e.body.text.slice(0, 2000) }));
        return {
          project: { id: d.id, name: d.name, goal: d.goal, paused: d.paused?.reason || null, coordinatorWorking: d.coordinatorBusy, runningThreadTurns: d.running, cap: d.settings.policy.maxRunning, proactivity: d.settings.policy.proactivity, models: d.settings.models },
          threads: d.threads.map((t) => ({ thread_id: t.id, title: t.title, status: t.statusLabel, checklist: t.progress ? `${t.progress.done}/${t.progress.total}` : null, lastPost: t.lastPost ? { kind: t.lastPost.kind, text: t.lastPost.text.slice(0, 600), at: ago(t.lastPost.ts) } : null, branch: t.branch, pr: t.pr?.url || null, waitingForPermission: t.pendingPermissions > 0, cost: Number(t.cost.toFixed(4)) })),
          openDecisions: d.decisions.filter((x) => !x.answer).map((x) => ({ decision_id: x.id, thread: x.thread ? p.state.threads[x.thread]?.title : 'coordinator', question: x.question, options: x.options.map((o, i) => `${i}: ${o.label}${i === x.recommended ? ' (recommended)' : ''}${o.consequence ? ` - ${o.consequence}` : ''}`), irreversible: !!x.irreversible })),
          openSuggestions: (d.suggestions || []).filter((x) => !x.answer).map((x) => ({ suggestion_id: x.id, title: x.title, reason: x.reason })),
          chat,
          usageUsd: Number(d.usage.total.toFixed(4)),
          budgetUsd: d.settings.policy.budgetUsd || null,
        };
      }
      case 'project_send': {
        const p = proj(a.project_id);
        const ev = engine.userMessage(p, a.message, { from: 'desktop' });
        return { ok: true, event_id: ev.id, note: 'Posted to the project chat. The coordinator answers there; check with project_status in a little while.' };
      }
      case 'project_thread': {
        const p = proj(a.project_id);
        const tid = projThread(p, a.thread_id);
        const s = store.get(tid);
        const max = Math.min(Math.max(Number(a.max_chars) || 15000, 1000), 100_000);
        const posts = p.events.filter((e) => e.thread === tid && e.type === 'thread.post').slice(-20).map((e) => ({ at: ago(e.ts), kind: e.body.kind, text: e.body.text.slice(0, 3000) }));
        return { thread: p.threadSummary(p.state.threads[tid]), posts, transcript: s ? s.transcriptText(max) : '' };
      }
      case 'project_message_thread': {
        const p = proj(a.project_id);
        const tid = projThread(p, a.thread_id);
        const text = String(a.message || '').trim();
        if (!text) throw new Error('message is required');
        p.append({ type: 'session.message', from: { kind: 'desktop' }, trust: 'relay', thread: tid, body: { to: tid, text } });
        return { ok: true, status: p.threadSummary(p.state.threads[tid]).statusLabel };
      }
      case 'project_answer_suggestion': {
        const p = proj(a.project_id);
        const r = await engine.answerSuggestion(p, String(a.suggestion_id || ''), String(a.action || ''), { by: 'desktop' });
        return { ok: true, ...r };
      }
      case 'project_move_chat': {
        const p = proj(a.project_id);
        const s = await engine.adoptChat(p, String(a.session_id || ''), { by: 'desktop' });
        return { ok: true, thread: p.threadSummary(p.state.threads[s.id]).statusLabel, thread_id: s.id };
      }
      case 'project_answer_decision': {
        const p = proj(a.project_id);
        const ev = engine.answerDecision(p, String(a.decision_id || ''), { choice: a.choice, note: a.note }, { by: 'desktop' });
        return { ok: true, event_id: ev.id, answered: ev.body.label };
      }
      case 'project_update': {
        const p = proj(a.project_id);
        engine.update(p, projectPatch(a), { by: 'desktop' });
        return { ok: true, settings: p.settings };
      }
      case 'list_folders':
      case 'list_projects': // old name, still accepted
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
          plan: currentPlan(s.events),
          activity: activity(s.events),
          uncommittedChanges: changes,
          transcript: s.transcriptText(max),
        };
      }
      case 'handoff': {
        const task = String(a.task || '').trim();
        if (!task) throw new Error('task is required');
        const folder = a.folder || a.project; // "project" is the old name
        if (!folder) throw new Error('folder is required: a folder name from list_folders, or an absolute path.');
        if (a.permission_mode && !MODES.includes(a.permission_mode)) throw new Error(`permission_mode must be one of ${MODES.join(', ')}`);
        if (a.effort && !EFFORTS.includes(a.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
        const dir = resolveDir(String(folder));
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
        const r = s.deliver({ text, from: DESKTOP, steer: !!a.steer });
        return { ok: true, session: summary(s), note: r.interrupted ? 'Sent now: the chat stopped its current turn and is working on your message.' : r.held ? "Held: the chat can't take messages right now (it may be open in the terminal); delivered when it can." : r.queued ? `Queued: the chat is busy; ${r.queued} message(s) are delivered in order when its turn ends.` : 'Delivered; it is working on it.' };
      }
      case 'stop_session':
        return { ...(await controlSession(store, chat(a.id), 'stop', a, 'Claude Desktop')), session: summary(chat(a.id)) };
      case 'archive_session':
        return { ...(await controlSession(store, chat(a.id), a.archived === false ? 'unarchive' : 'archive', a, 'Claude Desktop')), session: summary(chat(a.id)) };
      case 'rename_session':
        return { ...(await controlSession(store, chat(a.id), 'rename', a, 'Claude Desktop')), session: summary(chat(a.id)) };
      case 'set_session_options':
        if (a.permission_mode && !MODES.includes(a.permission_mode)) throw new Error(`permission_mode must be one of ${MODES.join(', ')}`);
        return { ...(await controlSession(store, chat(a.id), 'options', a, 'Claude Desktop')), session: summary(chat(a.id)) };
      case 'list_notes':
      case 'read_note':
      case 'write_note':
      case 'delete_note': {
        const projectDir = a.folder || a.project ? resolveDir(String(a.folder || a.project)) : null;
        const res = notes.notesOp(name.split('_')[0], a, { projectDir, source: 'Claude Desktop' });
        if (name === 'list_notes' && !projectDir) res.note = 'Global notes only. Pass folder to include that folder\'s notes (its Claude Code memory).';
        return res;
      }
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
              "Connects to Claude Code running in the user's own web UI on their computer. Projects (a coordinator that runs parallel threads): projects_list, project_status, project_send, project_thread, project_message_thread, project_answer_decision, project_answer_suggestion, project_move_chat, project_create, project_update. Use it to hand work off there (handoff), check what a chat did (list_sessions, get_session), continue or manage a chat (send_message, stop_session, rename_session, archive_session, set_session_options), and share notes both ways (list_notes, read_note, write_note).",
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
