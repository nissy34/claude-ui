#!/usr/bin/env node
// The session runner: a small, long-lived process that owns chat CLIs and terminal PTYs so the
// web server can be rebuilt and restarted without killing them. It knows nothing about Claude:
// it spawns processes, spools their output to disk with byte offsets, and forwards bytes to the
// one server attached to each process. The server reattaches after a restart and asks for the
// output from the last offset it processed, so nothing is lost while it is down.
//
// Protocol: newline-delimited JSON over a Unix socket (mode 0600).
//   client → runner  {rid, op, ...}        runner → client  {rid, ok:true, ...} | {rid, error}
//   events           {ev:'out', id, offset, data}   data = base64 of stdout bytes [offset, offset+n)
//                    {ev:'err', id, data}           stderr (not spooled; the last 16 KB are kept)
//                    {ev:'exit', id, code, signal, offset}   after the last output byte
//                    {ev:'detached', id}            another client attached to this id
// Ops: hello, spawn, attach, write, resize, signal, ack, list, reap. See docs in PROTOCOL below.
//
//   node server/runner.js            socket: $CW_RUNNER_SOCKET or ~/.claude-web/runner/runner.sock
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const PROTOCOL = 1;
const TRIM_AT = Number(process.env.CW_RUNNER_TRIM_AT) || 8 * 1024 * 1024; // rewrite a spool once this much acked output sits before the ack
const SPOOL_CAP = 256 * 1024 * 1024; // stop spooling (and say so) past this many unacked bytes
const STDERR_KEEP = 16 * 1024;
const CHUNK = 256 * 1024;

const require = createRequire(import.meta.url);
let pty = null;
try {
  pty = require('node-pty');
} catch {}

const home = os.homedir();
const expand = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, home));

const signalName = (n) => (n ? Object.keys(os.constants.signals).find((k) => os.constants.signals[k] === n) || String(n) : null);

export function defaultSocketPath() {
  const dataDir = expand(process.env.CW_DATA_DIR || path.join(home, '.claude-web'));
  return process.env.CW_RUNNER_SOCKET ? expand(process.env.CW_RUNNER_SOCKET) : path.join(dataDir, 'runner', 'runner.sock');
}

