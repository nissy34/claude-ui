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

// Files this session's tools wrote, newest last.
function writtenFiles(s) {
  const out = new Map();
  for (const e of s.events || []) {
    if (e.k !== 'block' || e.block?.type !== 'tool_use' || !FILE_TOOLS.has(e.block.name)) continue;
    const p = e.block.input?.file_path || e.block.input?.notebook_path;
    if (typeof p !== 'string') continue;
    const abs = path.resolve(s.meta.cwd, p);
    out.delete(abs);
    out.set(abs, e.ts || 0);
  }
  return out;
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
      list.push({ path: abs, name: path.basename(abs), ext: path.extname(abs).slice(1).toLowerCase(), sessionId: s.meta.id, sessionName: s.meta.name, project: s.meta.project || s.meta.cwd, mtime: st.mtimeMs, size: st.size, ts, url: rawUrl(s.meta.id, abs) });
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
