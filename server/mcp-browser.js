#!/usr/bin/env node
// The built-in browser as an MCP server. The tab is shared with the Browser panel in the
// web UI, so the user watches (and can take over) what Claude does.
import { call, serve, SELF } from './mcp-stdio.js';

const ref = { ref: { type: 'number', description: 'Element number from the latest snapshot ([n] in the elements list).' }, selector: { type: 'string', description: 'CSS selector, if there is no ref.' }, text: { type: 'string', description: 'Visible text to find, if there is no ref or selector.' } };

const TOOLS = [
  {
    name: 'navigate',
    description:
      "Open a URL in the built-in browser (a headless Chromium on the user's server, shown live in the user's Browser panel). Use it to check web apps you build or run: start the dev server with Bash in the background, then open http://localhost:<port>. Returns the page title, its visible text and a numbered list of interactive elements.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  { name: 'snapshot', description: 'Get the current page: URL, title, visible text and numbered interactive elements (use the numbers as ref in click/type).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page to check layout and visuals.',
    inputSchema: { type: 'object', properties: { full_page: { type: 'boolean', description: 'Capture the whole scrollable page.' } } },
  },
  { name: 'click', description: 'Click an element (by ref, selector or text) or a point (x, y in CSS pixels).', inputSchema: { type: 'object', properties: { ...ref, x: { type: 'number' }, y: { type: 'number' } } } },
  {
    name: 'type',
    description: 'Fill a text field (by ref, selector or text), or type into the focused element when no target is given. submit=true presses Enter afterwards.',
    inputSchema: { type: 'object', properties: { ...ref, value: { type: 'string', description: 'Text to enter.' }, submit: { type: 'boolean' } }, required: ['value'] },
  },
  { name: 'press_key', description: 'Press a key or chord, e.g. Enter, Escape, ArrowDown, Control+A.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'scroll', description: 'Scroll the page by dy pixels (negative scrolls up).', inputSchema: { type: 'object', properties: { dy: { type: 'number' }, dx: { type: 'number' } } } },
  { name: 'back', description: 'Go back in history.', inputSchema: { type: 'object', properties: {} } },
  { name: 'reload', description: 'Reload the page.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'evaluate',
    description: 'Run JavaScript in the page and return the result (an expression, or a function body with return).',
    inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
  },
  { name: 'console', description: 'Read recent console messages and page errors.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, clear: { type: 'boolean' } } } },
  { name: 'resize', description: 'Set the viewport size, e.g. 390x844 to check a phone layout.', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] } },
  { name: 'wait_for', description: 'Wait for text to appear, or for a number of seconds.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, seconds: { type: 'number' } } } },
];

const OPS = { navigate: 'navigate', snapshot: 'snapshot', click: 'click', type: 'type', press_key: 'press', scroll: 'scroll', back: 'back', reload: 'reload', evaluate: 'evaluate', console: 'console', resize: 'resize', wait_for: 'wait' };

function fmt(out) {
  if (!out || !('url' in out)) return out;
  const text = `URL: ${out.url}\nTitle: ${out.title}\n\nInteractive elements:\n${out.elements.join('\n') || '(none)'}\n\nPage text:\n${out.text}`;
  return { content: [{ type: 'text', text }] };
}

async function runTool(name, a) {
  const base = `/internal/browser/${encodeURIComponent(SELF)}`;
  if (name === 'screenshot') {
    const buf = await call('GET', `${base}/screenshot?full=${a.full_page ? 1 : 0}`, null, { raw: true });
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
  }
  const op = OPS[name];
  if (!op) throw new Error(`Unknown tool ${name}`);
  // For type, "text" finds the element and "value" is what gets typed.
  const args = name === 'type' ? { ref: a.ref, selector: a.selector, findText: a.text, text: a.value, submit: a.submit } : a;
  return fmt(await call('POST', `${base}/${op}`, args));
}

serve('browser', TOOLS, runTool);
