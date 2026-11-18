// Project notes live in Claude Code's own auto-memory for that project, so every Claude Code
// session in the folder (chats here, the terminal, the Desktop app's Code tab on this machine)
// sees them: the CLI loads the folder's MEMORY.md index into each session and reads the note
// files when they're relevant. Notes here are the same files Claude writes itself, so listing a
// project's notes also shows what Claude remembered on its own.
//
// Layout (Claude Code's): <config dir>/projects/<repo root with non-alphanumerics as "-">/memory/
//   MEMORY.md         one line per note: "- [title](file.md) — description"
//   <slug>.md         frontmatter (name, description, metadata.type) + body
// Worktrees and subfolders of one git repo share the repo's memory, like the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';

const INDEX = 'MEMORY.md';
const MAX_BODY = 50_000;

function repoRoot(dir) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (common) return path.basename(common) === '.git' ? path.dirname(common) : dir;
  } catch {}
  return dir;
}

function settingsDir() {
  // autoMemoryDirectory in user settings replaces the per-project folder (the CLI ignores it in
  // project settings).
  try {
    const s = JSON.parse(fs.readFileSync(path.join(config.claudeConfigDir, 'settings.json'), 'utf8'));
    if (typeof s.autoMemoryDirectory === 'string' && s.autoMemoryDirectory.trim()) {
      return path.resolve(s.autoMemoryDirectory.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || ''));
    }
  } catch {}
  return null;
}

export function memoryDir(projectDir) {
  return settingsDir() || path.join(config.claudeConfigDir, 'projects', repoRoot(projectDir).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

const slugify = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = {};
  if (m) {
    let inMeta = false;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\s*)([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      if (!kv[1] && kv[2] === 'metadata') {
        inMeta = true;
        continue;
      }
      if (!kv[1]) inMeta = false;
      const key = inMeta ? `meta.${kv[2]}` : kv[2];
      let v = kv[3].trim();
      if (v.startsWith('"')) {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.replace(/^"|"$/g, '');
        }
      } else v = v.replace(/^'|'$/g, '');
      meta[key] = v;
    }
  }
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  const tags = (meta['meta.tags'] || '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  return { name: meta.name || path.basename(file, '.md'), title: meta['meta.title'] || meta.name || path.basename(file, '.md'), description: meta.description || body.split('\n')[0].slice(0, 150), type: meta['meta.type'] || null, source: meta['meta.source'] || 'Claude', tags, content: body };
}

const yamlStr = (s) => (/^[\w .,()'/-]*$/.test(s) ? s : JSON.stringify(s));

function serialize({ name, title, description, type, tags, source, content }) {
  const lines = ['---', `name: ${name}`, `description: ${yamlStr(description)}`, 'metadata:', `  type: ${type || 'project'}`];
  if (title && title !== name) lines.push(`  title: ${yamlStr(title)}`);
  if (tags?.length) lines.push(`  tags: [${tags.join(', ')}]`);
  if (source) lines.push(`  source: ${yamlStr(source)}`);
  lines.push('---', '', content.trim(), '');
  return lines.join('\n');
}

function noteFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== INDEX);
  } catch {
    return [];
  }
}

function brief(dir, file, chars = 200) {
  const n = parse(path.join(dir, file));
  const st = fs.statSync(path.join(dir, file));
  return { id: n.name, title: n.title, description: n.description, tags: n.tags, type: n.type, source: n.source, updated: new Date(st.mtimeMs).toISOString(), preview: n.content.slice(0, chars), file };
}

function find(dir, ref) {
  const r = String(ref || '').trim().replace(/\.md$/, '');
  if (!r) return null;
  const files = noteFiles(dir);
  return files.find((f) => f === `${r}.md`) || files.find((f) => { const n = parse(path.join(dir, f)); return n.name.toLowerCase() === r.toLowerCase() || n.title.toLowerCase() === r.toLowerCase(); }) || files.find((f) => f === `${slugify(r)}.md`) || null;
}

/** Update this note's line in MEMORY.md (add, replace, or remove), keeping every other line. */
function updateIndex(dir, file, line) {
  const idx = path.join(dir, INDEX);
  let lines = [];
  try {
    lines = fs.readFileSync(idx, 'utf8').split(/\r?\n/);
  } catch {}
  const at = lines.findIndex((l) => l.includes(`](${file})`));
  if (line == null) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) lines[at] = line;
  else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(line);
  }
  fs.writeFileSync(idx, lines.join('\n').replace(/\n*$/, '\n'));
}

export function listProjectNotes(projectDir, { query, tag, limit = 50 } = {}) {
  const dir = memoryDir(projectDir);
  let list = noteFiles(dir).map((f) => brief(dir, f));
  if (tag) list = list.filter((n) => n.tags.includes(String(tag).toLowerCase()));
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    list = list.filter((n) => {
      const full = parse(path.join(dir, n.file));
      return words.every((w) => `${n.title}\n${n.description}\n${full.content}\n${n.tags.join(' ')}`.toLowerCase().includes(w));
    });
  }
  list.sort((a, b) => b.updated.localeCompare(a.updated));
  return list.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

export function getProjectNote(projectDir, ref) {
  const dir = memoryDir(projectDir);
  const f = find(dir, ref);
  if (!f) throw new Error(`No note "${ref}" in this project's memory. list_notes shows what exists.`);
  return { ...brief(dir, f, 0), content: parse(path.join(dir, f)).content, memoryFile: path.join(dir, f) };
}

export function writeProjectNote(projectDir, { id, title, content, description, tags, append, source }) {
  const dir = memoryDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = find(dir, id) || find(dir, title);
  if (id && !existing && !title) throw new Error(`No note "${id}" in this project's memory.`);
  content = String(content ?? '');
  const cleanTags = Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/[,\[\]]/g, '')).filter(Boolean))].slice(0, 20) : null;
  let note;
  let file;
  if (existing) {
    file = existing;
    const old = parse(path.join(dir, file));
    const body = append && old.content ? `${old.content}\n\n${content}` : content;
    note = { ...old, title: String(title || '').trim() || old.title, content: body.slice(-MAX_BODY), tags: cleanTags || old.tags, source: source || old.source, description: description || (append ? old.description : firstLine(content) || old.description) };
  } else {
    title = String(title || '').trim();
    if (!title) throw new Error('title is required for a new note');
    file = `${slugify(title)}.md`;
    let n = 2;
    while (fs.existsSync(path.join(dir, file))) file = `${slugify(title)}-${n++}.md`;
    note = { name: path.basename(file, '.md'), title, description: description || firstLine(content) || title, type: 'project', tags: cleanTags || [], source, content: content.slice(0, MAX_BODY) };
  }
  note.description = String(note.description).replace(/\s+/g, ' ').trim().slice(0, 150);
  fs.writeFileSync(path.join(dir, file), serialize(note));
  updateIndex(dir, file, `- [${note.name}](${file}) — ${note.description}`);
  return { note: brief(dir, file), [existing ? 'updated' : 'created']: true, memoryFile: path.join(dir, file) };
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
}

export function deleteProjectNote(projectDir, ref) {
  const dir = memoryDir(projectDir);
  const f = find(dir, ref);
  if (!f) throw new Error(`No note "${ref}" in this project's memory.`);
  fs.unlinkSync(path.join(dir, f));
  updateIndex(dir, f, null);
  return { ok: true, deleted: f };
}