export function startRunner({ socketPath = defaultSocketPath(), spoolDir = process.env.CW_RUNNER_SPOOL ? expand(process.env.CW_RUNNER_SPOOL) : path.join(path.dirname(socketPath), 'spool'), log = console.log } = {}) {
  const runnerId = crypto.randomUUID();
  const startedAt = Date.now();
  const procs = new Map(); // id -> record
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  // Processes never outlive the runner, so spools from a previous run are stale.
  fs.rmSync(spoolDir, { recursive: true, force: true });
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });

  const send = (client, msg) => {
    if (client && !client.destroyed) client.write(JSON.stringify(msg) + '\n');
  };

  const info = (r) => ({
    id: r.id,
    kind: r.kind,
    pid: r.pid,
    alive: r.alive,
    exitCode: r.exitCode,
    signal: r.signal,
    spoolStart: r.spoolStart,
    spoolEnd: r.end,
    acked: r.acked,
    overflow: r.overflow,
    startedAt: r.startedAt,
    meta: r.meta,
    attached: !!r.client,
  });

  function onOutput(r, buf) {
    if (r.end - r.acked > SPOOL_CAP && !r.client) {
      // Nobody is reading and the spool is huge: drop rather than fill the disk.
      if (!r.overflow) log(`runner: ${r.id} spool over ${SPOOL_CAP} bytes while detached; dropping output`);
      r.overflow = true;
      return;
    }
    const offset = r.end;
    fs.writeSync(r.fd, buf);
    r.end += buf.length;
    if (r.client) send(r.client, { ev: 'out', id: r.id, offset, data: buf.toString('base64') });
  }

  function onStderr(r, buf) {
    r.stderr = (r.stderr + buf.toString('utf8')).slice(-STDERR_KEEP);
    if (r.client) send(r.client, { ev: 'err', id: r.id, data: buf.toString('base64') });
  }

  function onExit(r, code, signal) {
    if (!r.alive) return;
    r.alive = false;
    r.exitCode = code ?? null;
    r.signal = signal ?? null;
    r.endedAt = Date.now();
    if (r.client) send(r.client, { ev: 'exit', id: r.id, code: r.exitCode, signal: r.signal, offset: r.end });
  }

  function trim(r) {
    // Drop the spool's bytes before the ack: copy what is left into a new file.
    const keepFrom = r.acked - r.spoolStart;
    if (keepFrom < TRIM_AT) return;
    const tmp = r.spoolPath + '.tmp';
    const out = fs.openSync(tmp, 'w+', 0o600);
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = keepFrom;
    for (;;) {
      const n = fs.readSync(r.fd, buf, 0, CHUNK, pos);
      if (!n) break;
      fs.writeSync(out, buf, 0, n);
      pos += n;
    }
    fs.closeSync(r.fd);
    fs.renameSync(tmp, r.spoolPath);
    r.fd = out; // positioned at its end, so appends continue there
    r.spoolStart = r.acked;
  }

  function streamFrom(r, client, from) {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    while (pos < r.end) {
      const n = fs.readSync(r.fd, buf, 0, Math.min(CHUNK, r.end - pos), pos - r.spoolStart);
      if (!n) break;
      send(client, { ev: 'out', id: r.id, offset: pos, data: buf.subarray(0, n).toString('base64') });
      pos += n;
    }
  }

  const ops = {
    hello: () => ({ protocol: PROTOCOL, runnerId, pid: process.pid, startedAt, pty: !!pty }),

    spawn(m, client) {
      const id = String(m.id || '');
      if (!/^[\w.-]{1,128}$/.test(id)) throw new Error('bad id');
      const old = procs.get(id);
      if (old?.alive) throw new Error(`${id} is already running`);
      if (old) reap(old);
      const spoolPath = path.join(spoolDir, `${id}.spool`);
      const r = { id, kind: m.kind === 'pty' ? 'pty' : 'pipe', alive: true, exitCode: null, signal: null, end: 0, acked: 0, spoolStart: 0, spoolPath, fd: fs.openSync(spoolPath, 'w+', 0o600), stderr: '', client: m.attach === false ? null : client, meta: m.meta ?? null, startedAt: Date.now(), overflow: false };
      try {
        if (r.kind === 'pty') {
          if (!pty) throw new Error('node-pty is not available in the runner');
          const p = pty.spawn(m.file, m.args || [], { name: m.name || 'xterm-256color', cols: m.cols || 120, rows: m.rows || 32, cwd: m.cwd, env: m.env });
          r.proc = p;
          r.pid = p.pid;
          p.onData((d) => onOutput(r, Buffer.from(d, 'utf8')));
          p.onExit(({ exitCode, signal }) => onExit(r, exitCode, signalName(signal)));
        } else {
          // detached: its own process group, so a signal reaches the CLI and the tools it started.
          const p = spawn(m.file, m.args || [], { cwd: m.cwd, env: m.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
          r.proc = p;
          r.pid = p.pid;
          p.stdin.on('error', () => {});
          p.stdout.on('data', (b) => onOutput(r, b));
          p.stderr.on('data', (b) => onStderr(r, b));
          p.on('error', (e) => {
            onStderr(r, Buffer.from(`${e.message}\n`));
            onExit(r, -1, null);
          });
          // 'close' comes after stdout and stderr have ended, so every byte is spooled before the exit.
          p.on('close', (code, signal) => onExit(r, code, signal));
        }
      } catch (e) {
        fs.closeSync(r.fd);
        fs.rmSync(spoolPath, { force: true });
        throw e;
      }
      procs.set(id, r);
      log(`runner: spawned ${id} (${r.kind}, pid ${r.pid})`);
      return { pid: r.pid };
    },

    attach(m, client) {
      const r = must(m.id);
      if (r.client && r.client !== client) send(r.client, { ev: 'detached', id: r.id });
      const from = Math.max(Number(m.from) || 0, r.spoolStart);
      const gap = (Number(m.from) || 0) < r.spoolStart;
      // Replay and switch to live output in the same tick: output handlers run on later ticks,
      // so no byte can slip between the replay and the live stream.
      streamFrom(r, client, Math.min(from, r.end));
      r.client = client;
      if (!r.alive) send(client, { ev: 'exit', id: r.id, code: r.exitCode, signal: r.signal, offset: r.end });
      return { ...info(r), from, gap, stderr: r.stderr };
    },

    write(m) {
      const r = must(m.id);
      if (!r.alive) return { written: false };
      const data = m.b64 ? Buffer.from(m.data, 'base64') : m.data;
      if (r.kind === 'pty') r.proc.write(typeof data === 'string' ? data : data.toString('utf8'));
      else r.proc.stdin.write(data);
      return { written: true };
    },

    end(m) {
      const r = must(m.id);
      if (r.alive && r.kind === 'pipe') r.proc.stdin.end();
      return {};
    },

    resize(m) {
      const r = must(m.id);
      if (r.alive && r.kind === 'pty') r.proc.resize(m.cols, m.rows);
      return {};
    },

    signal(m) {
      const r = must(m.id);
      if (!r.alive) return { sent: false };
      const sig = m.sig || 'SIGTERM';
      if (!/^SIG[A-Z0-9]+$/.test(sig)) throw new Error('bad signal');
      try {
        if (r.kind === 'pty' || process.platform === 'win32') r.proc.kill(sig);
        else process.kill(-r.pid, sig); // the whole group
      } catch {
        try {
          r.proc.kill(sig);
        } catch {}
      }
      return { sent: true };
    },

    ack(m) {
      const r = procs.get(m.id);
      if (!r) return {};
      const off = Math.min(Number(m.offset) || 0, r.end);
      if (off > r.acked) r.acked = off;
      if (r.overflow && r.end - r.acked <= SPOOL_CAP) r.overflow = false;
      trim(r);
      return {};
    },

    list: () => ({ procs: [...procs.values()].map(info) }),

    reap(m) {
      const r = procs.get(m.id);
      if (!r) return { reaped: false };
      if (r.alive) throw new Error(`${r.id} is still running`);
      reap(r);
      return { reaped: true };
    },
  };

  function must(id) {
    const r = procs.get(id);
    if (!r) throw new Error(`no process ${id}`);
    return r;
  }

  function reap(r) {
    try {
      fs.closeSync(r.fd);
    } catch {}
    fs.rmSync(r.spoolPath, { force: true });
    procs.delete(r.id);
  }

  const server = net.createServer((client) => {
    client.setEncoding('utf8');
    let buf = '';
    client.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const fn = Object.hasOwn(ops, m.op) ? ops[m.op] : null;
        try {
          if (!fn) throw new Error(`unknown op ${m.op}`);
          send(client, { rid: m.rid, ok: true, ...fn(m, client) });
        } catch (e) {
          send(client, { rid: m.rid, error: e.message });
        }
      }
    });
    const gone = () => {
      for (const r of procs.values()) if (r.client === client) r.client = null;
    };
    client.on('close', gone);
    client.on('error', gone);
  });

  // A stale socket file from a crashed runner would make listen fail.
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const old = process.umask(0o177);
  server.listen(socketPath, () => {
    process.umask(old);
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
    log(`runner: listening on ${socketPath} (protocol ${PROTOCOL}, pty ${pty ? 'yes' : 'no'})`);
  });

  function close({ kill = true } = {}) {
    server.close();
    for (const r of procs.values()) {
      if (kill && r.alive) ops.signal({ id: r.id, sig: 'SIGTERM' });
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }

  return { server, procs, close, runnerId, socketPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = startRunner();
  const stop = (sig) => {
    console.log(`runner: ${sig}, stopping ${[...r.procs.values()].filter((p) => p.alive).length} process(es)`);
    r.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
