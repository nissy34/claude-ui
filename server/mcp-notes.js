#!/usr/bin/env node
// Built-in stdio MCP server for shared notes: the same notes Claude Desktop reads and writes
// through the handoff MCP (/mcp). Forwards each call to the main server's /internal API.
import { call, serve } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'list_notes',
    description:
      "List the shared notes (newest first). They are shared with the user's Claude Desktop app and every chat in this UI: handoffs, decisions, preferences, things to remember. Check them when the user refers to earlier work or to something discussed in Claude Desktop.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for.' }, tag: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'read_note',
    description: 'Read one shared note in full, by id or exact title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id or exact title.' } }, required: ['id'] },
  },
  {
    name: 'write_note',
    description:
      'Create or update a shared note that Claude Desktop and other chats can read. A note with the same title (or the given id) is replaced, or added to with append=true. Use it when the user asks you to remember something, or to leave a handoff summary for Claude Desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown.' },
        tags: { type: 'array', items: { type: 'string' } },
        append: { type: 'boolean' },
        id: { type: 'string' },
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

serve('notes', TOOLS, (name, a = {}) => {
  if (name === 'list_notes') return call('POST', '/internal/notes/list', a);
  if (name === 'read_note') return call('POST', '/internal/notes/read', { id: a.id ?? a.title });
  if (name === 'write_note') return call('POST', '/internal/notes/write', a);
  if (name === 'delete_note') return call('POST', '/internal/notes/delete', { id: a.id ?? a.title });
  throw new Error(`Unknown tool ${name}`);
});
