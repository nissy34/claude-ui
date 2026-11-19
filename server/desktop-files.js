// File tools for the handoff MCP: copy files between a chat's folder on this machine and the
// MCP client's machine (Claude Desktop / Claude Code on another computer, or the host when this
// server runs in Docker). Small files go inline through the tool call; anything big, binary or a
// whole folder goes through a short-lived link the client fetches or uploads with curl, so the
// bytes never pass through the model's context.
//
// Every path is confined to one root: the chat's folder (its cwd, or its project folder for a
// worktree chat) or a project folder from list_projects. Symlinks that lead outside are refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { writeZip, readZipEntries, extractZipEntry, safeEntryPath, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './zip.js';

const MB = 1024 * 1024;
const envMb = (name, d) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n * MB : d * MB;
};
export const LIMITS = {
  readText: 1 * MB, // read_file: most bytes of text per call
  readImage: 5 * MB, // read_file returns pictures up to this size as an image
  writeInline: 5 * MB, // write_file (the request body is capped at 1 MB anyway)
  upload: envMb('CW_MCP_UPLOAD_MAX_MB', 2048), // one upload request (file or zip)
  folderZip: Math.min(envMb('CW_MCP_ZIP_MAX_MB', 2048), ZIP_MAX_BYTES), // uncompressed total of a folder download
  listEntries: 5000,
  linkMinutes: 15,
  linkMaxMinutes: 24 * 60,
};
const SKIP_DEFAULT = ['.git', 'node_modules'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ---------- path confinement ----------

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function realRoot(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    throw new Error(`Folder does not exist: ${dir}`);
  }
}

/**
 * Resolve `p` (relative to the first root, or absolute) to a real path inside one of `roots`.
 * With mustExist=false the path may not exist yet; its nearest existing ancestor is checked.
 */
export function resolveIn(roots, p, { mustExist = true } = {}) {
  const reals = roots.map(realRoot);
  const raw = String(p ?? '').trim() || '.';
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const candidates = path.isAbsolute(expanded) ? [path.resolve(expanded)] : [path.resolve(roots[0], expanded), path.resolve(reals[0], expanded)];
  for (const cand of candidates) {
    let real;
    if (fs.existsSync(cand)) real = fs.realpathSync(cand);
    else if (mustExist) continue;
    else {
      // Walk up to the nearest existing folder, check it, and re-append the rest.
      let base = cand;
      const rest = [];
      while (!fs.existsSync(base)) {
        rest.unshift(path.basename(base));
        const up = path.dirname(base);
        if (up === base) break;
        base = up;
      }
      real = path.join(fs.realpathSync(base), ...rest);
    }
    const root = reals.find((r) => inside(r, real));
    if (root) return { abs: real, root, rel: path.relative(root, real) || '.' };
  }
  const shown = reals.join(' or ');
  if (mustExist && candidates.every((c) => !fs.existsSync(c))) throw new Error(`Not found: ${raw} (looked in ${shown})`);
  throw new Error(`Path is outside ${shown}. File tools only reach the chat's folder (or the project folder you name).`);
}

const toPosix = (rel) => rel.split(path.sep).join('/');

function walk(dir, root, { recursive, skip, max, onEntry }) {
  let count = 0;
  let truncated = false;
  const visit = (d) => {
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const de of names) {
      if (count >= max) {
        truncated = true;
        return;
      }
      if (skip.includes(de.name)) continue;
      const abs = path.join(d, de.name);
      let st;
      try {
        st = fs.statSync(abs); // follows symlinks
      } catch {
        continue;
      }
      if (de.isSymbolicLink()) {
        // Only follow links that stay inside the root.
        let real;
        try {
          real = fs.realpathSync(abs);
        } catch {
          continue;
        }
        if (!inside(root, real)) continue;
        if (st.isDirectory()) {
          count++;
          onEntry({ abs, rel: path.relative(dir, abs), st, link: true });
          continue; // don't descend into linked folders (loops)
        }
      }
      if (!st.isFile() && !st.isDirectory()) continue;
      count++;
      onEntry({ abs, rel: path.relative(dir, abs), st });
      if (recursive && st.isDirectory() && !de.isSymbolicLink()) visit(abs);
      if (truncated) return;
    }
  };
  visit(dir);
  return { count, truncated };
}

