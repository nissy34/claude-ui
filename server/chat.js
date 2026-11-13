// Chat sessions: the real `claude` CLI in headless stream-JSON mode, one long-lived process
// per session. Tool permission prompts come back over stdio (`--permission-prompt-tool stdio`),
// the same control protocol the Agent SDK uses, so the browser can answer them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserAvailable } from './browser.js';
import { config, PRIVATE_ENV } from './config.js';
import { resolveCommand } from './launch.js';

const CHAT_DIR = path.join(config.dataDir, 'chats');
fs.mkdirSync(CHAT_DIR, { recursive: true });

const MAX_TEXT = 30_000; // cap stored tool output per result
const MAX_EVENTS_SENT = 1500;
const MODE_ALIASES = { ask: 'default', manual: 'default', normal: 'default', edits: 'acceptEdits', 'accept-edits': 'acceptEdits', acceptedits: 'acceptEdits', bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions' };
const IDLE_MS = config.chatIdleMinutes * 60_000;

export function claudeProjectDir(cwd) {
  return path.join(config.claudeConfigDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
export function transcriptPath(cwd, id) {
  return path.join(claudeProjectDir(cwd), `${id}.jsonl`);
}

const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-sessions.js');
const commandCache = new Map(); // cwd -> commands with descriptions
import { setModels } from './models.js';
const MCP_BROWSER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-browser.js');

/** How a message from another session is introduced to Claude. */
function fromLabel(f) {
  const what = f.kind === 'question' ? 'Question' : f.kind === 'reply' ? 'Reply' : 'Message';
  const tail =
    f.kind === 'question'
      ? ` - it is blocked waiting for your reply; answer with send_to_session to session id ${f.id}`
      : f.kind === 'reply'
        ? ' - a late reply to a question you asked earlier'
        : '';
  return `[${what} from ${f.role} session "${f.name}" (session id ${f.id})${tail}]`;
}

function childEnv(sessionId) {
  const env = { ...process.env };
  for (const k of PRIVATE_ENV) delete env[k];
  // Lets "edit an earlier message" restore files to that point.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';
  // Used by the built-in sessions MCP server (child sessions).
  env.CW_INTERNAL_URL = config.internalUrl;
  env.CW_INTERNAL_TOKEN = config.internalToken;
  env.CW_SESSION_ID = sessionId;
  return env;
}

function clip(s, n = MAX_TEXT) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : c.type === 'tool_reference' ? `[${c.tool_name}]` : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

/** Convert a Claude Code transcript (.jsonl) into chat events, so resumed conversations show their history. */
export function eventsFromTranscript(file) {
  const events = [];
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return events;
  }
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain || o.isMeta) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : undefined;
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      const hasToolResult = Array.isArray(c) && c.some((x) => x.type === 'tool_result');
      if (hasToolResult) {
        for (const x of c) {
          if (x.type === 'tool_result') events.push({ k: 'tool_result', toolUseId: x.tool_use_id, text: clip(resultText(x.content)), isError: !!x.is_error, ts });
        }
      } else {
        const text = promptText(c).trim();
        if (text && !text.startsWith('<')) {
          let t = text.replace(/\n\n<mentioned_chats>[\s\S]*<\/mentioned_chats>$/, '');
          let from;
          const fm = /^\[(Question|Reply|Message) from (\w+) session "(.*?)" \(session id ([\w-]+)\)[^\]\n]*\]\n\n/.exec(t);
          if (fm) (from = { kind: fm[1] === 'Message' ? undefined : fm[1].toLowerCase(), role: fm[2], name: fm[3], id: fm[4] }), (t = t.slice(fm[0].length));
          events.push({ k: 'user', text: t, ts, ...(from ? { from } : {}) });
        }
      }
    } else if (o.type === 'assistant' && o.message?.content) {
      for (const b of o.message.content) {
        if (b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking') events.push({ k: 'block', msgId: o.message.id, block: b, ts });
      }
    }
  }
  return events;
}

