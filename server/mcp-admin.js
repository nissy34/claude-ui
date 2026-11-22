// MCP logins: OAuth sign-in/sign-out and MCP elicitation (forms an MCP server asks the user to fill in).
//
// Claude's MCP OAuth flow redirects to http://localhost:<port>/callback on the machine running Claude.
// The sign-in page opens in the server's own browser, so that redirect reaches Claude by itself
// (watchSignIn notices). Without a server browser the user pastes the failed address back and we
// hand it to Claude with the control request mcp_oauth_callback_url.
// Tokens live in Claude's own credential store, so a sign-in from any process applies to every chat.
//
// The same methods run on a chat's process (ChatSession) and on McpAdmin, a background
// `claude` process per folder that the Settings page uses when no chat is involved.
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { claudeEnv } from './gateway.js';
import { resolveCommand } from './launch.js';
import { withOpener } from './opener.js';

const FLOW_TTL = 15 * 60_000;

// ---------- elicitation ----------
export function elicitationEvent(reqId, req) {
  return {
    reqId,
    server: req.mcp_server_name,
    message: String(req.message || '').slice(0, 4000),
    mode: req.mode || (req.url ? 'url' : 'form'),
    url: req.url || null,
    schema: req.requested_schema || null,
    order: req.property_order || null,
    title: req.title || req.display_name || null,
    ts: Date.now(),
  };
}

export function elicitationResponse(action, content) {
  const a = ['accept', 'decline', 'cancel'].includes(action) ? action : 'cancel';
  return a === 'accept' && content && typeof content === 'object' ? { action: a, content } : { action: a };
}

// Rows from mcp_status carry each server's config (headers, env); keep only what the UI shows.
export function slimServers(list) {
  return (list || []).map((x) => ({
    name: x.name,
    status: x.status,
    ...(x.error ? { error: String(x.error).slice(0, 300) } : {}),
    ...(x.scope ? { scope: x.scope } : {}),
    ...(x.transport || x.config?.type ? { transport: x.transport || x.config.type } : {}),
  }));
}

let signedInListener = null;
/** Called after any process finishes a sign-in, so running chats can reconnect that server. */
export function onSignedIn(fn) {
  signedInListener = fn;
}

