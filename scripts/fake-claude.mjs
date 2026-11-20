#!/usr/bin/env node
// A stand-in for the `claude` CLI in stream-JSON mode, for tests (CW_CLAUDE_BIN=scripts/fake-claude.mjs).
// It starts the MCP servers from --mcp-config and follows directives found in each prompt:
//   @@call <server>__<tool> <json>   call that MCP tool (shown as a tool_use + tool_result)
//   @@say <text>                     reply with text
//   @@sleep <ms>                     wait (keeps the turn running)
//   @@fail [text]                    end the turn with an error (text = the error)
//   @@write <path> <text>            write a file in the working folder (like an Edit)
//   @@writetool <path> <text>        the same, shown as a Write tool_use + tool_result (as the real CLI does)
//   @@bashfail <command>             a Bash call that fails (tool_result with is_error)
// PostToolUse HTTP hooks from --settings run after each tool call, like the real CLI's
// ($VAR headers from allowedEnvVars); additionalContext they return is logged as hookContext.
// Directives inside a JSON argument are passed along verbatim, so a test can make one session
// tell another what to do. With no directive it replies "ok: <first line of the prompt>".
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = arg('--session-id') || arg('--resume') || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = process.env.FAKE_CLAUDE_LOG;
const note = (o) => log && fs.appendFileSync(log, JSON.stringify({ pid: process.pid, sessionId, ...o }) + '\n');
note({ argv });

// ---- MCP clients ----
const servers = {};
let mcpCfg = {};
try {
  mcpCfg = JSON.parse(arg('--mcp-config') || '{}').mcpServers || {};
} catch {}
for (const [name, cfg] of Object.entries(mcpCfg)) {
  if (cfg.type && cfg.type !== 'stdio') continue;
  const p = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map();
  let id = 0;
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    try {
      const m = JSON.parse(l);
      waiters.get(m.id)?.(m);
      waiters.delete(m.id);
    } catch {}
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const i = ++id;
      waiters.set(i, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  servers[name] = { rpc, proc: p, ready: rpc('initialize', { protocolVersion: '2024-11-05' }) };
}

let hooks = [];
try {
  const st = JSON.parse(arg('--settings') || '{}');
  hooks = (st.hooks?.PostToolUse || []).flatMap((h) => h.hooks || []).filter((h) => h.type === 'http');
} catch {}
async function postToolUse(toolName, input, response) {
  for (const h of hooks) {
    const allowed = new Set(h.allowedEnvVars || []);
    const headers = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(h.headers || {})) headers[k] = String(v).replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, n) => (allowed.has(n) ? process.env[n] || '' : ''));
    try {
      const r = await fetch(h.url, { method: 'POST', headers, body: JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: input, tool_response: response }) });
      const j = await r.json().catch(() => ({}));
      const ctx = j.hookSpecificOutput?.additionalContext;
      if (ctx) note({ hookContext: ctx });
    } catch (e) {
      note({ hookError: e.message });
    }
  }
}

out({ type: 'system', subtype: 'init', session_id: sessionId, model: arg('--model') || 'fake-model', permissionMode: arg('--permission-mode') || 'default', tools: [], mcp_servers: Object.keys(servers).map((n) => ({ name: n, status: 'connected' })), slash_commands: [], claude_code_version: 'fake' });

let msgN = 0;
const queue = [];
let running = false;

