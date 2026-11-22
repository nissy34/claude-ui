#!/usr/bin/env node
// Built-in stdio MCP server for the Assistant chat (the chief of staff you talk to from Teams or the
// web UI). Every tool forwards to the main server's /internal/assistant/* API, which uses the same
// code paths as the web UI and the Teams bridge.
import { call, serve } from './mcp-stdio.js';

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'overview',
    description: 'Everything at a glance: requests waiting on the user (permission prompts, questions, plans, sign-ins, project decisions), projects with thread counts, and chats that are working. Start here when the user asks what is going on or refers to something you have not looked up yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'answer_request',
    description:
      'Answer one request that is waiting on the user, on their behalf. Only when the user\'s latest message clearly says what to answer for this specific request; if it could mean more than one request, or the answer is unclear, ask them instead. ' +
      'quote must be the words from the user\'s latest message that give this answer; the server checks it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The request id from overview, e.g. perm:… or decision:….'),
        quote: str("The user's own words that answer it, copied from their latest message."),
        behavior: { type: 'string', enum: ['allow', 'always', 'deny'], description: 'For permission prompts and plans.' },
        choice: { type: 'number', description: 'For decisions: the option number, starting at 1.' },
        text: str('For questions: the answer (an option label or the user\'s words; one line per question). For a deny: the reason, if they gave one.'),
      },
      required: ['id', 'quote'],
    },
  },
  {
    name: 'project_status',
    description: "A project's threads, open decisions and the latest coordinator messages.",
    inputSchema: { type: 'object', properties: { project: str('Project name or id.') }, required: ['project'] },
  },
  {
    name: 'message_project',
    description: "Send the user's message to a project's coordinator, which plans and hands work to threads. Use for anything about a project's work.",
    inputSchema: { type: 'object', properties: { project: str('Project name or id.'), text: str('What to tell the coordinator, in the user\'s words where possible.') }, required: ['project', 'text'] },
  },
  {
    name: 'list_folders',
    description: 'The folders (repositories) a new chat can work in.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_chat',
    description: 'Start a new Claude Code chat in a folder with a task. The user hears back when it finishes. Use for one-off work outside a project.',
    inputSchema: { type: 'object', properties: { folder: str('Folder name from list_folders.'), task: str('The task, complete enough to work from.') }, required: ['folder', 'task'] },
  },
  {
    name: 'find_chats',
    description: 'Search chats by name or folder (most recent first).',
    inputSchema: { type: 'object', properties: { query: str('Words to match; empty for the most recent.') } },
  },
  {
    name: 'read_chat',
    description: 'What a chat is doing: its state, plan, recent activity and the end of its transcript.',
    inputSchema: { type: 'object', properties: { chat: str('Chat id or name.') }, required: ['chat'] },
  },
  {
    name: 'message_chat',
    description: 'Send a message to an existing chat (outside projects, or a project thread to steer it).',
    inputSchema: { type: 'object', properties: { chat: str('Chat id or name.'), text: str('The message.') }, required: ['chat', 'text'] },
  },
  {
    name: 'open_thread',
    description:
      "Point the user to one chat's (or project's) own thread in the Teams channel, making it if it doesn't exist yet. Use it when they ask about one specific chat or project, or want more detail than a short summary: answer in a sentence and open its thread, where that chat answers them itself. The link is added under your reply; don't write one.",
    inputSchema: { type: 'object', properties: { chat: str('Chat id or name.'), project: str('Or: a project name or id.') } },
  },
  {
    name: 'stop_chat',
    description: 'Stop what a chat is doing. Only when the user asks.',
    inputSchema: { type: 'object', properties: { chat: str('Chat id or name.') }, required: ['chat'] },
  },
];

serve('assistant', TOOLS, (name, a = {}) => call('POST', `/internal/assistant/${name}`, a));
