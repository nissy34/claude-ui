// Minimal stdio MCP server loop shared by the built-in MCP servers. Each one forwards tool
// calls to the main server's /internal API.
import readline from 'node:readline';
import http from 'node:http';

export const API = process.env.CW_INTERNAL_URL;
export const SELF = process.env.CW_SESSION_ID;
const TOKEN = process.env.CW_INTERNAL_TOKEN;

// node:http rather than fetch: fetch gives up on a response after 5 minutes, and some calls
// (read_session wait, send_to_session wait_for_reply) legitimately block for longer.
// The server can be away for a few seconds while it restarts (the CLI keeps running in the
// session runner). A call that couldn't connect is retried for up to a minute; one that was cut off
// mid-way only when it is a GET, since a POST may already have done its work.
const RETRY_MS = Number(process.env.CW_INTERNAL_RETRY_MS) || 60_000;
const RETRYABLE = new Set(['ECONNREFUSED', 'ENOENT', 'EAI_AGAIN']);
const CUT = new Set(['ECONNRESET', 'EPIPE']);

export async function call(method, path, body, opts = {}) {
  const until = Date.now() + RETRY_MS;
  for (let wait = 250; ; wait = Math.min(wait * 2, 4000)) {
    try {
      return await callOnce(method, path, body, opts);
    } catch (e) {
      const again = RETRYABLE.has(e.code) || (method === 'GET' && (CUT.has(e.code) || e.message === 'socket hang up')) || e.status === 502 || e.status === 503;
      if (!again || Date.now() + wait > until) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function callOnce(method, path, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      API + path,
      { method, headers: { 'content-type': 'application/json', 'x-cw-token': TOKEN, 'x-cw-session': SELF, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (raw && ok) return resolve(buf);
          let out = {};
          try {
            out = JSON.parse(buf.toString('utf8'));
          } catch {}
          if (ok) return resolve(out);
          const err = new Error(out.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          reject(err);
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// runTool returns either a plain object (sent as JSON text) or {content:[...]} as-is.
export function serve(name, tools, runTool) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } } });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools } });
      } else if (method === 'tools/call') {
        try {
          const out = await runTool(params.name, params.arguments || {});
          const result = out && Array.isArray(out.content) ? out : { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
          send({ jsonrpc: '2.0', id, result });
        } catch (e) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
        }
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  });
}