async function runTurn(text) {
  const t0 = Date.now();
  const lines = text.split('\n');
  let said = false;
  let failed = false;
  // Only top-level directives of the prompt (not ones nested inside JSON strings).
  for (const line of lines) {
    const m = /^@@(call|say|sleep|fail|write|writetool|bashfail)\b\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, cmd, rest] = m;
    if (cmd === 'say') {
      out({ type: 'assistant', message: { id: `msg_${++msgN}`, role: 'assistant', content: [{ type: 'text', text: rest }], usage: { input_tokens: 100, output_tokens: 10 } }, parent_tool_use_id: null, session_id: sessionId });
      said = true;
    } else if (cmd === 'sleep') {
      await new Promise((r) => setTimeout(r, Number(rest) || 100));
    } else if (cmd === 'fail') {
      failed = rest || true;
    } else if (cmd === 'write') {
      const sp = rest.indexOf(' ');
      const file = sp < 0 ? rest : rest.slice(0, sp);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(path.resolve(file), (sp < 0 ? '' : rest.slice(sp + 1)) + '\n');
      await postToolUse('Write', { file_path: file }, 'ok');
    } else if (cmd === 'writetool') {
      const sp = rest.indexOf(' ');
      const file = path.resolve(sp < 0 ? rest : rest.slice(0, sp));
      const useId = `toolu_${crypto.randomBytes(6).toString('hex')}`;
      out({ type: 'assistant', message: { id: `msg_${++msgN}`, role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'Write', input: { file_path: file, content: sp < 0 ? '' : rest.slice(sp + 1) } }] }, parent_tool_use_id: null, session_id: sessionId });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, (sp < 0 ? '' : rest.slice(sp + 1)) + '\n');
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: `File created successfully at: ${file}` }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() });
      await postToolUse('Write', { file_path: file }, 'ok');
    } else if (cmd === 'bashfail') {
      const useId = `toolu_${crypto.randomBytes(6).toString('hex')}`;
      out({ type: 'assistant', message: { id: `msg_${++msgN}`, role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'Bash', input: { command: rest } }] }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: 'Exit code 1\nboom', is_error: true }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() });
      await postToolUse('Bash', { command: rest }, 'Exit code 1');
    } else if (cmd === 'call') {
      const sp = rest.indexOf(' ');
      const full = sp < 0 ? rest : rest.slice(0, sp);
      let input = {};
      try {
        input = sp < 0 ? {} : JSON.parse(rest.slice(sp + 1));
      } catch (e) {
        input = { _parseError: e.message };
      }
      const [server, tool] = full.split('__');
      const useId = `toolu_${crypto.randomBytes(6).toString('hex')}`;
      out({ type: 'assistant', message: { id: `msg_${++msgN}`, role: 'assistant', content: [{ type: 'tool_use', id: useId, name: `mcp__${server}__${tool}`, input }] }, parent_tool_use_id: null, session_id: sessionId });
      let result = 'no such server';
      const s = servers[server];
      if (s) {
        await s.ready;
        const r = await s.rpc('tools/call', { name: tool, arguments: input });
        result = r.result?.content?.map((c) => c.text).join('\n') || JSON.stringify(r.error || r);
      }
      note({ call: full, input, result: result.slice(0, 1500) });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: result }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() });
      await postToolUse(`mcp__${server}__${tool}`, input, result);
    }
  }
  if (!said && !failed && !lines.some((l) => /^@@(call|write|writetool|bashfail)/.test(l.trim()))) {
    out({ type: 'assistant', message: { id: `msg_${++msgN}`, role: 'assistant', content: [{ type: 'text', text: `ok: ${lines.find((l) => l.trim()) || ''}`.slice(0, 200) }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  out({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: failed ? (typeof failed === 'string' ? failed : 'fake failure') : 'done', duration_ms: Date.now() - t0, num_turns: 1, total_cost_usd: 0.001, session_id: sessionId });
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) await runTurn(queue.shift());
  running = false;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_request') {
    const sub = m.request?.subtype;
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: sub === 'initialize' ? { commands: [], models: [] } : {} } });
    if (sub === 'interrupt') queue.length = 0;
    return;
  }
  if (m.type === 'user') {
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    note({ prompt: text.slice(0, 20000) });
    out({ type: 'user', message: m.message, uuid: crypto.randomUUID(), session_id: sessionId, parent_tool_use_id: null });
    queue.push(text);
    drain();
  }
});
process.stdin.on('end', () => {
  for (const s of Object.values(servers)) s.proc.kill();
  setTimeout(() => process.exit(0), 50);
});
