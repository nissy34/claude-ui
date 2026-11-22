#!/usr/bin/env node
// A tiny stdio MCP server that the web UI gives to every chat, so Claude can open and drive
// other sessions ("child sessions"). It forwards each tool call to the main server.
import { call, serve, SELF } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'start_session',
    description:
      'Start a new Claude chat session that runs in parallel and shows up in the user\'s sidebar as a child of this session. Use it when the user asks you to open, spawn or delegate to another session, or to work on something in parallel. Returns the new session id. The child works on its own and reports back with messages that arrive in this chat (progress, questions, its final result); you can also check on it with read_session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The first message for the new session: a complete, self-contained task description.' },
        name: { type: 'string', description: 'Short title for the session (shown in the sidebar).' },
        cwd: { type: 'string', description: 'Folder to run in. Defaults to this session\'s folder.' },
        worktree: { type: 'boolean', description: 'Run in a fresh git worktree on its own branch, so its edits do not collide with this session.' },
        permission_mode: { type: 'string', enum: ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Permission mode for the child. Defaults to this session\'s mode.' },
        model: { type: 'string', description: 'Model for the child (defaults to this session\'s model). Model alias or name, e.g. sonnet, opus, fable, haiku, or a full model id. "default" for the account default.' },
        effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'How hard the model thinks.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'set_session_options',
    description:
      "Change another session's model, effort or permission mode (for example switch a child to sonnet). Takes effect from its next message; a model or mode change also applies mid-turn. Same as the user changing them in that chat's composer.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        model: { type: 'string', description: 'Model alias or name, e.g. sonnet, opus, fable, haiku, or a full model id. "default" for the account default.' },
        effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'How hard the model thinks.' },
        permission_mode: { type: 'string', enum: ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'send_to_session',
    description:
      'Send a message to another session: a child you started, your parent (id "parent"), or any chat. Works in every direction; the other side sees which session sent it (with your session id) and can answer the same way. ' +
      'By default it is non-blocking: use it for instructions, progress updates and final results, and keep working. ' +
      'Set wait_for_reply=true to ask a blocking question: the call waits until that session replies to you with send_to_session and returns the reply. ' +
      'If the other session is busy, the message is queued and delivered in order when its current turn ends (steer=true stops its turn and delivers right away). If that session is waiting on a question to you, your message is its reply. ' +
      '"/model <name>", "/effort <level>" and "/mode <mode>" run as commands instead of being sent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id (full, or a unique prefix), a chat name, or "parent" for the chat that started this one.' },
        message: { type: 'string', description: 'The message. For a question, make it clear and self-contained.' },
        wait_for_reply: { type: 'boolean', description: 'Block until the other session replies, and return its reply. Default false.' },
        steer: { type: 'boolean', description: 'Steer immediately: if the other session is busy, stop its current turn and deliver this right away instead of queueing it. Only for urgent course corrections. Default false.' },
        timeout_minutes: { type: 'number', description: 'With wait_for_reply: give up after this long (default 60). A later reply still arrives as a new message.' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'read_session',
    description:
      'Get a chat session\'s status (idle, busy, waiting for permission) and its latest reply. Set wait=true to block until it finishes its current turn (up to timeout_seconds, default 300). ' +
      'Only for chats of this web UI (ids from start_session or list_sessions). Subagents you started with your Agent/Task tool and background shells are not sessions: their results come back to you by themselves; message a subagent with SendMessage and stop one with TaskStop.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, wait: { type: 'boolean' }, timeout_seconds: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'stop_session',
    description: "Stop another session's current turn (like the user pressing Stop). It keeps its conversation; send it a message to continue.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'archive_session',
    description: 'Archive a session (hides it from the sidebar list; nothing is deleted), or unarchive it with archived=false.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, archived: { type: 'boolean', description: 'Default true.' } }, required: ['id'] },
  },
  {
    name: 'rename_session',
    description: "Set a session's title (shown in the sidebar). Use your own session id to rename this chat.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
  },
  {
    name: 'list_sessions',
    description: 'List sessions on this server (chats on other machines are not included). By default only the children of this session; set all=true for every chat (do this to find a chat you did not start). send_to_session and read_session take a full id, a unique id prefix, or a chat name.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  },
];

async function runTool(name, a = {}) {
  // The CLI may defer this server's schemas behind tool search, so a model can call a tool
  // before it has seen the schema and guess the argument name. Take the usual guesses.
  if (a.id == null) a.id = ['session_id', 'sessionId', 'to', 'target', 'session', 'recipient'].map((k) => a[k]).find((v) => v != null);
  if (a.message == null) a.message = ['text', 'content', 'body', 'prompt'].map((k) => a[k]).find((v) => v != null);
  const needsId = ['set_session_options', 'send_to_session', 'read_session'].includes(name);
  if (needsId && (a.id == null || String(a.id).trim() === '')) {
    throw new Error(`Missing "id". Call ${name} with {"id": "<session id>"${name === 'send_to_session' ? ', "message": "..."' : ''}}; use "parent" as the id for the chat that started this one.`);
  }
  if (name === 'send_to_session' && !String(a.message ?? '').trim()) throw new Error('Missing "message". Call send_to_session with {"id": "...", "message": "..."}.');
  if (needsId) a.id = String(a.id).trim();
  switch (name) {
    case 'start_session':
      return call('POST', '/internal/sessions', { parentId: SELF, prompt: a.prompt, name: a.name, cwd: a.cwd, worktree: !!a.worktree, permissionMode: a.permission_mode, model: a.model, effort: a.effort });
    case 'set_session_options':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id)}/options`, { model: a.model, effort: a.effort, permissionMode: a.permission_mode });
    case 'send_to_session':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id)}/send`, { message: a.message, wait_for_reply: !!a.wait_for_reply, steer: !!a.steer, timeout_minutes: a.timeout_minutes });
    case 'read_session': {
      const t = Math.min(Math.max(Number(a.timeout_seconds) || 300, 1), 1800);
      return call('GET', `/internal/sessions/${encodeURIComponent(a.id)}?wait=${a.wait ? 1 : 0}&timeout=${t}`);
    }
    case 'stop_session':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id)}/control/stop`, {});
    case 'archive_session':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id)}/control/${a.archived === false ? 'unarchive' : 'archive'}`, {});
    case 'rename_session':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id === 'self' ? SELF : a.id)}/control/rename`, { title: a.title ?? a.name });
    case 'list_sessions':
      return call('GET', `/internal/sessions${a.all ? '' : `?parentId=${encodeURIComponent(SELF)}`}`);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

serve('sessions', TOOLS, runTool);
