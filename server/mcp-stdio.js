// Minimal stdio MCP server loop shared by the built-in MCP servers. Each one forwards tool
// calls to the main server's /internal API.
import readline from 'node:readline';
import http from 'node:http';

export const API = process.env.CW_INTERNAL_URL;
export const SELF = process.env.CW_SESSION_ID;
const TOKEN = process.env.CW_INTERNAL_TOKEN;

// node:http rather than fetch: fetch gives up on a response after 5 minutes, and some calls
// (read_session wait, send_to_session wait_for_reply) legitimately block for longer.
export function call(method, path, body, { raw = false } = {}) {
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
          ok ? resolve(out) : reject(new Error(out.error || `HTTP ${res.statusCode}`));
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
