#!/usr/bin/env node
// Built-in stdio MCP server for shared notes: the same notes Claude Desktop reads and writes
// through the handoff MCP (/mcp). Forwards each call to the main server's /internal API.
import { call, serve } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'list_notes',
    description:
      "List notes: this project's notes (stored in Claude Code's memory for the project, the same files your own auto-memory uses) and global notes (shared across every project and with the user's Claude Desktop app). Check them when the user refers to earlier work or to something discussed in Claude Desktop.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for.' }, tag: { type: 'string' }, limit: { type: 'number' }, project: { type: 'string', description: 'Another project (folder name or path). Default: this chat\'s project.' }, scope: { type: 'string', enum: ['project', 'global'], description: 'Only global notes with "global".' } } },
  },
  {
    name: 'read_note',
    description: 'Read one note in full, by id or title. Looks in this project first, then global notes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id or title.' }, project: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] } }, required: ['id'] },
  },
  {
    name: 'write_note',
    description:
      'Create or update a note. By default it goes into this project\'s memory (Claude Code loads it into every future session in this project, and Claude Desktop can read it); use scope "global" for things that apply across projects, like the user\'s preferences. A note with the same title (or id) is replaced, or added to with append=true. Use it when the user asks you to remember something, or to leave a handoff summary for Claude Desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown.' },
        tags: { type: 'array', items: { type: 'string' } },
        append: { type: 'boolean' },
        id: { type: 'string' },
        description: { type: 'string', description: 'One line shown in the memory index (defaults to the first line of content).' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Default project.' },
        project: { type: 'string', description: 'Another project (folder name or path). Default: this chat\'s project.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by id or title (this project first, then global).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, project: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] } }, required: ['id'] },
  },
];

serve('notes', TOOLS, (name, a = {}) => {
  if (name === 'list_notes') return call('POST', '/internal/notes/list', a);
  if (name === 'read_note') return call('POST', '/internal/notes/read', { ...a, id: a.id ?? a.title });
  if (name === 'write_note') return call('POST', '/internal/notes/write', a);
  if (name === 'delete_note') return call('POST', '/internal/notes/delete', { ...a, id: a.id ?? a.title });
  throw new Error(`Unknown tool ${name}`);
});
