#!/usr/bin/env node
// Scheduled tasks as an MCP server, so Claude can set one up from a chat ("every weekday at 9,
// check the build"). The user sees and manages them on the Scheduled page.
import { call, serve, SELF } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'create_scheduled_task',
    description:
      "Schedule a prompt to run later or repeatedly in a new chat, on the user's always-on server (local time). Use it when the user asks for something to happen at a time or on a schedule. Each run starts a fresh chat with the instructions, so write them as a complete, self-contained task.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, shown on the Scheduled page and in chat titles.' },
        prompt: { type: 'string', description: 'The instructions each run gets.' },
        preset: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'custom', 'manual'], description: 'once needs run_at; custom needs cron; manual only runs when started by hand.' },
        time: { type: 'string', description: 'HH:MM (24h) for daily, weekdays and weekly; for hourly only the minutes count.' },
        weekday: { type: 'number', description: 'For weekly: 0 = Sunday … 6 = Saturday.' },
        cron: { type: 'string', description: 'For custom: 5-field cron in local time, at most once an hour, e.g. "0 */3 * * *".' },
        run_at: { type: 'string', description: 'For once: an ISO date-time in local time, e.g. 2026-11-14T08:30.' },
        cwd: { type: 'string', description: "Folder to run in. Defaults to this chat's folder." },
        permission_mode: { type: 'string', enum: ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'], description: "Defaults to this chat's mode. Runs nobody watches stall on permission prompts in default mode." },
        model: { type: 'string' },
        worktree: { type: 'boolean', description: 'Run each time in a fresh git worktree.' },
      },
      required: ['name', 'prompt', 'preset'],
    },
  },
  { name: 'list_scheduled_tasks', description: 'List scheduled tasks with their next and last run.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'update_scheduled_task',
    description: 'Change, pause (enabled=false) or resume a scheduled task. Give only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, preset: { type: 'string' }, time: { type: 'string' }, weekday: { type: 'number' }, cron: { type: 'string' }, run_at: { type: 'string' }, enabled: { type: 'boolean' }, permission_mode: { type: 'string' } },
      required: ['id'],
    },
  },
  { name: 'delete_scheduled_task', description: 'Delete a scheduled task. Chats from earlier runs stay.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'run_scheduled_task_now', description: 'Start a run of a scheduled task right away.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

const body = (a) => {
  const b = { name: a.name, prompt: a.prompt, preset: a.preset, time: a.time, weekday: a.weekday, cron: a.cron, runAt: a.run_at, cwd: a.cwd, permissionMode: a.permission_mode, model: a.model, worktree: a.worktree, enabled: a.enabled };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
};

async function runTool(name, a = {}) {
  switch (name) {
    case 'create_scheduled_task':
      return call('POST', '/internal/schedules', { ...body(a), sessionId: SELF });
    case 'list_scheduled_tasks':
      return call('GET', '/internal/schedules');
    case 'update_scheduled_task':
      return call('POST', `/internal/schedules/${encodeURIComponent(a.id)}/update`, body(a));
    case 'delete_scheduled_task':
      return call('POST', `/internal/schedules/${encodeURIComponent(a.id)}/delete`, {});
    case 'run_scheduled_task_now':
      return call('POST', `/internal/schedules/${encodeURIComponent(a.id)}/run`, {});
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

serve('schedule', TOOLS, runTool);