export class ChatSession {
  constructor(meta, store) {
    this.meta = meta;
    this.store = store;
    this.proc = null;
    this.clients = new Set();
    this.pending = new Map(); // request_id -> permission request event
    this.controlWaiters = new Map();
    // A new chat shows the / menu (with descriptions) before its process has started.
    if (meta.commandInfo) commandCache.set(meta.cwd, meta.commandInfo);
    else if (commandCache.has(meta.cwd)) meta.commandInfo = commandCache.get(meta.cwd);
    else if (commandCache.size) meta.commandInfo = [...commandCache.values()].pop();
    this.turns = 0; // user turns in flight
    this.stderr = [];
    this.seenBlocks = new Set();
    this.idleTimer = null;
    this.events = this.loadEvents();
  }

  get id() {
    return this.meta.id;
  }
  get logFile() {
    return path.join(CHAT_DIR, `${this.meta.id}.jsonl`);
  }
  get running() {
    return !!this.proc;
  }
  get state() {
    if (this.pending.size) return 'waiting';
    return this.turns > 0 ? 'busy' : 'idle';
  }

  toJSON() {
    return { ...this.meta, commands: undefined, commandInfo: undefined, models: undefined, tools: undefined, mcpServers: undefined, inbox: undefined, status: this.running ? 'running' : 'idle', state: this.state, live: this.running, clients: this.clients.size };
  }

