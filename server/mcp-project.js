#!/usr/bin/env node
// Built-in stdio MCP server for sessions in a Project. The role (coordinator or thread) comes
// from the server's record of this session, so a thread can't call coordinator tools; this
// process only lists the tools for its role and forwards calls to /internal/cproject/tool.
import { call, serve } from './mcp-stdio.js';

const ROLE = process.argv[2] === 'coordinator' ? 'coordinator' : 'thread';

const cite = { type: 'array', items: { type: 'string' }, description: "Event ids of the user's messages this is about (from the wake envelope). The engine inserts the user's exact words for the receiver; never paraphrase them instead." };
const steps = {
  type: 'array',
  description: 'Every step, in order.',
  items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['step', 'status'] },
};
const memory = [
  { name: 'memory_list', description: 'List the project memory files (name, one-line description, version). The index is also in your system prompt.', inputSchema: { type: 'object', properties: {} } },
  { name: 'memory_read', description: 'Read one project memory file: its content and version.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  {
    name: 'memory_write',
    description:
      'Create or replace a project memory file: notes every session in this project shares (requirements, decisions, pitfalls, how things work). One file per subject, not one per fact; under 4 KB. To change an existing file, memory_read it first and pass its version as base_version (a stale write is refused with the current text to merge). Never store secrets. Do not save what the code or git history already records.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case subject, e.g. "deploy-process".' },
        description: { type: 'string', description: 'One line on what the file covers (shown in the index).' },
        content: { type: 'string', description: 'The whole file body (Markdown). For a decision or rule, add **Why:** and **How to apply:** lines. Link related files with [[their-name]].' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'user: about the user; feedback: how they want work done; project: goals, decisions, constraints; reference: pointers to outside resources.' },
        base_version: { type: 'string', description: 'Version from memory_read, required when the file exists.' },
      },
      required: ['name', 'description', 'content'],
    },
  },
  { name: 'memory_delete', description: 'Delete a project memory file that turned out wrong or obsolete. Pass the version you read.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, base_version: { type: 'string' } }, required: ['name', 'base_version'] } },
];
const decision = {
  name: 'request_decision',
  description:
    'Put a multiple-choice decision card in front of the user: one question, 2 to 4 options, one recommended. Use it when a choice changes the user\'s goal or a step cannot be undone. Ask once; the answer arrives later as an event that wakes you. Keep working on the recommended option meanwhile, unless the step cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Verb first, about twelve words.' },
      options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'At most ~40 characters.' }, consequence: { type: 'string', description: 'One sentence: what happens if picked.' } }, required: ['label'] }, minItems: 2, maxItems: 4 },
      recommended: { type: 'number', description: 'Index of the recommended option, from 0.' },
      reason: { type: 'string', description: 'Why you recommend it, one sentence.' },
      irreversible: { type: 'boolean', description: 'True when an option starts a step that cannot be undone. Then only the user, in the web UI, can answer it.' },
      distinct: { type: 'boolean', description: "Coordinator only: true to ask although a thread has an open card, because your question is a different one. Never re-ask a thread's question." },
    },
    required: ['question', 'options', 'recommended'],
  },
};
const react = { name: 'react', description: "React with an emoji to a message (by its event id) instead of replying, e.g. 👀 when you start on the user's message and the work comes first.", inputSchema: { type: 'object', properties: { event_id: { type: 'string' }, emoji: { type: 'string' } }, required: ['event_id', 'emoji'] } };
const search = {
  name: 'project_search',
  description: "Search the project (plain text, no model): memory, shared notes, threads' reports, the project chat and other threads' conversations. Returns snippets with their source and thread. Use it before digging into setup, a build or a strange error, and before asking the coordinator.",
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A few words, e.g. "vitest jsdom canvas" or an error message.' }, limit: { type: 'number' } }, required: ['query'] },
};
const board = { name: 'board', description: 'The board: every open thread with its status, current step, last post, the files its branch changed and what it waits on.', inputSchema: { type: 'object', properties: {} } };
const readThread = { name: 'read_thread', description: "Read a thread's transcript (its messages and replies, tools left out) without waking it.", inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, max_chars: { type: 'number' } }, required: ['thread_id'] } };
const listThreads = { name: 'list_threads', description: "The project's threads: id, title, status (Working, Waiting on you, Ready for review, Idle, Queued, Snoozed, Resolved), checklist progress and last post.", inputSchema: { type: 'object', properties: { include_resolved: { type: 'boolean' } } } };

