// Minimal stdio MCP server loop shared by the built-in MCP servers. Each one forwards tool
// calls to the main server's /internal API.
import readline from 'node:readline';

export const API = process.env.CW_INTERNAL_URL;
export const SELF = process.env.CW_SESSION_ID;
const TOKEN = process.env.CW_INTERNAL_TOKEN;

export async function call(method, path, body, { raw = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-cw-token': TOKEN, 'x-cw-session': SELF },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