  loadEvents() {
    try {
      return fs
        .readFileSync(this.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Seed history from an existing Claude transcript (used when resuming a past conversation). */
  // Rebuild the chat from Claude's transcript (after the conversation continued in the terminal UI).
  resync() {
    const file = transcriptPath(this.meta.cwd, this.meta.claudeSessionId);
    const evs = eventsFromTranscript(file);
    if (!evs.length) return;
    evs.push({ k: 'notice', text: 'Synced with the terminal session', ts: Date.now() });
    fs.writeFileSync(this.logFile, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.events = evs;
    this.broadcast({ t: 'reload' });
  }

  seedFromTranscript() {
    const file = transcriptPath(this.meta.cwd, this.meta.claudeSessionId);
    const evs = eventsFromTranscript(file);
    if (evs.length) {
      evs.push({ k: 'notice', text: 'Resumed from an earlier conversation', ts: Date.now() });
      fs.writeFileSync(this.logFile, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
      this.events = evs;
    }
  }

  record(ev, { persist = true } = {}) {
    ev.ts ||= Date.now();
    if (persist) {
      this.events.push(ev);
      fs.appendFile(this.logFile, JSON.stringify(ev) + '\n', () => {});
    }
    this.broadcast({ t: 'ev', ev });
  }

  broadcastState() {
    this.broadcast({ t: 'state', state: this.state, live: this.running, meta: this.meta, turns: this.turns, inbox: this.inboxSummary(), waitingOn: this.waitingSummary() });
    this.store.changed();
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  // Messages from other sessions waiting for this chat's current turn to end. Kept in meta so a
  // server restart doesn't lose them.
  get inbox() {
    return (this.meta.inbox ||= []);
  }

  inboxSummary() {
    return this.inbox.map((b) => ({ name: b.from?.name || 'another chat', role: b.from?.role, kind: b.from?.kind, preview: b.text.slice(0, 200), ts: b.ts }));
  }

  waitingSummary() {
    const w = this.waiting;
    if (!w) return null;
    const t = this.store.get(w.to);
    return { id: w.to, name: t?.meta.name || 'another chat', since: w.since };
  }

  snapshot() {
    return {
      t: 'chat',
      meta: this.meta,
      state: this.state,
      live: this.running,
      turns: this.turns,
      inbox: this.inboxSummary(),
      waitingOn: this.waitingSummary(),
      events: this.events.slice(-MAX_EVENTS_SENT),
      truncated: Math.max(0, this.events.length - MAX_EVENTS_SENT),
      pending: [...this.pending.values()],
    };
  }

  // ---------- process ----------
  ensureProcess() {
    if (this.proc) return;
    const m = this.meta;
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
      ...config.claudeArgs,
    ];
    const builtin = {};
    if (config.childSessions) builtin.sessions = { type: 'stdio', command: process.execPath, args: [MCP_SCRIPT] };
    if (browserAvailable()) builtin.browser = { type: 'stdio', command: process.execPath, args: [MCP_BROWSER] };
    if (Object.keys(builtin).length) args.push('--mcp-config', JSON.stringify({ mcpServers: builtin }));
    if (builtin.sessions) args.push('--append-system-prompt', this.sessionsPrompt());
    // Talking to other chats and looking at the browser page never need a prompt; starting
    // sessions, changing their options, and navigating, clicking and typing still ask.
    const allowed = [];
    if (builtin.sessions) allowed.push(...['send_to_session', 'read_session', 'list_sessions'].map((t) => `mcp__sessions__${t}`));
    if (builtin.browser) allowed.push(...['snapshot', 'screenshot', 'console', 'scroll', 'wait_for', 'back', 'reload', 'resize'].map((t) => `mcp__browser__${t}`));
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    // 'default' is the CLI's normal ask-first mode; newer CLIs call it 'manual', so just omit the flag.
    if (m.permissionMode && m.permissionMode !== 'default') args.push('--permission-mode', m.permissionMode);
    if (m.model) args.push('--model', m.model);
    if (m.effort) args.push('--effort', m.effort);
    const uploads = path.join(config.dataDir, 'uploads', m.id);
    fs.mkdirSync(uploads, { recursive: true });
    args.push('--add-dir', uploads);
    const fork = this.forkAt;
    this.forkAt = undefined;
    if (fork && fork.from && fs.existsSync(transcriptPath(m.cwd, fork.from))) {
      args.push('--resume', fork.from, '--fork-session');
      if (fork.at) args.push('--resume-session-at', fork.at);
    } else if (fork) {
      m.claudeSessionId = crypto.randomUUID();
      args.push('--session-id', m.claudeSessionId);
    } else if (m.claudeSessionId && fs.existsSync(transcriptPath(m.cwd, m.claudeSessionId))) {
      args.push('--resume', m.claudeSessionId);
    } else {
      m.claudeSessionId ||= crypto.randomUUID();
      args.push('--session-id', m.claudeSessionId);
    }

    let proc;
    try {
      const cmd = resolveCommand(config.claudeBin, args);
      proc = spawn(cmd.file, cmd.args, { cwd: m.cwd, env: childEnv(m.id), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.record({ k: 'error', text: `Could not start ${config.claudeBin}: ${e.message}` });
      return;
    }
    this.proc = proc;
    this.stderr = [];
    m.pid = proc.pid;
    proc.on('error', (e) => this.record({ k: 'error', text: `Could not start ${config.claudeBin}: ${e.message}` }));
    proc.stdin.on('error', () => {});
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      this.stderr.push(d);
      if (this.stderr.length > 50) this.stderr.shift();
    });
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      this.heard = true;
      clearTimeout(this.watchdog);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      try {
        this.onMessage(msg);
      } catch (e) {
        console.error('chat message handling failed', e);
      }
    });
    // Ask for the command list with descriptions (what the SDK's supportedCommands() uses), for the / menu.
    this.control({ subtype: 'initialize' })
      .then((r) => {
        if (!Array.isArray(r?.commands)) return;
        m.commandInfo = r.commands.map((c) => ({ name: c.name, description: (c.description || '').slice(0, 300), argumentHint: c.argumentHint || '', builtin: !!c.builtin, aliases: c.aliases || [] }));
        commandCache.set(m.cwd, m.commandInfo);
        if (Array.isArray(r.models)) setModels(r.models);
        this.broadcastState();
      })
      .catch(() => {});
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      m.pid = null;
      const hadWork = this.turns > 0 || this.pending.size > 0;
      this.cancelWait('Claude stopped');
      this.turns = 0;
      for (const id of this.pending.keys()) this.record({ k: 'perm_done', reqId: id, behavior: 'cancelled' });
      this.pending.clear();
      for (const w of this.controlWaiters.values()) w.reject(new Error('process exited'));
      this.controlWaiters.clear();
      clearTimeout(this.watchdog);
      if (this.quietExit) this.quietExit = false;
      else if (hadWork || (code && code !== 0 && !this.stopping)) {
        const err = this.stderr.join('').trim().split('\n').slice(-8).join('\n');
        const why = this.stopping ? 'Claude was stopped before it finished.' : `Claude exited (${signal || `code ${code}`}).`;
        this.record({ k: 'error', resumable: true, text: `${why} Press Resume or send a message to pick up where it left off.${err ? `\n\n${err}` : ''}` });
      }
      this.stopping = false;
      this.store.save();
      this.broadcastState();
    });
    this.store.save();
  }

  writeLine(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  control(request) {
    const request_id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      if (!this.writeLine({ type: 'control_request', request_id, request })) return reject(new Error('not running'));
      this.controlWaiters.set(request_id, { resolve, reject });
      setTimeout(() => {
        if (this.controlWaiters.delete(request_id)) reject(new Error('control request timed out'));
      }, 15_000);
    });
  }