const pinView = {
  name: 'pin_view',
  description: "Pin a page you wrote as the project's Custom view: a panel tab beside the project chat that shows it live, e.g. a dashboard, a checklist or a weekly digest. Write a self-contained .html file (inline CSS/JS) first; rewriting the file later updates the view. One view per project; pinning replaces it.",
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The .html file, absolute or relative to your working folder.' }, title: { type: 'string' } }, required: ['path'] },
};

const COORDINATOR = [
  { name: 'post_message', description: 'Post a message to the user in the project chat. This is the only way the user sees what you say. Lead with the outcome or the ask; keep it short.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Markdown.' }, thread_id: { type: 'string', description: 'The thread this post is about, if one: the chat labels it with that thread.' }, thread_ids: { type: 'array', items: { type: 'string' }, description: 'Several threads this post is about (a joint report): labeled "N threads".' }, cite_ids: cite }, required: ['text'] } },
  {
    name: 'start_thread',
    description:
      'Start a thread: a parallel Claude Code session in its own git worktree and branch that does the work. Give a complete, self-contained brief (goal, what is known, what done looks like) and cite the user\'s message ids. Returns the thread_id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Goal-first title, 3 to 6 words, sentence case, e.g. "Fix Safari export button".' },
        brief: { type: 'string', description: 'The task for the thread, self-contained.' },
        cite_ids: cite,
        model: { type: 'string', description: 'Override the project\'s thread model for a small job (e.g. "sonnet", "haiku"). Usually leave empty.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Thread ids whose work this one needs; lets the two message each other, and the engine wakes this thread when they resolve.' },
        new: { type: 'boolean', description: 'Start it even though similar threads exist (the first call returns them instead of starting).' },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'suggest_thread',
    description: 'Suggest a thread instead of starting it: the user sees a card with Start and Dismiss. Use it for optional or speculative work you noticed (a follow-up cleanup, a test gap, a risky refactor) that the user did not ask for. Work the user asked for gets start_thread.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Goal-first title, 3 to 6 words.' },
        brief: { type: 'string', description: 'The self-contained brief the thread would get.' },
        reason: { type: 'string', description: 'One line on why it is worth doing, shown on the card.' },
      },
      required: ['title', 'brief'],
    },
  },
  { name: 'message_thread', description: 'Send a message to an existing thread (more work in its area, an answer, a correction). Delivered when the thread is idle; reopens a resolved thread.', inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, text: { type: 'string' }, cite_ids: cite }, required: ['thread_id', 'text'] } },
  listThreads,
  readThread,
  board,
  search,
  { name: 'stop_thread', description: "Stop a thread's current turn and drop what was queued for it.", inputSchema: { type: 'object', properties: { thread_id: { type: 'string' } }, required: ['thread_id'] } },
  { name: 'resolve_thread', description: 'Mark a thread Resolved when its work has ended (or reopen=true to reopen it).', inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, reopen: { type: 'boolean' } }, required: ['thread_id'] } },
  decision,
  react,
  {
    name: 'follow_up',
    description: 'Record a promise to the user ("I\'ll tell you when both are done"). The engine wakes you when those threads settle, even after your conversation is reset.',
    inputSchema: { type: 'object', properties: { thread_ids: { type: 'array', items: { type: 'string' } }, note: { type: 'string', description: 'What you promised.' } }, required: ['thread_ids', 'note'] },
  },
  {
    name: 'set_policy',
    description: 'Save a preference the user stated, so it is enforced: proactivity (quiet: wake you only for user messages, blockers and errors; normal: also results; chatty: also periodic check-ins), check_in_minutes.',
    inputSchema: { type: 'object', properties: { proactivity: { type: 'string', enum: ['quiet', 'normal', 'chatty'] }, check_in_minutes: { type: 'number' }, reason: { type: 'string' } } },
  },
  { name: 'set_reminder', description: 'Snooze a thread until a time; the reminder wakes it.', inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, minutes: { type: 'number' }, hours: { type: 'number' }, at: { type: 'string', description: 'ISO time.' }, note: { type: 'string' } }, required: ['thread_id'] } },
  ...memory,
];

