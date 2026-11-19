// Artifacts: files Claude wrote that are worth viewing (HTML pages and dashboards, SVG,
// Markdown, images, PDFs). They are served from /raw/<session>/<sig>/<absolute path> so an
// HTML artifact can load its own relative CSS/JS. HTML runs in a CSP sandbox (opaque origin),
// so it can't read the UI's cookies or call the API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const ARTIFACT_EXT = /\.(html?|svg|md|markdown|png|jpe?g|gif|webp|pdf|csv)$/i;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function sign(sessionId) {
  return crypto.createHmac('sha256', config.secret).update(`raw:${sessionId}`).digest('base64url').slice(0, 22);
}

function sigOk(sessionId, sig) {
  const want = sign(sessionId);
  return typeof sig === 'string' && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

// Absolute path -> URL path segment (Windows drive paths become /C:/...).
const toUrlPath = (p) => (p.startsWith('/') ? p : '/' + p.replace(/\\/g, '/'));
const fromUrlPath = (u) => (/^\/[A-Za-z]:\//.test(u) ? u.slice(1) : u);

export function rawUrl(sessionId, absPath) {
  return `/raw/${sessionId}/${sign(sessionId)}${toUrlPath(absPath).split('/').map(encodeURIComponent).join('/')}`;
}

// Files this session's tools wrote or Claude published (publish_artifact), newest last.
function writtenFiles(s) {
  const out = new Map();
  const published = new Map((s.meta.published || []).map((p) => [p.path, p]));
  for (const e of s.events || []) {
    if (e.k !== 'block' || e.block?.type !== 'tool_use' || !FILE_TOOLS.has(e.block.name)) continue;
    const p = e.block.input?.file_path || e.block.input?.notebook_path;
    if (typeof p !== 'string') continue;
    const abs = path.resolve(s.meta.cwd, p);
    out.delete(abs);
    out.set(abs, e.ts || 0);
  }
  for (const p of published.values()) {
    out.delete(p.path);
    out.set(p.path, p.ts || 0);
  }
  return out;
}

const KIND_EXT = { html: '.html', markdown: '.md', svg: '.svg', csv: '.csv' };
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact';

// publish_artifact: show an existing file (path) or new content as an artifact of this chat.
// Content goes to <dataDir>/artifacts/<session>/<title>.<ext>; the file is recorded in the
// session's meta so the Artifacts gallery lists it and its folder may be served (so a report's
// own CSS, JS and images load).
export function publishArtifact(s, { path: p, content, format, title, description } = {}) {
  let abs;
  if (typeof p === 'string' && p.trim()) {
    if (content != null) throw new Error('Give either path or content, not both.');
    abs = path.resolve(s.meta.cwd, p.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || '~'));
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`No file at ${abs}. Write the file first, or pass content instead.`);
    }
    if (!st.isFile()) throw new Error(`${abs} is a folder. Pass the report file itself, e.g. ${path.join(abs, 'report.html')}.`);
    if (!ARTIFACT_EXT.test(abs)) throw new Error('Only HTML, Markdown, SVG, images, PDF and CSV files can be published.');
  } else if (typeof content === 'string' && content.length) {
    const fmt = String(format || (/^\s*</.test(content) ? 'html' : 'markdown')).toLowerCase().replace(/^md$/, 'markdown').replace(/^htm$/, 'html');
    const ext = KIND_EXT[fmt];
    if (!ext) throw new Error('format must be html, markdown, svg or csv.');
    const dir = path.join(config.dataDir, 'artifacts', s.meta.id);
    fs.mkdirSync(dir, { recursive: true });
    const base = slug(title || (fmt === 'html' && /<title>([^<]*)<\/title>/i.exec(content)?.[1]) || (fmt === 'markdown' && /^#\s+(.+)$/m.exec(content)?.[1]));
    abs = path.join(dir, base + ext);
    fs.writeFileSync(abs, content);
  } else {
    throw new Error('Pass path (an existing file) or content (the HTML or Markdown to publish).');
  }
  const entry = { path: abs, title: String(title || '').slice(0, 200) || undefined, description: String(description || '').slice(0, 500) || undefined, ts: Date.now() };
  s.meta.published = [...(s.meta.published || []).filter((x) => x.path !== abs), entry].slice(-100);
  return { path: abs, name: path.basename(abs), title: entry.title || path.basename(abs), url: rawUrl(s.meta.id, abs) };
}

export function listArtifacts(sessions) {
  const list = [];
  for (const s of sessions) {
    if (s.meta.kind !== 'chat') continue;
    for (const [abs, ts] of writtenFiles(s)) {
      if (!ARTIFACT_EXT.test(abs)) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const pub = (s.meta.published || []).find((x) => x.path === abs);
      list.push({ path: abs, name: path.basename(abs), title: pub?.title, description: pub?.description, published: !!pub, ext: path.extname(abs).slice(1).toLowerCase(), sessionId: s.meta.id, sessionName: s.meta.name, project: s.meta.project || s.meta.cwd, mtime: st.mtimeMs, size: st.size, ts, url: rawUrl(s.meta.id, abs) });
    }
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// May this session's artifact URLs serve this file? Its folder, its uploads, or the
// folder of any file Claude wrote in it (so a dashboard's CSS/JS next to it loads).
function allowed(s, real) {
  const roots = [s.meta.cwd, path.join(config.dataDir, 'uploads', s.meta.id)];
  for (const f of writtenFiles(s).keys()) roots.push(path.dirname(f));
  return roots.some((r) => {
    try {
      return inside(fs.realpathSync(r), real);
    } catch {
      return false;
    }
  });
}

export function rawHandler(store) {
  return (req, res) => {
    const { sid, sig } = req.params;
    const s = store.get(sid);
    if (!s || !sigOk(sid, sig)) return res.status(404).end('Not found');
    let rel;
    try {
      rel = decodeURIComponent(req.path.slice(`/raw/${sid}/${sig}`.length));
    } catch {
      return res.status(400).end('Bad path');
    }
    let real;
    try {
      real = fs.realpathSync(path.resolve(fromUrlPath(rel)));
    } catch {
      return res.status(404).end('Not found');
    }
    if (!allowed(s, real) || !fs.statSync(real).isFile()) return res.status(404).end('Not found');
    const type = TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; frame-ancestors 'self'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', type);
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(real).replace(/"/g, '')}"`);
    fs.createReadStream(real).pipe(res);
  };
}
