#!/usr/bin/env node
// claude-ui bridge: lets Claude Desktop use the claude-ui handoff MCP on another computer.
//
// Claude Desktop starts local MCP servers from claude_desktop_config.json and talks to them over
// stdin/stdout. This script is that local server: it forwards every message to claude-ui's
// /mcp endpoint over HTTP with your token, and writes the answers back. No dependencies; needs
// Node 18 or newer.
//
//   node claude-ui-bridge.mjs http://192.168.1.20:8787/mcp      (token in CLAUDE_UI_TOKEN)
//   node claude-ui-bridge.mjs http://192.168.1.20:8787/mcp --token <token>
import readline from 'node:readline';
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const TOKEN = flag('--token') || process.env.CLAUDE_UI_TOKEN || '';
const URL_ = new URL(args[0] || process.env.CLAUDE_UI_URL || 'http://127.0.0.1:8787/mcp');
const log = (...m) => process.stderr.write(`[claude-ui-bridge] ${m.join(' ')}\n`);
if (!TOKEN) log('No token: set CLAUDE_UI_TOKEN or pass --token (copy it from claude-ui Settings > Claude Desktop).');

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

function post(body) {
  const data = JSON.stringify(body);
  const lib = URL_.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      URL_,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function forward(msg) {
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  const fail = (message) => hasId && send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
  let r;
  try {
    r = await post(msg);
  } catch (e) {
    log(`Can't reach ${URL_.href}: ${e.message}`);
    return fail(`Can't reach claude-ui at ${URL_.href} (${e.message}). Is the server running, and is this computer on the same network?`);
  }
  if (r.status === 202 || !r.text.trim()) return;
  let out;
  try {
    out = JSON.parse(r.text);
  } catch {
    return fail(`claude-ui answered HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  }
  if (r.status >= 400 && !out.jsonrpc) return fail(`claude-ui: ${out.error || `HTTP ${r.status}`}`);
  for (const m of Array.isArray(out) ? out : [out]) send(m);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return log('Ignoring a line that is not JSON');
  }
  forward(msg);
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
