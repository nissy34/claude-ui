// Client side of the session runner protocol (server/runner.js). One connection per server
// process; each process handle (server/proc.js) registers for the events of its id.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export const SUPPORTED_PROTOCOLS = [1];

export class RunnerClient extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.sock = null;
    this.rid = 0;
    this.waiters = new Map();
    this.handlers = new Map(); // id -> { out(offset, buf), err(buf), exit(code, signal, offset), detached() }
    this.info = null;
  }

  get connected() {
    return !!this.sock && !this.sock.destroyed && !!this.info;
  }

  connect({ timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error('runner: connect timed out'));
      }, timeoutMs);
      sock.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      sock.once('connect', async () => {
        clearTimeout(t);
        this.attachSocket(sock);
        try {
          const info = await this.request('hello');
          if (!SUPPORTED_PROTOCOLS.includes(info.protocol)) {
            sock.destroy();
            return reject(new Error(`runner speaks protocol ${info.protocol}; this server supports ${SUPPORTED_PROTOCOLS.join(', ')}`));
          }
          this.info = info;
          resolve(info);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  attachSocket(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.onMessage(m);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.info = null;
      for (const w of this.waiters.values()) w.reject(new Error('runner connection lost'));
      this.waiters.clear();
      const hs = [...this.handlers.values()];
      this.handlers.clear();
      for (const h of hs) h.lost?.();
      this.emit('lost');
    });
  }

  onMessage(m) {
    if (m.rid !== undefined && !m.ev) {
      const w = this.waiters.get(m.rid);
      if (!w) return;
      this.waiters.delete(m.rid);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m);
      return;
    }
    const h = this.handlers.get(m.id);
    if (!h) return;
    if (m.ev === 'out') h.out?.(m.offset, Buffer.from(m.data, 'base64'));
    else if (m.ev === 'err') h.err?.(Buffer.from(m.data, 'base64'));
    else if (m.ev === 'exit') h.exit?.(m.code, m.signal, m.offset);
    else if (m.ev === 'detached') {
      this.handlers.delete(m.id);
      h.detached?.();
    }
  }

  request(op, fields = {}) {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error('runner not connected'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      this.waiters.set(rid, { resolve, reject });
      this.sock.write(JSON.stringify({ ...fields, op, rid }) + '\n');
    });
  }

  /** Fire and forget (stdin writes, acks): ordered with requests, errors ignored. */
  notify(op, fields = {}) {
    if (!this.sock || this.sock.destroyed) return false;
    this.sock.write(JSON.stringify({ ...fields, op, rid: `n${++this.rid}` }) + '\n');
    return true;
  }

  watch(id, handlers) {
    this.handlers.set(id, handlers);
  }

  unwatch(id, handlers) {
    if (!handlers || this.handlers.get(id) === handlers) this.handlers.delete(id);
  }

  close() {
    this.sock?.destroy();
  }
}
