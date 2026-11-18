#!/usr/bin/env node
// Built-in stdio MCP server for things a chat shows in the web UI. update_plan puts a live task
// list above the message box (the UI reads the tool call itself, so the server only acknowledges).
import { serve } from './mcp-stdio.js';

const TOOLS = [
  {
    name: 'update_plan',
    description:
      'Show the user a live task list for the work in this chat. It appears above the message box and updates each time you call it. ' +
      'Use it for multi-step work: call it once with every step when you start, then again whenever a step starts or finishes. Send the whole list each time. ' +
      'Exactly one step should be in_progress while you work; mark all completed when done.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for the list, e.g. "Add dark mode".' },
        steps: {
          type: 'array',
          description: 'Every step, in order.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: 'What the step does, short.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
];

serve('ui', TOOLS, (name, a = {}) => {
  if (name !== 'update_plan') throw new Error(`Unknown tool ${name}`);
  const steps = Array.isArray(a.steps) ? a.steps : [];
  if (!steps.length) throw new Error('steps is required: a list of {step, status}.');
  const done = steps.filter((s) => s.status === 'completed').length;
  return { content: [{ type: 'text', text: `Plan shown to the user (${done}/${steps.length} done).` }] };
});