/** Text if the bytes look like UTF-8 text, else null. */
function asText(buf) {
  if (buf.includes(0)) return null;
  const s = buf.toString('utf8');
  // Allow a cut multi-byte character at the very end.
  const bad = (s.match(/�/g) || []).length;
  return bad > 2 ? null : s;
}

// ---------- short-lived links ----------

const links = new Map(); // token -> link

function prune() {
  const now = Date.now();
  for (const [k, v] of links) if (v.expires < now) links.delete(k);
}

function newLink(link, minutes) {
  prune();
  const m = Math.min(Math.max(Number(minutes) || LIMITS.linkMinutes, 1), LIMITS.linkMaxMinutes);
  const token = crypto.randomBytes(24).toString('base64url');
  links.set(token, { ...link, expires: Date.now() + m * 60_000 });
  return { token, expiresAt: new Date(Date.now() + m * 60_000).toISOString() };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- the tools ----------

const target = {
  id: { type: 'string', description: "Chat (session id from list_sessions) whose folder to use. Paths are relative to that chat's folder." },
  project: { type: 'string', description: 'Or a project folder (name from list_projects, or absolute path) instead of a chat.' },
};

export const FILE_TOOLS = [
  {
    name: 'list_files',
    description:
      "List files in a chat's folder (or a project folder) on the Claude Code machine. These files are on that machine, not yours: use read_file, download_link or the other file tools to copy them over. Paths are relative to the folder; absolute paths inside it work too.",
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        path: { type: 'string', description: 'Folder (or file) to list. Default: the top of the chat folder.' },
        recursive: { type: 'boolean', description: 'Include subfolders (skips .git and node_modules). Default false.' },
        max_entries: { type: 'number', description: `Default 500, at most ${LIMITS.listEntries}.` },
      },
    },
  },
  {
    name: 'read_file',
    description:
      `Read one file from a chat's folder. Text comes back as text (up to ${LIMITS.readText / MB} MB per call; use offset for more), pictures (png, jpg, gif, webp) as an image. For other binary files, big files or whole folders, use download_link and fetch it with curl.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        path: { type: 'string' },
        offset: { type: 'number', description: 'Byte offset to start at (default 0).' },
        max_bytes: { type: 'number', description: `Default 200000, at most ${LIMITS.readText}.` },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      "Create or replace a small file in a chat's folder (text, or base64 for binary; up to about 700 KB, since requests are capped at 1 MB). Parent folders are created. For bigger files or whole folders use upload_link. The chat shows a note that the file was added.",
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file. Default false (an existing file is an error).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'download_link',
    description:
      "Get a short-lived link to download a file, or a whole folder as a .zip, from a chat's folder. Fetch it with the curl command in the result (no token needed; the link expires). Use it for binary or large files and for folders; the bytes don't go through this conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        path: { type: 'string', description: 'File or folder. A folder downloads as a zip (skipping .git and node_modules unless include_all).' },
        include_all: { type: 'boolean', description: 'Folders: also include .git and node_modules.' },
        expires_minutes: { type: 'number', description: `Default ${LIMITS.linkMinutes}, at most ${LIMITS.linkMaxMinutes}.` },
      },
      required: ['path'],
    },
  },
  {
    name: 'upload_link',
    description:
      "Get a short-lived link to upload files into a folder in a chat's folder (created if needed). Upload with curl: `curl -T file <url>` for one file (keeps its name), `curl -T \"{a.png,b.pdf}\" <url>` for several, or a zip of a whole folder to `<url>?extract=zip`, which unpacks it there. Existing files are kept unless overwrite=true.",
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        path: { type: 'string', description: 'Destination folder. Default: the top of the chat folder.' },
        overwrite: { type: 'boolean', description: 'Allow replacing existing files. Default false.' },
        expires_minutes: { type: 'number', description: `Default ${LIMITS.linkMinutes}, at most ${LIMITS.linkMaxMinutes}.` },
      },
    },
  },
];

