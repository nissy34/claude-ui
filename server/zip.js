// Minimal zip writer (streaming) and reader (from a file on disk), so folders can be copied in and
// out through the handoff MCP without a dependency. No zip64: archives stay under 4 GB and 65535
// entries, which the callers enforce.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, prev = 0) {
  if (zlib.crc32) return zlib.crc32(buf, prev);
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 0xfffe;

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function write(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('Connection closed'));
    out.write(buf, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * Stream a zip of `entries` ({ abs, name, dir, mtimeMs, mode }) to `out`. Names use "/" and
 * directories end with "/". Does not end `out`.
 */
export async function writeZip(out, entries) {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`Too many files for one zip (${entries.length})`);
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const name = Buffer.from(e.dir ? e.name.replace(/\/?$/, '/') : e.name, 'utf8');
    const { time, date } = dosTime(e.mtimeMs || Date.now());
    const flags = e.dir ? 0x0800 : 0x0808; // UTF-8 names; files use a data descriptor
    const method = e.dir ? 0 : 8;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt16LE(name.length, 26);
    const local = offset;
    await write(out, Buffer.concat([head, name]));
    offset += 30 + name.length;
    let crc = 0;
    let usize = 0;
    let csize = 0;
    if (!e.dir) {
      await pipeline(
        fs.createReadStream(e.abs),
        new Transform({
          transform(c, _enc, cb) {
            crc = crc32(c, crc);
            usize += c.length;
            cb(null, c);
          },
        }),
        zlib.createDeflateRaw({ level: 6 }),
        new Transform({
          transform(c, _enc, cb) {
            csize += c.length;
            cb(null, c);
          },
        }),
        out,
        { end: false }
      );
      offset += csize;
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
      await write(out, desc);
      offset += 16;
      if (offset > ZIP_MAX_BYTES) throw new Error('The zip grew past 4 GB');
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    const mode = (e.dir ? 0o040000 : 0o100000) | ((e.mode ?? (e.dir ? 0o755 : 0o644)) & 0o777);
    c.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    c.writeUInt32LE(local, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, Buffer.concat([cd, end]));
}

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/** List a zip file's entries from its central directory. */
export function readZipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip64 archives are not supported; split it into smaller zips');
    const cd = readAt(fd, cdOff, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken zip central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28);
      const xLen = cd.readUInt16LE(p + 30);
      const cLen = cd.readUInt16LE(p + 32);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const ext = cd.readUInt32LE(p + 38);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nLen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
      const mode = madeBy === 3 ? ext >>> 16 : 0;
      entries.push({
        name,
        method,
        crc,
        csize,
        usize,
        localOff,
        encrypted: !!(flags & 1),
        dir: name.endsWith('/') || (mode & 0o170000) === 0o040000 || !!(ext & 0x10),
        symlink: (mode & 0o170000) === 0o120000,
        mode: mode & 0o777,
      });
      p += 46 + nLen + xLen + cLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Stream one entry's data out of `file` into `dest` (a writable). Checks the CRC. */
export async function extractZipEntry(file, entry, dest, { maxBytes = Infinity } = {}) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses an unsupported compression method (${entry.method})`);
  const fd = fs.openSync(file, 'r');
  let start;
  try {
    const h = readAt(fd, entry.localOff, 30);
    if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new Error(`Broken zip entry ${entry.name}`);
    start = entry.localOff + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  let crc = 0;
  let n = 0;
  const src = entry.csize ? fs.createReadStream(file, { start, end: start + entry.csize - 1 }) : null;
  const streams = [
    ...(entry.method === 8 ? [zlib.createInflateRaw()] : []),
    new Transform({
      transform(c, _enc, cb) {
        n += c.length;
        if (n > maxBytes || n > entry.usize) return cb(new Error(`${entry.name} is larger than it claims, or over the size limit`));
        crc = crc32(c, crc);
        cb(null, c);
      },
    }),
  ];
  if (src) await pipeline(src, ...streams, dest);
  else {
    const empty = new PassThrough();
    empty.end();
    await pipeline(empty, ...streams.slice(-1), dest);
  }
  if ((crc >>> 0) !== entry.crc >>> 0 || n !== entry.usize) throw new Error(`${entry.name} failed its checksum`);
  return n;
}

/** Turn an entry name into safe relative path segments, or null to skip it. */
export function safeEntryPath(name) {
  const norm = String(name).replace(/\\/g, '/');
  if (/^([a-zA-Z]:)?\//.test(norm)) throw new Error(`Refusing absolute path in zip: ${name}`);
  const parts = norm.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) throw new Error(`Refusing ".." in zip path: ${name}`);
  if (!parts.length || parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store') return null;
  return parts.join(path.sep);
}
