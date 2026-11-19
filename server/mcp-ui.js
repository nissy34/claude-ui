#!/usr/bin/env node
// Built-in stdio MCP server for things a chat shows in the web UI. update_plan puts a live task
// list above the message box (the UI reads the tool call itself, so the server only acknowledges).
// publish_artifact shows a report (an existing file, or HTML/Markdown content) in the chat's
// side panel and the Artifacts gallery.
import { call, serve } from './mcp-stdio.js';

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
  {
    name: 'publish_artifact',
    description:
      'Publish a report, page or document as an artifact: it opens for the user in the side panel of this chat and is listed on the Artifacts page of this web UI. ' +
      'This is the Artifact (publish) tool of this UI: use it whenever you would publish or share an artifact, or when you made a report the user should look at. ' +
      'Pass path to publish a file that already exists (HTML, Markdown, SVG, image, PDF or CSV; an HTML file\'s relative CSS, JS and images load too), ' +
      'or content plus format to publish new HTML or Markdown. Call it once per file. Publishing only shows it to the user inside this UI; nothing is shared outside.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'An existing file to publish, absolute or relative to the working directory, e.g. "runs/2026-11-19/report.html".' },
        content: { type: 'string', description: 'The full HTML document or Markdown text to publish, when there is no file yet. Do not pass with path.' },
        format: { type: 'string', enum: ['html', 'markdown', 'svg', 'csv'], description: 'Format of content. Default: html when content starts with "<", else markdown.' },
        title: { type: 'string', description: 'Short name shown to the user, e.g. "Density run 2 report". Also names the file for content.' },
        description: { type: 'string', description: 'One sentence on what it shows.' },
      },
    },
  },
];

serve('ui', TOOLS, (name, a = {}) => {
  if (name === 'publish_artifact') return call('POST', '/internal/artifacts/publish', a);
  if (name !== 'update_plan') throw new Error(`Unknown tool ${name}`);
  const steps = Array.isArray(a.steps) ? a.steps : [];
  if (!steps.length) throw new Error('steps is required: a list of {step, status}.');
  const done = steps.filter((s) => s.status === 'completed').length;
  return { content: [{ type: 'text', text: `Plan shown to the user (${done}/${steps.length} done).` }] };
});