const machine = () => ({ host: config.inDocker ? 'docker container' : os.hostname(), platform: process.platform });

/**
 * @param store the session store
 * @param resolveDir project name/path -> real folder (throws outside the projects root)
 * @param source who is asking, for the chat notice
 */
export function createFileTools({ store, resolveDir, source = 'Claude Desktop' }) {
  function scope(a) {
    if (a.id) {
      const s = store.get(String(a.id).trim());
      if (!s) throw new Error(`No session "${a.id}". list_sessions shows the ids.`);
      const roots = [s.meta.cwd, s.meta.worktree?.path, s.meta.project].filter(Boolean).filter((d, i, all) => all.indexOf(d) === i && fs.existsSync(d));
      if (!roots.length) throw new Error(`The chat's folder ${s.meta.cwd} no longer exists.`);
      return { roots, session: s };
    }
    if (a.project) return { roots: [resolveDir(String(a.project))], session: null };
    throw new Error('Pass id (a chat from list_sessions) or project (from list_projects).');
  }

  function notify(session, text) {
    if (!session) return;
    try {
      session.record({ k: 'notice', text });
      store.changed?.();
    } catch {}
  }

  const url = (base, token, name = '') => `${base}/mcp/files/${token}/${name ? encodeURIComponent(name) : ''}`;

  async function run(name, a = {}, ctx = {}) {
    const base = ctx.base || config.publicUrl || `http://localhost:${config.port}`;
    switch (name) {
      case 'list_files': {
        const { roots } = scope(a);
        const r = resolveIn(roots, a.path);
        const st = fs.statSync(r.abs);
        if (!st.isDirectory()) return { root: r.root, machine: machine(), entries: [{ path: toPosix(r.rel), type: 'file', size: st.size, modified: st.mtime.toISOString() }] };
        const max = Math.min(Math.max(Number(a.max_entries) || 500, 1), LIMITS.listEntries);
        const entries = [];
        const w = walk(r.abs, r.root, {
          recursive: !!a.recursive,
          skip: a.recursive ? SKIP_DEFAULT : [],
          max,
          onEntry: (e) => entries.push({ path: toPosix(path.join(r.rel === '.' ? '' : r.rel, e.rel)), type: e.st.isDirectory() ? 'folder' : 'file', ...(e.st.isFile() ? { size: e.st.size } : {}), modified: e.st.mtime.toISOString() }),
        });
        return { root: r.root, folder: toPosix(r.rel), machine: machine(), entries, ...(w.truncated ? { truncated: true, note: 'More entries than max_entries; list a subfolder or raise max_entries.' } : {}) };
      }
      case 'read_file': {
        const { roots } = scope(a);
        const r = resolveIn(roots, a.path);
        const st = fs.statSync(r.abs);
        if (st.isDirectory()) throw new Error(`${r.rel} is a folder: use list_files, or download_link for a zip.`);
        const ext = path.extname(r.abs).toLowerCase();
        if (IMAGE_TYPES[ext] && !a.offset) {
          if (st.size > LIMITS.readImage) throw new Error(`The picture is ${(st.size / MB).toFixed(1)} MB; use download_link.`);
          return { __content: [{ type: 'text', text: JSON.stringify({ path: toPosix(r.rel), size: st.size }) }, { type: 'image', data: fs.readFileSync(r.abs).toString('base64'), mimeType: IMAGE_TYPES[ext] }] };
        }
        const offset = Math.max(Number(a.offset) || 0, 0);
        const max = Math.min(Math.max(Number(a.max_bytes) || 200_000, 1), LIMITS.readText);
        const len = Math.max(Math.min(max, st.size - offset), 0);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(r.abs, 'r');
        try {
          fs.readSync(fd, buf, 0, len, offset);
        } finally {
          fs.closeSync(fd);
        }
        const text = asText(buf);
        if (text === null) return { path: toPosix(r.rel), size: st.size, binary: true, note: 'This is a binary file. Use download_link and fetch it with curl.' };
        const end = offset + len;
        return { path: toPosix(r.rel), size: st.size, offset, bytes: len, ...(end < st.size ? { truncated: true, nextOffset: end } : {}), content: text };
      }
      case 'write_file': {
        const { roots, session } = scope(a);
        if (typeof a.content !== 'string') throw new Error('content is required');
        const enc = a.encoding === 'base64' ? 'base64' : 'utf8';
        const data = Buffer.from(a.content, enc);
        if (data.length > LIMITS.writeInline) throw new Error('Too big for write_file; use upload_link.');
        const r = resolveIn(roots, a.path, { mustExist: false });
        if (r.rel === '.') throw new Error('path must name a file');
        if (fs.existsSync(r.abs)) {
          if (fs.statSync(r.abs).isDirectory()) throw new Error(`${r.rel} is a folder`);
          if (!a.overwrite) throw new Error(`${r.rel} already exists; pass overwrite=true to replace it.`);
        }
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        resolveIn(roots, path.dirname(r.abs)); // re-check after creating folders
        fs.writeFileSync(r.abs, data);
        notify(session, `${source} added ${toPosix(r.rel)}`);
        return { ok: true, path: toPosix(r.rel), absolutePath: r.abs, bytes: data.length };
      }
      case 'download_link': {
        const { roots } = scope(a);
        const r = resolveIn(roots, a.path);
        const st = fs.statSync(r.abs);
        const folder = st.isDirectory();
        const fname = (r.rel === '.' ? path.basename(r.root) : path.basename(r.abs)) + (folder ? '.zip' : '');
        let info;
        if (folder) {
          // Count up front so a too-big folder fails here, not halfway through the download.
          let bytes = 0;
          const w = walk(r.abs, r.root, { recursive: true, skip: a.include_all ? [] : SKIP_DEFAULT, max: ZIP_MAX_ENTRIES, onEntry: (e) => (bytes += e.st.isFile() ? e.st.size : 0) });
          if (w.truncated) throw new Error(`The folder has more than ${ZIP_MAX_ENTRIES} files; download subfolders instead.`);
          if (bytes > LIMITS.folderZip) throw new Error(`The folder holds ${(bytes / MB).toFixed(0)} MB, over the ${(LIMITS.folderZip / MB).toFixed(0)} MB zip limit; download subfolders instead.`);
          info = { files: w.count, totalBytes: bytes };
        } else info = { size: st.size };
        const { token, expiresAt } = newLink({ op: 'get', roots, abs: r.abs, folder, name: fname, top: fname.replace(/\.zip$/, ''), skip: a.include_all ? [] : SKIP_DEFAULT }, a.expires_minutes);
        const link = url(base, token, fname);
        return {
          url: link,
          name: fname,
          kind: folder ? 'zip of folder' : 'file',
          ...info,
          expiresAt,
          curl: `curl -fsSL -o ${quote(fname)} ${quote(link)}`,
          ...(folder ? { unpack: `unzip -o ${quote(fname)} -d <parent folder>   (creates <parent folder>/${fname.replace(/\.zip$/, '')}/; Windows PowerShell: Expand-Archive ${fname} <parent folder>)` } : {}),
          note: `The link works for anyone who has it until it expires, as many times as needed. It is served by this UI server (${base}); if that address isn't reachable from where you run curl, use the address you use for the UI.`,
        };
      }
      case 'upload_link': {
        const { roots, session } = scope(a);
        const r = resolveIn(roots, a.path, { mustExist: false });
        if (fs.existsSync(r.abs) && !fs.statSync(r.abs).isDirectory()) throw new Error(`${r.rel} is a file; give the folder to upload into.`);
        const { token, expiresAt } = newLink({ op: 'put', roots, abs: r.abs, overwrite: !!a.overwrite, session: session?.id, source }, a.expires_minutes);
        const link = url(base, token);
        return {
          url: link,
          destination: r.abs,
          overwrite: !!a.overwrite,
          maxBytesPerRequest: LIMITS.upload,
          expiresAt,
          examples: {
            oneFile: `curl -fsS -T report.html ${quote(link)}`,
            intoSubfolder: `curl -fsS -T report.html ${quote(link + 'sub/folder/report.html')}`,
            severalFiles: `curl -fsS -T "{report.html,chart.png}" ${quote(link)}`,
            wholeFolder: `cd <parent> && zip -qr - <folder> | curl -fsS -T - ${quote(link + '?extract=zip')}   (Windows: Compress-Archive <folder> f.zip; curl.exe -fsS -T f.zip "${link}?extract=zip")`,
          },
          note: 'Each request answers with JSON listing what was written. Existing files are refused unless overwrite was set when making the link.',
        };
      }
      default:
        return undefined;
    }
  }

  return { tools: FILE_TOOLS, run, names: new Set(FILE_TOOLS.map((t) => t.name)) };
}

