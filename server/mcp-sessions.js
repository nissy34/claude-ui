#!/usr/bin/env node
// A tiny stdio MCP server that the web UI gives to every chat, so Claude can open and drive
// other sessions ("child sessions"). It forwards each tool call to the main server.
import readline from 'node:readline';

const API = process.env.CW_INTERNAL_URL;
const TOKEN = process.env.CW_INTERNAL_TOKEN;
const SELF = process.env.CW_SESSION_ID;

const TOOLS = [
  {
    name: 'start_session',
    description:
      'Start a new Claude chat session that runs in parallel and shows up in the user\'s sidebar as a child of this session. Use it when the user asks you to open, spawn or delegate to another session, or to work on something in parallel. Returns the new session id. The child works on its own; use read_session to check on it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The first message for the new session: a complete, self-contained task description.' },
        name: { type: 'string', description: 'Short title for the session (shown in the sidebar).' },
        cwd: { type: 'string', description: 'Folder to run in. Defaults to this session\'s folder.' },
        worktree: { type: 'boolean', description: 'Run in a fresh git worktree on its own branch, so its edits do not collide with this session.' },
        permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Permission mode for the child. Defaults to this session\'s mode.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'send_to_session',
    description: 'Send a follow-up message to another session (for example a child you started).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, message: { type: 'string' } },
      required: ['id', 'message'],
    },
  },
  {
    name: 'read_session',
    description:
      'Get a session\'s status (idle, busy, waiting for permission) and its latest reply. Set wait=true to block until it finishes its current turn (up to timeout_seconds, default 300).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, wait: { type: 'boolean' }, timeout_seconds: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List sessions. By default only the children of this session; set all=true for every session.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  },
];

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-cw-token': TOKEN, 'x-cw-session': SELF },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function runTool(name, a = {}) {
  switch (name) {
    case 'start_session':
      return call('POST', '/internal/sessions', { parentId: SELF, prompt: a.prompt, name: a.name, cwd: a.cwd, worktree: !!a.worktree, permissionMode: a.permission_mode });
    case 'send_to_session':
      return call('POST', `/internal/sessions/${encodeURIComponent(a.id)}/send`, { message: a.message });
    case 'read_session': {
      const t = Math.min(Math.max(Number(a.timeout_seconds) || 300, 1), 1800);
      return call('GET', `/internal/sessions/${encodeURIComponent(a.id)}?wait=${a.wait ? 1 : 0}&timeout=${t}`);
    }
    case 'list_sessions':
      return call('GET', `/internal/sessions${a.all ? '' : `?parentId=${encodeURIComponent(SELF)}`}`);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sessions', version: '1.0.0' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      try {
        const out = await runTool(params.name, params.arguments);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