// ---------- OAuth methods, mixed into ChatSession and McpAdmin ----------
// Each host provides: proc, control(req, ms), ensureProcess(), touchIdle(), oauth (Map),
// setMcpServers(list), onMcpSignedIn(name), and a cached server list (mcpServerList()).
export const mcpAuthMethods = {
  oauthWaiting() {
    const now = Date.now();
    for (const [name, f] of this.oauth) if (now - f.at > FLOW_TTL) this.oauth.delete(name);
    return this.oauth.size > 0;
  },

  oauthFlows() {
    this.oauthWaiting();
    return [...this.oauth].map(([name, f]) => ({ name, port: f.port, authUrl: f.authUrl, at: f.at }));
  },

  async mcpStatus({ start = false } = {}) {
    if (!this.proc) {
      if (!start) return this.mcpServerList();
      this.ensureProcess();
      if (!this.proc) throw new Error('Claude could not start');
      this.touchIdle();
    }
    const r = await this.control({ subtype: 'mcp_status' }, 60_000);
    this.setMcpServers(r?.mcpServers);
    return this.mcpServerList();
  },

  async mcpAuthenticate(name) {
    name = String(name || '');
    if (!name) throw new Error('Which server?');
    this.ensureProcess();
    if (!this.proc) throw new Error('Claude is not running');
    this.touchIdle();
    // No redirectUri: keep the provider's registered localhost callback.
    const r = await this.control({ subtype: 'mcp_authenticate', serverName: name }, 120_000);
    if (!r?.requiresUserAction) {
      this.oauth.delete(name);
      this.refreshMcpSoon(name, false);
      return { done: true };
    }
    if (r.callbackExpected) this.oauth.set(name, { state: r.state, port: r.callbackPort, authUrl: r.authUrl, at: Date.now() });
    this.setMcpServers(null, { keep: true });
    this.watchSignIn(name, r.state);
    return { authUrl: r.authUrl, callbackExpected: !!r.callbackExpected, port: r.callbackPort };
  },

  /** The flow a pasted callback URL belongs to, matched by its OAuth state (or port). */
  oauthFlowFor(url) {
    this.oauthWaiting();
    const state = url.searchParams.get('state');
    for (const [name, f] of this.oauth) if (state && f.state === state) return name;
    for (const [name, f] of this.oauth) if (!f.state && f.port && String(f.port) === url.port) return name;
    return null;
  },

  async mcpCallback(name, callbackUrl) {
    if (!this.proc) throw new Error('This sign-in has ended (Claude stopped). Press Sign in again.');
    await this.control({ subtype: 'mcp_oauth_callback_url', serverName: name, callbackUrl }, 60_000);
    this.oauth.delete(name);
    this.onMcpSignedIn(name);
    this.refreshMcpSoon(name, true);
    signedInListener?.(name, this);
    return { ok: true };
  },

  // When the redirect reaches Claude by itself (sign-in done in the built-in browser), notice it.
  watchSignIn(name, state) {
    const started = Date.now();
    const tick = async () => {
      const f = this.oauth.get(name);
      if (!f || f.state !== state || !this.proc || Date.now() - started > FLOW_TTL) return;
      try {
        const s = (await this.mcpStatus()).find((x) => x.name === name);
        if (s?.status === 'connected') {
          this.oauth.delete(name);
          this.onMcpSignedIn(name);
          this.setMcpServers(null, { keep: true });
          signedInListener?.(name, this);
          return;
        }
      } catch {}
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  },

  cancelSignIn(name) {
    this.oauth.delete(name);
    this.setMcpServers(null, { keep: true });
  },

  async mcpSignOut(name) {
    this.ensureProcess();
    if (!this.proc) throw new Error('Claude is not running');
    this.touchIdle();
    await this.control({ subtype: 'mcp_clear_auth', serverName: String(name || '') }, 60_000);
    this.oauth.delete(name);
    await this.mcpStatus().catch(() => {});
    return { ok: true };
  },

  async mcpReconnect(name) {
    if (!this.proc) return;
    await this.control({ subtype: 'mcp_reconnect', serverName: name }, 60_000).catch(() => {});
    await this.mcpStatus().catch(() => {});
  },

  // Claude reconnects a configured server after sign-in by itself; nudge it if it hasn't yet.
  refreshMcpSoon(name, reconnect) {
    const check = async (tries) => {
      try {
        const list = await this.mcpStatus();
        const s = list.find((x) => x.name === name);
        if (!s || s.status === 'connected' || tries <= 0) return;
        if (reconnect && tries === 3 && s.status !== 'pending') await this.control({ subtype: 'mcp_reconnect', serverName: name }, 60_000).catch(() => {});
        setTimeout(() => check(tries - 1), 1500);
      } catch {}
    };
    setTimeout(() => check(4), 1200);
  },
};

// ---------- McpAdmin: a background claude process for the Settings page ----------
const IDLE_MS = 5 * 60_000;
const admins = new Map(); // cwd -> McpAdmin

export class McpAdmin {
  constructor(cwd) {
    this.cwd = cwd;
    this.proc = null;
    this.oauth = new Map();
    this.elicits = new Map();
    this.servers = [];
    this.waiters = new Map();
    this.stderr = [];
  }

  static for(cwd) {
    if (!admins.has(cwd)) admins.set(cwd, new McpAdmin(cwd));
    return admins.get(cwd);
  }
  static all() {
    return [...admins.values()];
  }

  mcpServerList() {
    return this.servers;
  }
  setMcpServers(list, { keep } = {}) {
    if (!keep) this.servers = slimServers(list);
  }
  onMcpSignedIn() {}

  snapshot() {
    return { cwd: this.cwd, running: !!this.proc, servers: this.servers, oauth: this.oauthFlows(), elicits: [...this.elicits.values()] };
  }

  ensureProcess() {
    if (this.proc) return;
    const env = withOpener(claudeEnv());
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', ...config.claudeArgs];
    let proc;
    try {
      const cmd = resolveCommand(config.claudeBin, args);
      proc = spawn(cmd.file, cmd.args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return;
    }
    this.proc = proc;
    proc.on('error', () => {});
    proc.stdin.on('error', () => {});
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      this.stderr.push(d);
      if (this.stderr.length > 20) this.stderr.shift();
    });
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'control_response') {
        const r = msg.response || {};
        const w = this.waiters.get(r.request_id);
        if (w) {
          this.waiters.delete(r.request_id);
          r.subtype === 'error' ? w.reject(new Error(r.error)) : w.resolve(r.response);
        }
      } else if (msg.type === 'control_request') {
        const req = msg.request || {};
        if (req.subtype === 'elicitation') this.elicits.set(msg.request_id, elicitationEvent(msg.request_id, req));
        else this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported request: ${req.subtype}` } });
      } else if (msg.type === 'control_cancel_request') {
        this.elicits.delete(msg.request_id);
      }
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const w of this.waiters.values()) w.reject(new Error('Claude exited'));
      this.waiters.clear();
      this.oauth.clear();
      this.elicits.clear();
    });
    this.control({ subtype: 'initialize' }, 60_000).catch(() => {});
  }

  write(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  control(request, timeoutMs = 15_000) {
    const request_id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      if (!this.write({ type: 'control_request', request_id, request })) return reject(new Error('not running'));
      this.waiters.set(request_id, { resolve, reject });
      setTimeout(() => {
        if (this.waiters.delete(request_id)) reject(new Error('Claude did not answer in time'));
      }, timeoutMs);
    });
  }

  answerElicit({ reqId, action, content }) {
    if (!this.elicits.delete(reqId)) return;
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: reqId, response: elicitationResponse(action, content) } });
  }

  touchIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.oauthWaiting() || this.elicits.size) return this.touchIdle();
      this.stop();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    clearTimeout(this.idleTimer);
    try {
      this.proc?.kill();
    } catch {}
  }
}
Object.assign(McpAdmin.prototype, mcpAuthMethods);

export function stopAllAdmins() {
  for (const a of admins.values()) a.stop();
}