// ---------- HTTP side of the links ----------

function sendJson(res, status, body) {
  res.status(status).json(body);
}

async function receive(req, dest, max) {
  let n = 0;
  const declared = Number(req.headers['content-length']);
  if (declared > max) throw Object.assign(new Error(`Over the ${(max / MB).toFixed(0)} MB upload limit`), { status: 413 });
  const out = fs.createWriteStream(dest, { flags: 'wx' });
  try {
    await pipeline(
      req,
      async function* (src) {
        for await (const c of src) {
          n += c.length;
          if (n > max) throw Object.assign(new Error(`Over the ${(max / MB).toFixed(0)} MB upload limit`), { status: 413 });
          yield c;
        }
      },
      out
    );
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return n;
}

const relToRoot = (roots, abs) => toPosix(path.relative(roots.map(realRoot).find((x) => inside(x, abs)) || path.dirname(abs), abs));

const tmpName = (dir) => path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);

async function handlePut(link, rel, req, res, store) {
  const extract = req.query.extract === 'zip' || req.query.extract === '1';
  fs.mkdirSync(link.abs, { recursive: true });
  const dir = resolveIn(link.roots, link.abs).abs; // the folder must still be inside the root
  const written = [];
  if (extract) {
    const tmp = tmpName(dir);
    try {
      await receive(req, tmp, LIMITS.upload);
      const entries = readZipEntries(tmp);
      const plan = [];
      let total = 0;
      for (const e of entries) {
        const relPath = safeEntryPath(e.name);
        if (!relPath || e.symlink) continue;
        const r = resolveIn([dir], path.join(dir, relPath), { mustExist: false });
        if (!e.dir) {
          total += e.usize;
          if (fs.existsSync(r.abs) && !link.overwrite) throw Object.assign(new Error(`${toPosix(relPath)} already exists (make the link with overwrite=true to replace files)`), { status: 409 });
        }
        plan.push({ e, r });
      }
      if (total > LIMITS.upload * 4) throw Object.assign(new Error('The zip unpacks to more than the size limit allows'), { status: 413 });
      for (const { e, r } of plan) {
        if (e.dir) {
          fs.mkdirSync(r.abs, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        resolveIn([dir], path.dirname(r.abs));
        const part = tmpName(path.dirname(r.abs));
        try {
          await extractZipEntry(tmp, e, fs.createWriteStream(part, { flags: 'wx' }), { maxBytes: LIMITS.upload * 4 });
          fs.renameSync(part, r.abs);
        } catch (err) {
          fs.rmSync(part, { force: true });
          throw err;
        }
        written.push({ path: relToRoot(link.roots, r.abs), bytes: e.usize });
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else {
    if (!rel) throw Object.assign(new Error('Put the file name at the end of the link (curl -T file <link> does that for you)'), { status: 400 });
    const r = resolveIn([dir], path.join(dir, safeEntryPath(rel) || ''), { mustExist: false });
    if (r.rel === '.') throw Object.assign(new Error('Bad file name'), { status: 400 });
    if (fs.existsSync(r.abs)) {
      if (fs.statSync(r.abs).isDirectory()) throw Object.assign(new Error(`${toPosix(r.rel)} is a folder`), { status: 409 });
      if (!link.overwrite) throw Object.assign(new Error(`${toPosix(r.rel)} already exists (make the link with overwrite=true to replace it)`), { status: 409 });
    }
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    resolveIn([dir], path.dirname(r.abs));
    const part = tmpName(path.dirname(r.abs));
    const bytes = await receive(req, part, LIMITS.upload);
    fs.renameSync(part, r.abs);
    written.push({ path: relToRoot(link.roots, r.abs), bytes });
  }
  const s = link.session && store?.get(link.session);
  if (s && written.length) {
    try {
      s.record({ k: 'notice', text: `${link.source || 'Claude Desktop'} added ${written.length === 1 ? written[0].path : `${written.length} files to ${toPosix(path.relative(realRoot(link.roots[0]), dir)) || 'the chat folder'}`}` });
      store.changed?.();
    } catch {}
  }
  sendJson(res, 200, { ok: true, folder: dir, written });
}

async function handleGet(link, res) {
  const r = resolveIn(link.roots, link.abs); // still there, still inside
  const st = fs.statSync(r.abs);
  const disp = `attachment; filename="${link.name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(link.name)}`;
  res.setHeader('Content-Disposition', disp);
  res.setHeader('Cache-Control', 'no-store');
  if (!link.folder) {
    if (!st.isFile()) throw Object.assign(new Error('No longer a file'), { status: 410 });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    await pipeline(fs.createReadStream(r.abs), res);
    return;
  }
  // Everything sits under the folder's own name, like `zip -r name.zip name`.
  const entries = [{ abs: r.abs, name: link.top, dir: true, mtimeMs: st.mtimeMs, mode: st.mode }];
  walk(r.abs, r.root, {
    recursive: true,
    skip: link.skip,
    max: ZIP_MAX_ENTRIES,
    onEntry: (e) => entries.push({ abs: e.abs, name: `${link.top}/${toPosix(e.rel)}`, dir: e.st.isDirectory(), mtimeMs: e.st.mtimeMs, mode: e.st.mode }),
  });
  res.setHeader('Content-Type', 'application/zip');
  try {
    await writeZip(res, entries);
    res.end();
  } catch (e) {
    res.destroy(e); // a cut-off download makes curl -f fail instead of leaving a broken zip silently
  }
}

/** Serve /mcp/files/<token>/... Mount before any body parser so uploads stream. */
export function mountFileLinks(app, getStore) {
  app.use('/mcp/files', async (req, res) => {
    const m = /^\/([\w-]+)(?:\/(.*))?$/.exec(req.path);
    const link = m && links.get(m[1]);
    if (!link || link.expires < Date.now()) {
      if (m) links.delete(m[1]);
      return sendJson(res, 404, { error: 'This link is unknown or has expired. Ask for a new one.' });
    }
    let rel = '';
    try {
      rel = decodeURIComponent(m[2] || '');
    } catch {
      return sendJson(res, 400, { error: 'Bad path' });
    }
    try {
      if (link.op === 'get' && (req.method === 'GET' || req.method === 'HEAD')) return await handleGet(link, res);
      if (link.op === 'put' && (req.method === 'PUT' || req.method === 'POST')) return await handlePut(link, rel, req, res, getStore?.());
      res.setHeader('Allow', link.op === 'get' ? 'GET' : 'PUT, POST');
      return sendJson(res, 405, { error: link.op === 'get' ? 'This is a download link: use GET' : 'This is an upload link: use PUT (curl -T)' });
    } catch (e) {
      if (res.headersSent) return res.destroy(e);
      return sendJson(res, e.status || (e.code === 'EEXIST' ? 409 : 400), { error: e.message });
    }
  });
}