  touchIdle() {
    clearTimeout(this.idleTimer);
    if (!IDLE_MS) return;
    this.idleTimer = setTimeout(() => {
      // Free the process when nothing is happening; the next message resumes the same conversation.
      if (this.proc && this.state === 'idle') this.stop();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  onMessage(msg) {
    const m = this.meta;
    m.lastActivity = Date.now();
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id) m.claudeSessionId = msg.session_id;
          m.activeModel = msg.model;
          m.permissionMode = msg.permissionMode || m.permissionMode;
          m.commands = msg.slash_commands || [];
          m.tools = msg.tools || [];
          m.mcpServers = msg.mcp_servers || [];
          m.cliVersion = msg.claude_code_version;
          m.apiKeySource = msg.apiKeySource;
          this.broadcastState();
        } else if (msg.subtype === 'status') {
          this.broadcast({ t: 'status', status: msg.status });
        } else if (msg.subtype === 'compact_boundary') {
          this.record({ k: 'notice', text: 'Conversation compacted' });
        }
        break;
      case 'stream_event': {
        const e = msg.event;
        if (e?.type === 'content_block_delta') {
          const d = e.delta;
          const text = d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : null;
          if (text) this.broadcast({ t: 'delta', msgId: msg.api_message_id, index: e.index, kind: d.type === 'thinking_delta' ? 'thinking' : 'text', text, parent: msg.parent_tool_use_id || null });
        }
        break;
      }
      case 'assistant': {
        const msgId = msg.message?.id;
        for (const b of msg.message?.content || []) {
          if (!['text', 'tool_use', 'thinking'].includes(b.type)) continue;
          const key = `${msgId}:${b.id || b.type}:${(b.text || b.thinking || '').length}`;
          if (this.seenBlocks.has(key)) continue;
          this.seenBlocks.add(key);
          this.record({ k: 'block', msgId, block: b, parent: msg.parent_tool_use_id || null, uuid: msg.uuid });
        }
        const u = msg.message?.usage;
        if (u && !msg.parent_tool_use_id) {
          m.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        }
        break;
      }
      case 'user': {
        const c = msg.message?.content;
        const isToolResult = Array.isArray(c) && c.some((x) => x.type === 'tool_result');
        if (!isToolResult && msg.uuid && !msg.parent_tool_use_id) {
          // Echo of a prompt we sent (--replay-user-messages): remember its id for edit/rewind.
          this.record({ k: 'user_uuid', uuid: msg.uuid });
          break;
        }
        if (Array.isArray(c)) {
          for (const x of c) {
            if (x.type === 'tool_result') {
              this.record({ k: 'tool_result', toolUseId: x.tool_use_id, text: clip(resultText(x.content)), isError: !!x.is_error, parent: msg.parent_tool_use_id || null, uuid: msg.uuid });
            }
          }
        }
        break;
      }
      case 'result':
        this.turns = Math.max(0, this.turns - 1);
        // Effort changed mid-turn: restart once idle so the next message launches with it.
        // Then deliver messages other sessions sent while this turn ran.
        if (this.turns === 0) this.cancelWait('its turn ended');
        if (this.turns === 0 && (this.effortPending || this.inbox.length)) {
          const restart = this.effortPending;
          this.effortPending = false;
          setTimeout(async () => {
            if (restart && this.state === 'idle') await this.stopAndWait();
            this.flushInbox();
          }, 200);
        }
        if (this.interrupted) {
          this.interrupted = false;
          if (msg.is_error) {
            msg.result = 'Interrupted';
            msg.errors = [];
          }
        }
        m.totalCost = (m.totalCost || 0) + (msg.total_cost_usd || 0);
        this.record({
          k: 'result',
          subtype: msg.subtype,
          isError: !!msg.is_error,
          text: msg.is_error ? msg.result || (msg.errors || []).join('; ') : undefined,
          durationMs: msg.duration_ms,
          cost: msg.total_cost_usd,
          turns: msg.num_turns,
        });
        if (this.clients.size === 0) m.attention = true;
        this.store.save();
        this.broadcastState();
        this.touchIdle();
        break;
      case 'autocompact_state':
        if (msg.value?.effective_window) {
          m.contextWindow = msg.value.effective_window;
          m.compactAt = msg.value.threshold;
        }
        break;
      case 'rate_limit_event':
        m.rateLimit = msg.rate_limit_info;
        this.broadcastState();
        break;
      case 'control_request':
        this.onControlRequest(msg);
        break;
      case 'control_response': {
        const r = msg.response || {};
        const w = this.controlWaiters.get(r.request_id);
        if (w) {
          this.controlWaiters.delete(r.request_id);
          r.subtype === 'error' ? w.reject(new Error(r.error)) : w.resolve(r.response);
        }
        break;
      }
      case 'control_cancel_request':
        if (this.pending.delete(msg.request_id)) {
          this.record({ k: 'perm_done', reqId: msg.request_id, behavior: 'cancelled' });
          this.broadcastState();
        }
        break;
    }
  }

  onControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'can_use_tool') {
      const ev = {
        k: 'perm',
        reqId: msg.request_id,
        tool: req.tool_name,
        input: req.input,
        toolUseId: req.tool_use_id,
        suggestions: req.permission_suggestions || null,
        reason: req.decision_reason || null,
        blockedPath: req.blocked_path || null,
        parent: req.agent_id || null,
      };
      this.pending.set(msg.request_id, ev);
      this.record(ev);
      if (this.clients.size === 0) this.meta.attention = true;
      this.broadcastState();
      return;
    }
    // Anything else we don't implement: answer with an error so the CLI doesn't wait forever.
    this.writeLine({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported request: ${req.subtype}` } });
  }

  // ---------- actions from the browser ----------
  /** What this chat is told about its parent and children (the sessions tools). */
  sessionsPrompt() {
    const m = this.meta;
    const parent = m.parentId && this.store.get(m.parentId);
    let t =
      `This chat (session id ${m.id}) runs in a web UI that runs several Claude sessions side by side. With the sessions tools you can start child sessions for parallel work (start_session), check on them (read_session), change their model, effort or mode (set_session_options), and talk to any session with send_to_session.\n\n` +
      'send_to_session is one messaging tool for every direction (parent to child, child to parent, any chat to any chat). The other side sees who sent it, with your session id, so it can reply to you the same way. Two ways to use it:\n' +
      '- Plain message (default): non-blocking. Use it for instructions, progress updates on long tasks (at real milestones, not every step), things the other side should know early, and final results. Keep working after sending.\n' +
      '- wait_for_reply=true: a blocking question. The tool call waits until that session answers with send_to_session to you, and returns the answer, so you carry on in the same turn. Use it when you are blocked, need a decision, or need information only that session or the user has. Ask one clear, self-contained question. Do not ask about things you can find out yourself.\n\n' +
      'Incoming messages start with a label like [Message from child session "name" (session id ...)]. A [Question from ...] means that session is blocked until you reply, so answer it with send_to_session to its session id before going on with other long work. Messages that arrive while you are busy are queued and delivered together, in order, when your current turn ends. Child results arrive as messages, so you do not need to poll children with read_session.';
    if (parent)
      t += `\n\nYou are a child session. Your parent is the chat "${parent.meta.name}" (session id ${parent.id}). It started you and may be orchestrating other sessions; it is not the user, though it may pass on the user's wishes. Reach it with send_to_session and id "parent". When you finish the task you were given, send the parent your result (a concise summary plus where any files are). On a long task, send an update at real milestones. If you are stuck or need a decision, ask with wait_for_reply=true instead of guessing.`;
    return t;
  }

  /**
   * A message from another session (child, parent, or any chat using send_to_session). While this
   * chat is mid-turn it waits in an inbox; at the end of the turn everything queued is delivered in
   * order as one turn, each part labelled with its sender, so nothing is dropped or lands mid-turn.
   */
  deliver({ text, from }) {
    if (this.turns > 0 || this.pending.size) {
      this.inbox.push({ text, from, ts: Date.now() });
      this.store.save();
      this.broadcastState();
      return { queued: this.inbox.length };
    }
    if (this.send({ text, from })) return { queued: 0 };
    // Couldn't start a turn (e.g. the conversation is open in the terminal): keep it for later.
    this.inbox.push({ text, from, ts: Date.now() });
    this.store.save();
    this.broadcastState();
    return { queued: this.inbox.length, held: true };
  }

  flushInbox() {
    if (!this.inbox.length || this.turns > 0 || this.pending.size) return;
    const batch = this.meta.inbox;
    this.meta.inbox = [];
    const ok = batch.length === 1 ? this.send(batch[0]) : this.send({ text: batch.map((b) => b.text).join('\n\n'), batch });
    if (!ok) this.meta.inbox = [...batch, ...this.meta.inbox];
    this.store.save();
    this.broadcastState();
  }

  /**
   * This chat asked `to` a question (send_to_session with wait_for_reply) and its tool call is
   * blocked until `to` replies with send_to_session, the wait times out, or the turn ends.
   */
  waitForReply(to, timeoutMs) {
    this.cancelWait('it asked something else');
    return new Promise((resolve) => {
      const w = { to, since: Date.now(), resolve };
      w.timer = setTimeout(() => this.settleWait(w, { answered: false, reason: 'timeout' }), timeoutMs);
      w.timer.unref?.();
      this.waiting = w;
      this.broadcastState();
    });
  }

  settleWait(w, result) {
    if (this.waiting !== w) return false;
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve(result);
    this.broadcastState();
    return true;
  }

  /** A message from `fromId`: if this chat is blocked waiting on exactly that session, it is the reply. */
  takeReply(fromId, text, expectsReply = false) {
    const w = this.waiting;
    return !!(w && w.to === fromId && this.settleWait(w, { answered: true, reply: text, expectsReply }));
  }

  cancelWait(reason) {
    if (this.waiting) this.settleWait(this.waiting, { answered: false, reason });
  }

  send({ text, images, refs, from, batch }) {
    text = typeof text === 'string' ? text : '';
    const imgs = Array.isArray(images) ? images.filter((i) => i && /^image\/(png|jpeg|gif|webp)$/.test(i.media_type) && typeof i.data === 'string').slice(0, 10) : [];
    if (!text.trim() && !imgs.length) return false;
    const m = this.meta;
    const tui = m.tuiId && this.store.get(m.tuiId);
    if (tui && tui.running) {
      this.record({ k: 'error', text: 'This conversation is open in the terminal. Use "Back to chat" there first, so the two don\'t write to it at once.' }, { persist: false });
      return false;
    }
    if (!m.customName && !m.namedFromPrompt && text.trim()) {
      m.name = text.trim().split('\n')[0].slice(0, 60);
      m.namedFromPrompt = true;
    }
    m.attention = false;
    this.ensureProcess();
    if (!this.proc) return false;
    // @-mentioned chats: Claude gets each one's conversation as context (the log shows only your text).
    let prompt = text;
    const chats = (Array.isArray(refs) ? refs : [])
      .slice(0, 5)
      .map((id) => this.store.get(id))
      .filter((c) => c && c !== this && c.meta.kind === 'chat');
    if (chats.length) {
      const ctx = chats
        .map((c) => `<chat name="${c.meta.name.replace(/"/g, "'")}" session_id="${c.id}" folder="${c.meta.cwd}">\n${c.transcriptText(Math.floor(24000 / chats.length)) || '(empty)'}\n</chat>`)
        .join('\n\n');
      prompt = `${text}\n\n<mentioned_chats>\nThe user mentioned these other chats. Their conversations so far (tool calls left out):\n\n${ctx}\n\nYou can also read or message them with the sessions tools (read_session, send_to_session) using the session_id.\n</mentioned_chats>`;
    }
    if (batch) prompt = batch.map((b) => `${fromLabel(b.from)}\n\n${b.text}`).join('\n\n---\n\n');
    else if (from?.name) prompt = `${fromLabel(from)}\n\n${prompt}`;
    const content = imgs.length
      ? [...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })), ...(prompt ? [{ type: 'text', text: prompt }] : [])]
      : prompt;
    this.writeLine({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: m.claudeSessionId });
    this.turns++;
    // The CLI echoes every message right away (--replay-user-messages). Silence means it hung on
    // start or resume; say so, so the chat doesn't just sit there.
    this.heard = false;
    clearTimeout(this.watchdog);
    const proc = this.proc;
    this.watchdog = setTimeout(() => {
      if (this.proc === proc && !this.heard && this.turns > 0) this.record({ k: 'error', resumable: true, text: "Claude hasn't responded for a minute. Press Resume to restart it and continue." });
    }, 60_000);
    this.watchdog.unref?.();
    if (batch) for (const b of batch) this.record({ k: 'user', text: b.text, images: 0, from: b.from });
    else this.record({ k: 'user', text, images: imgs.length, ...(chats.length ? { refs: chats.map((c) => ({ id: c.id, name: c.meta.name })) } : {}), ...(from?.name ? { from } : {}) });
    clearTimeout(this.idleTimer);
    this.store.save();
    this.broadcastState();
    return true;
  }

  answerPermission({ reqId, behavior, updatedInput, message, always }) {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    let response;
    if (behavior === 'allow') {
      response = { behavior: 'allow', updatedInput: updatedInput && typeof updatedInput === 'object' ? updatedInput : p.input };
      if (always && Array.isArray(p.suggestions) && p.suggestions.length) response.updatedPermissions = p.suggestions;
    } else {
      response = { behavior: 'deny', message: message || 'The user denied this action.' };
      if (message === undefined) response.interrupt = false;
    }
    if (p.toolUseId) response.toolUseID = p.toolUseId;
    this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: reqId, response } });
    this.meta.attention = false;
    this.record({ k: 'perm_done', reqId, behavior, always: !!always });
    this.broadcastState();
  }

  async interrupt() {
    if (!this.proc || this.turns === 0) return;
    this.interrupted = true;
    this.cancelWait('interrupted by the user');
    // Deny anything waiting first, then ask Claude to stop the turn.
    for (const id of [...this.pending.keys()]) this.answerPermission({ reqId: id, behavior: 'deny', message: 'Interrupted by user' });
    try {
      await this.control({ subtype: 'interrupt' });
    } catch {
      // Fall back to a signal if the CLI didn't answer.
      try {
        this.proc?.kill('SIGINT');
      } catch {}
    }
  }

  async setMode(mode) {
    const ok = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'];
    if (!ok.includes(mode)) throw new Error('bad mode');
    this.meta.permissionMode = mode;
    if (this.proc) await this.control({ subtype: 'set_permission_mode', mode }).catch((e) => this.record({ k: 'error', text: `Could not change mode: ${e.message}` }));
    this.store.save();
    this.broadcastState();
  }

  async setModel(model) {
    model = String(model || '').trim().slice(0, 100) || null;
    this.meta.model = model;
    if (this.proc) await this.control({ subtype: 'set_model', model: model || 'default' }).catch((e) => this.record({ k: 'error', text: `Could not change model: ${e.message}` }));
    this.store.save();
    this.broadcastState();
  }

  async setEffort(effort) {
    const ok = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (!ok.includes(effort || '')) throw new Error('bad effort');
    this.meta.effort = effort || null;
    // Effort is a launch flag: restart the process when idle so the next message uses it.
    if (this.proc && this.state === 'idle') await this.stopAndWait();
    else if (this.proc) this.effortPending = true;
    this.store.save();
    this.broadcastState();
  }

  /** Change model, effort and permission mode together (the sessions MCP's set_session_options). */
  async setOptions({ model, effort, permissionMode } = {}) {
    const done = [];
    if (permissionMode != null) {
      await this.setMode(MODE_ALIASES[String(permissionMode).toLowerCase()] || permissionMode);
      done.push(`mode ${this.meta.permissionMode}`);
    }
    if (model != null) {
      await this.setModel(model === 'default' ? '' : model);
      done.push(`model ${this.meta.model || 'default'}`);
    }
    if (effort != null) {
      const busy = this.proc && this.state !== 'idle';
      await this.setEffort(effort === 'default' ? '' : effort);
      done.push(`effort ${this.meta.effort || 'default'}${busy ? ' (from its next message; it is mid-turn now)' : ''}`);
    }
    return done;
  }

  /**
   * "/model sonnet", "/effort high", "/mode plan": the CLI doesn't run these in stream-json
   * mode, so handle them here like the composer's pickers. Returns true when handled.
   */
  async runLocalCommand(text) {
    const m = /^\/(model|effort|mode|permission-mode|permissions-mode)\s+(\S+)\s*$/i.exec(String(text || '').trim());
    if (!m) return false;
    const [, cmd, arg] = m;
    const key = cmd.toLowerCase() === 'model' ? 'model' : cmd.toLowerCase() === 'effort' ? 'effort' : 'permissionMode';
    try {
      const done = await this.setOptions({ [key]: arg });
      this.record({ k: 'notice', text: `Set ${done.join(', ')}` });
    } catch (e) {
      this.record({ k: 'error', text: `${text.trim()}: ${e.message}` }, { persist: false });
    }
    return true;
  }

  stopAndWait() {
    return new Promise((resolve) => {
      const p = this.proc;
      if (!p) return resolve();
      p.once('exit', () => setTimeout(resolve, 50));
      this.stop();
    });
  }

  /** Last assistant text since the last user message (for read_session). */
  /** The conversation as plain text (your messages and Claude's replies, tools left out), newest kept. */
  transcriptText(maxChars = 12000) {
    const parts = [];
    for (const e of this.events) {
      if (e.parent) continue;
      if (e.k === 'user' && e.text) parts.push(`User: ${e.text}`);
      else if (e.k === 'block' && e.block.type === 'text' && e.block.text?.trim()) {
        const last = parts[parts.length - 1];
        if (last?.startsWith('Claude: ')) parts[parts.length - 1] = `${last}\n\n${e.block.text}`;
        else parts.push(`Claude: ${e.block.text}`);
      }
    }
    let text = parts.join('\n\n');
    if (text.length > maxChars) text = '[…earlier messages left out…]\n\n' + text.slice(-maxChars);
    return text;
  }

  lastReply() {
    let out = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.k === 'user') break;
      if (e.k === 'block' && e.block.type === 'text' && !e.parent) out.unshift(e.block.text);
    }
    return out.join('\n\n');
  }

  /**
   * Edit an earlier user message: restore files to before it (when checkpoints exist),
   * fork the Claude conversation just before it, drop later history, and send the new text.
   */
  async editMessage({ index, text }) {
    const ev = this.events[index];
    if (!ev || ev.k !== 'user') throw new Error('That message can no longer be edited');
    if (this.turns > 0) throw new Error('Wait for Claude to finish (or stop it) before editing');
    // The prompt's own id arrives as a user_uuid event right after it.
    let userUuid = null;
    for (let i = index + 1; i < this.events.length && !userUuid; i++) {
      if (this.events[i].k === 'user_uuid') userUuid = this.events[i].uuid;
      if (this.events[i].k === 'user') break;
    }
    let prevUuid = null;
    for (let i = index - 1; i >= 0 && !prevUuid; i--) if (this.events[i].uuid && !this.events[i].parent) prevUuid = this.events[i].uuid;

    let restored = false;
    if (userUuid) {
      try {
        this.ensureProcess();
        const r = await this.control({ subtype: 'rewind_files', user_message_id: userUuid });
        restored = r?.canRewind !== false;
      } catch {}
    }
    await this.stopAndWait();
    this.forkAt = { from: this.meta.claudeSessionId, at: prevUuid };
    this.events = this.events.slice(0, index);
    fs.writeFileSync(this.logFile, this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : ''));
    this.record({ k: 'notice', text: restored ? 'Edited message: conversation and files rewound to this point' : 'Edited message: conversation rewound to this point' });
    this.broadcast({ t: 'reload' });
    this.send({ text, refs: (ev.refs || []).map((r) => r.id) });
  }

  stop() {
    if (!this.proc) return;
    this.stopping = true;
    try {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
    } catch {}
    const p = this.proc;
    setTimeout(() => {
      if (this.proc === p) {
        try {
          p.kill('SIGKILL');
        } catch {}
      }
    }, 3000).unref?.();
  }

  kill() {
    this.stop();
  }

  /** Restart Claude on the same conversation (--resume) and ask it to carry on. */
  async resume() {
    if (this.proc && (this.turns > 0 || !this.heard)) {
      this.quietExit = true;
      await this.stopAndWait();
    }
    this.send({ text: 'Continue from where you left off.' });
  }

  /** The server is going down: note it in the chat, since the process may outlive our exit handler. */
  shutdown() {
    if (this.proc && this.turns > 0) {
      this.record({ k: 'error', resumable: true, text: 'The server shut down while Claude was working. Press Resume or send a message to pick up where it left off.' });
      this.quietExit = true;
    }
    this.stop();
  }

  start() {
    this.ensureProcess();
  }

  saveScreen() {}

  dispose() {
    this.stop();
    clearTimeout(this.idleTimer);
    for (const ws of this.clients) ws.close(4004, 'session deleted');
    fs.unlink(this.logFile, () => {});
  }
}
