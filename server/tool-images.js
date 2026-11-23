// Pictures in tool results (MCP screenshots, Read of an image file), shown inline in chats.
//
// A tool result can carry a picture two ways:
//  - an image content block with base64 data (the live stream, and most transcripts): we save it
//    once under <data dir>/tool-images/<sha1>.<ext> and the chat event keeps only its URL;
//  - a text line "[Image: source: <path>]" pointing at the copy Claude Code saved under
//    <claude config>/projects/<project>/<session>/tool-results/. We serve that file, and only
//    files inside such a tool-results folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const DIR = path.join(config.dataDir, 'tool-images');
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// "[Image: source: /path/x.png]" (Claude Code's note for a picture it saved to disk).
const SOURCE_RE = /\[Image: source: ([^\]\n]+?)\]/g;

function saveBase64(mediaType, data) {
  const ext = EXT_OF[String(mediaType || '').toLowerCase()];
  if (!ext || typeof data !== 'string' || !data) return null;
  let buf;
  try {
    buf = Buffer.from(data, 'base64');
  } catch {
    return null;
  }
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
  const file = path.join(DIR, name);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, buf, { mode: 0o600 });
    }
  } catch {
    return null;
  }
  return `/api/tool-images/${name}`;
}

// Pictures you send in a chat live with that chat's uploads (<data dir>/uploads/<chat>/images/),
// so deleting the chat deletes them. The chat log keeps their URLs.
const chatImageDir = (sid) => path.join(config.dataDir, 'uploads', sid, 'images');
const SID_RE = /^[0-9a-f-]{36}$/;

/** Save a picture sent in chat `sid`; returns its URL, or null. */
export function saveChatImage(sid, mediaType, data) {
  const ext = EXT_OF[String(mediaType || '').toLowerCase()];
  if (!SID_RE.test(sid) || !ext || typeof data !== 'string' || !data) return null;
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
  const dir = chatImageDir(sid);
  try {
    if (!fs.existsSync(path.join(dir, name))) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
    }
  } catch {
    return null;
  }
  return `/api/chat-images/${sid}/${name}`;
}

const CHAT_IMAGE_RE = /^\/api\/chat-images\/([0-9a-f-]{36})\/([0-9a-f]{40}\.(png|jpg|gif|webp))$/;

/** A picture saved by saveChatImage, back as { media_type, data } for Claude, or null. */
export function loadChatImage(url) {
  const m = CHAT_IMAGE_RE.exec(String(url || ''));
  if (!m) return null;
  try {
    return { media_type: TYPES[m[3]], data: fs.readFileSync(path.join(chatImageDir(m[1]), m[2])).toString('base64') };
  } catch {
    return null;
  }
}

/** Real path of a saved tool-result picture, or null when the path isn't one we may serve. */
export function toolResultFile(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!TYPES[ext]) return null;
  let real, root;
  try {
    real = fs.realpathSync(p.replace(/^~(?=[\\/])/, path.dirname(config.claudeConfigDir)));
    root = fs.realpathSync(path.join(config.claudeConfigDir, 'projects'));
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Must sit directly in a tool-results folder somewhere under projects/.
  if (path.basename(path.dirname(real)) !== 'tool-results') return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

const sourceUrl = (p) => `/api/tool-result-image?path=${encodeURIComponent(p)}`;

/**
 * Text and pictures of a tool_result's content. The text drops the "[image]" placeholders and
 * "[Image: source: …]" notes for the pictures we show.
 */
export function toolResultParts(content) {
  const texts = [];
  const inline = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text') texts.push(c.text);
      else if (c?.type === 'tool_reference') texts.push(`[${c.tool_name}]`);
      else if (c?.type === 'image') {
        const url = c.source?.type === 'base64' ? saveBase64(c.source.media_type, c.source.data) : null;
        if (url) inline.push(url);
        else texts.push('[image]');
      }
    }
  } else if (content != null) texts.push(JSON.stringify(content));

  let text = texts.filter(Boolean).join('\n');
  const sources = [];
  for (const m of text.matchAll(SOURCE_RE)) if (toolResultFile(m[1].trim())) sources.push(m[1].trim());
  // The same picture often comes both ways: prefer the inline copy, and fall back to the file.
  const images = inline.length ? inline : sources.map(sourceUrl);
  if (images.length) {
    text = text
      .replace(SOURCE_RE, (all, p) => (inline.length || sources.includes(p.trim()) ? '' : all))
      .replace(/^\[image\]$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return { text, images };
}

function sendImage(res, file) {
  res.setHeader('Content-Type', TYPES[path.extname(file).slice(1).toLowerCase()]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/** Routes for the pictures; mount after the login check on /api. */
export function mountToolImages(app) {
  app.get('/api/tool-images/:name', (req, res) => {
    const m = /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.exec(req.params.name);
    const file = m && path.join(DIR, req.params.name);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    sendImage(res, file);
  });
  app.get('/api/chat-images/:sid/:name', (req, res) => {
    const m = CHAT_IMAGE_RE.exec(`/api/chat-images/${req.params.sid}/${req.params.name}`);
    const file = m && path.join(chatImageDir(m[1]), m[2]);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    sendImage(res, file);
  });
  app.get('/api/tool-result-image', (req, res) => {
    const file = toolResultFile(String(req.query.path || ''));
    if (!file) return res.status(404).json({ error: 'Not found' });
    sendImage(res, file);
  });
}