const THREAD = [
  {
    name: 'post_message',
    description:
      'Post to your thread feed. kind=result when the task is done (what changed, where, how you checked), blocker when you cannot continue, question for something only the user can answer: these reach the coordinator. kind=progress only for a real milestone (limited; use update_checklist for steps).',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Markdown, short and concrete.' }, kind: { type: 'string', enum: ['result', 'blocker', 'question', 'progress'] } }, required: ['text', 'kind'] },
  },
  { name: 'update_checklist', description: 'Show your progress as a checklist on your thread card. Send every step each time; exactly one in_progress while you work.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, steps }, required: ['steps'] } },
  decision,
  { name: 'message_coordinator', description: 'Message the coordinator about something it must act on (not status: it sees your posts and checklist).', inputSchema: { type: 'object', properties: { text: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['text'] } },
  { name: 'message_thread', description: 'Message another thread, only one you depend on or that depends on you.', inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, text: { type: 'string' } }, required: ['thread_id', 'text'] } },
  react,
  { name: 'set_reminder', description: 'Snooze yourself until a time (e.g. waiting for CI or a person); the reminder wakes you.', inputSchema: { type: 'object', properties: { minutes: { type: 'number' }, hours: { type: 'number' }, days: { type: 'number' }, at: { type: 'string' }, note: { type: 'string' } } } },
  {
    name: 'share',
    description:
      'Share a finding with the other threads in one line (under 300 characters): what you fixed and how, a gotcha, a reusable helper and where it is, a fact, or a warning. The engine hands it to the threads it matches (warnings to every open thread) at their next tool call or wake, without starting a turn, and keeps it searchable for 7 days. Give replaces with an earlier note id to correct it (no note = retract).',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One line, e.g. "vitest needs --pool=forks in this repo; threads segfault on canvas".' },
        kind: { type: 'string', enum: ['fix', 'gotcha', 'reusable', 'fact', 'warning'] },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths it is about: it reaches threads that changed them or whose brief names them.' },
        repo: { type: 'string', description: 'The repository it is about, when it names no files.' },
        durable: { type: 'boolean', description: 'Also save it to project memory (it then never expires).' },
        for_coordinator: { type: 'boolean', description: 'The coordinator should see it too (when a specific thread must hear it).' },
        replaces: { type: 'string', description: 'Id of an earlier note this corrects or retracts.' },
      },
      required: ['note', 'kind'],
    },
  },
  search,
  board,
  readThread,
  pinView,
  {
    name: 'resolve',
    description: 'Mark this thread Resolved: the work has ended and nothing is owed. learned is required: what later work or other threads should know (fixes, gotchas, helpers, facts), one line each, or [] when nothing; each item is saved to memory and shared.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Your result, if you have not posted one: what changed, where, how you checked; for a question, the complete answer written for the user, not a status line.' },
        learned: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { note: { type: 'string' }, kind: { type: 'string', enum: ['fix', 'gotcha', 'reusable', 'fact', 'warning'] }, files: { type: 'array', items: { type: 'string' } } }, required: ['note'] }] } },
      },
      required: ['learned'],
    },
  },
  listThreads,
  ...memory,
];

serve('project', ROLE === 'coordinator' ? COORDINATOR : THREAD, (name, args) => call('POST', '/internal/cproject/tool', { name, args }));
