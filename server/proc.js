// Long-lived processes (chat CLIs, terminal PTYs) go through here. With CW_RUNNER set they run in
// the session runner (server/runner.js), which keeps them alive across server restarts; otherwise
// (or while the runner can't be reached) they are ordinary child processes, as before.
//
// A runner process is shaped like what the callers already use:
//   kind 'pipe' → like a ChildProcess: pid, stdin.write/end, stderr 'data', kill(), 'spawn'/'exit'/'error'
//                 events; stdout is read with onLines(proc, fn), which also works on a ChildProcess.
//   kind 'pty'  → like a node-pty IPty: pid, write(), resize(), kill(), onData(fn), onExit(fn).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { RunnerClient } from './runner-client.js';

const ACK_BYTES = 64 * 1024;
const ACK_MS = 2000;

export const runner = {
  client: null,
  socketPath: '',
  /** True while new processes go to the runner. */
  get up() {
    return !!this.client?.connected;
  },
  get runnerId() {
    return this.client?.info?.runnerId || null;
  },
};

/**
 * Connect to the runner (retrying for a few seconds at startup) and keep reconnecting if the
 * connection drops. Resolves with the client, or null if it couldn't connect in time.
 */
export async function connectRunner(socketPath, { waitMs = 10_000, log = console.log, onReconnect } = {}) {
  runner.socketPath = socketPath;
  const until = Date.now() + waitMs;
  let lastErr;
  for (;;) {
    const c = new RunnerClient(socketPath);
    try {
      const info = await c.connect();
      runner.client = c;
      log(`session runner: connected (protocol ${info.protocol}, runner ${info.runnerId.slice(0, 8)})`);
      c.on('lost', () => {
        log('session runner: connection lost; new processes start locally until it is back');
        runner.client = null;
        retryLater(socketPath, log, onReconnect);
      });
      return c;
    } catch (e) {
      lastErr = e;
      if (/protocol/.test(e.message)) break; // retrying won't help
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  log(`session runner: not reachable at ${socketPath} (${lastErr?.message}); processes start locally`);
  retryLater(socketPath, log, onReconnect);
  return null;
}

function retryLater(socketPath, log, onReconnect) {
  setTimeout(async () => {
    if (runner.client) return;
    const c = await connectRunner(socketPath, { waitMs: 0, log: () => {}, onReconnect });
    if (c) {
      log('session runner: reconnected');
      onReconnect?.(c);
    }
  }, 5000).unref?.();
}

/** Read stdout line by line: a runner process hands complete lines over itself (offsets matter). */
export function onLines(proc, fn) {
  if (proc instanceof RunnerProc) proc.lineFn = fn;
  else readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', fn);
}

/** Start a chat CLI (stdio pipes). Goes to the runner when it is up. */
export function openPipe({ id, file, args, cwd, env, meta }) {
  if (runner.up) return RunnerProc.spawn(runner.client, { id, kind: 'pipe', file, args, cwd, env, meta });
  return spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/** Start a terminal (PTY). Goes to the runner when it is up; else through the local node-pty. */
export function openPty(localPty, { id, file, args, cwd, env, cols, rows, name = 'xterm-256color', meta }) {
  if (runner.up && runner.client.info.pty) return RunnerProc.spawn(runner.client, { id, kind: 'pty', file, args, cwd, env, cols, rows, name, meta });
  if (!localPty) throw new Error('node-pty is not available');
  return localPty.spawn(file, args, { name, cols, rows, cwd, env });
}

export function isRunnerProc(p) {
  return p instanceof RunnerProc;
}

export class RunnerProc extends EventEmitter {
  constructor(client, id, kind) {
    super();
    this.client = client;
    this.id = id;
    this.kind = kind;
    this.pid = null;
    this.exited = false;
    this.detachedFromUs = false;
    // Output bookkeeping, in bytes of the process's stdout.
    this.pendingStart = 0; // offset of pending[0]
    this.pending = Buffer.alloc(0); // bytes after the last complete line (pipe)
    this.consumed = 0; // everything before this offset has been handled
    this.acked = 0;
    this.ackTimer = null;
    this.lineFn = null;
    this.dataFns = [];
    this.exitFns = [];
    const self = this;
    this.stdin = {
      write(data) {
        return self.client.notify('write', { id, data: String(data) });
      },
      end() {
        self.client.notify('end', { id });
      },
      on() {
        return this;
      },
    };
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.handlers = {
      out: (offset, buf) => this.onOut(offset, buf),
      err: (buf) => this.stderr.emit('data', buf.toString('utf8')),
      exit: (code, signal) => this.handleExit(code, signal),
      detached: () => {
        // Another server attached to this process: stop handling it here, quietly.
        this.detachedFromUs = true;
        this.finish(null, 'detached');
      },
      lost: () => this.finish(null, 'SIGKILL'),
    };
  }

  static spawn(client, opts) {
    const p = new RunnerProc(client, opts.id, opts.kind);
    client.watch(p.id, p.handlers);
    client
      .request('spawn', opts)
      .then((r) => {
        p.pid = r.pid;
        p.emit('spawn');
      })
      .catch((e) => {
        p.emit('error', e);
        p.finish(-1, null);
      });
    return p;
  }

  /** Pick up a process the runner already has, from output offset `from`. Resolves with the runner's info. */
  static async attach(client, id, kind, from, { beforeReplay } = {}) {
    const p = new RunnerProc(client, id, kind);
    p.pendingStart = p.consumed = p.acked = from;
    beforeReplay?.(p);
    client.watch(id, p.handlers);
    const info = await client.request('attach', { id, from });
    p.pid = info.pid;
    if (info.from !== from) p.pendingStart = p.consumed = info.from; // the spool was trimmed past it
    return { proc: p, info };
  }

  onOut(offset, buf) {
    const seen = this.kind === 'pty' ? this.consumed : this.pendingStart + this.pending.length;
    if (offset + buf.length <= seen) return; // already handled (a replay overlapping what we had)
    if (offset < seen) buf = buf.subarray(seen - offset);
    if (this.kind === 'pty') {
      this.consumed = offset + buf.length;
      const s = buf.toString('utf8');
      for (const fn of this.dataFns) fn(s);
      this.scheduleAck();
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    const nl = this.pending.lastIndexOf(0x0a);
    if (nl < 0) return;
    const text = this.pending.subarray(0, nl).toString('utf8');
    this.pending = this.pending.subarray(nl + 1);
    this.pendingStart += nl + 1;
    for (const line of text.split('\n')) {
      // Everything up to the end of this line counts as handled once its handler has run.
      try {
        this.lineFn?.(line.replace(/\r$/, ''));
      } catch (e) {
        console.error('runner process line handler failed', e);
      }
    }
    this.consumed = this.pendingStart;
    this.scheduleAck();
  }

  scheduleAck() {
    if (this.consumed - this.acked >= ACK_BYTES) return this.ack();
    if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => this.ack(), ACK_MS);
      this.ackTimer.unref?.();
    }
  }

  ack() {
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.consumed > this.acked && this.client.notify('ack', { id: this.id, offset: this.consumed })) this.acked = this.consumed;
  }

  handleExit(code, signal) {
    if (this.pending.length && this.lineFn) {
      const last = this.pending.toString('utf8');
      this.pending = Buffer.alloc(0);
      if (last.trim()) this.lineFn(last);
    }
    this.client.request('reap', { id: this.id }).catch(() => {});
    this.finish(code, signal);
  }

  finish(code, signal) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.ackTimer);
    this.client.unwatch(this.id, this.handlers);
    if (this.kind === 'pty') for (const fn of this.exitFns) fn({ exitCode: code ?? 0, signal });
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /**
   * The server is going down: stop handling this process and leave it running in the runner.
   * Returns the output offset to reattach from.
   */
  detach() {
    if (this.exited) return null;
    this.ack();
    this.exited = true;
    clearTimeout(this.ackTimer);
    this.client.unwatch(this.id, this.handlers);
    return { offset: this.consumed };
  }

  kill(sig = 'SIGTERM') {
    if (this.exited) return false;
    this.client.request('signal', { id: this.id, sig }).catch(() => {});
    return true;
  }

  // ---- PTY shape ----
  write(data) {
    this.client.notify('write', { id: this.id, data: String(data) });
  }

  resize(cols, rows) {
    this.client.notify('resize', { id: this.id, cols, rows });
  }

  onData(fn) {
    this.dataFns.push(fn);
    return { dispose: () => (this.dataFns = this.dataFns.filter((f) => f !== fn)) };
  }

  onExit(fn) {
    // node-pty's onExit; the EventEmitter 'exit' event is separate (see finish).
    this.exitFns.push(fn);
    return { dispose: () => (this.exitFns = this.exitFns.filter((f) => f !== fn)) };
  }
}
