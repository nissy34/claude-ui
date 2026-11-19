// Project memory: notes every session in a project shares, as files. One file per subject with
// frontmatter (name, description); MEMORY.md is generated from the frontmatter by this module,
// never edited by a model, so two writers can't corrupt it. Writes are versioned: a write names
// the version it read, and a stale write is refused with the current text to merge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FILE = 4096;
const MAX_FILES = 200;

const version = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

export function memorySlug(name) {
  return String(name || '').toLowerCase().trim().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

function render(name, description, body) {
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${oneLine(description)}\n---\n\n${String(body || '').trim()}\n`;
}

export class ProjectMemory {
  constructor(dir, onChange = () => {}) {
    this.dir = dir;
    this.onChange = onChange;
    fs.mkdirSync(dir, { recursive: true });
    this.lock = Promise.resolve();
  }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    } catch {
      return [];
    }
  }

  entries() {
    return this.files().map((f) => {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      const { meta } = parse(text);
      const st = fs.statSync(path.join(this.dir, f));
      return { name: f.slice(0, -3), description: meta.description || '', size: Buffer.byteLength(text), version: version(text), modified: st.mtimeMs, by: meta.by || null };
    });
  }

  index() {
    return this.entries()
      .map((e) => `- [${e.name}](${e.name}.md): ${e.description || '(no description)'}`)
      .join('\n');
  }

  writeIndex() {
    fs.writeFileSync(path.join(this.dir, 'MEMORY.md'), `${this.index()}\n`);
  }

  list() {
    return { files: this.entries().map(({ name, description, size, version: v, modified }) => ({ name, description, size, version: v, modified: new Date(modified).toISOString() })), note: 'memory_read a file for its text and version; memory_write with base_version to change it.' };
  }

  read(name) {
    const slug = memorySlug(name);
    const file = path.join(this.dir, `${slug}.md`);
    if (!slug || !fs.existsSync(file)) throw new Error(`No memory file "${name}". memory_list shows them.`);
    const text = fs.readFileSync(file, 'utf8');
    const { meta, body } = parse(text);
    return { name: slug, description: meta.description || '', content: body.trim(), version: version(text) };
  }

  /** Create or replace a file. baseVersion is required to change an existing file. */
  write({ name, description, content, baseVersion, by }) {
    const slug = memorySlug(name);
    if (!slug) throw new Error('name is required (a short kebab-case subject, e.g. "deploy-process")');
    if (!String(description || '').trim()) throw new Error('description is required: one line saying what the file covers');
    if (/(api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(content || '')) throw new Error('This looks like it contains a secret. Never store credentials in project memory.');
    const file = path.join(this.dir, `${slug}.md`);
    const exists = fs.existsSync(file);
    if (exists) {
      const cur = fs.readFileSync(file, 'utf8');
      if (!baseVersion) return { ok: false, conflict: true, note: `"${slug}" already exists. Read it (memory_read), merge your change into its content, and write again with base_version.`, current: this.read(slug) };
      if (baseVersion !== version(cur)) return { ok: false, conflict: true, note: 'Someone changed this file since you read it. Merge your change into the current content below and write again with its version.', current: this.read(slug) };
    } else if (this.files().length >= MAX_FILES) {
      throw new Error(`Memory holds ${MAX_FILES} files, the limit. Merge related files first.`);
    }
    const text = render(slug, description, content);
    if (Buffer.byteLength(text) > MAX_FILE) throw new Error(`Too long (${Buffer.byteLength(text)} bytes; the limit is ${MAX_FILE}). Summarise it, or split it into files by subject.`);
    fs.writeFileSync(file, text);
    this.writeIndex();
    this.onChange({ name: slug, action: exists ? 'updated' : 'created', by });
    return { ok: true, name: slug, version: version(text), created: !exists };
  }

  remove(name, { baseVersion, by, force = false } = {}) {
    const slug = memorySlug(name);
    const file = path.join(this.dir, `${slug}.md`);
    if (!fs.existsSync(file)) throw new Error(`No memory file "${name}"`);
    if (!force && baseVersion !== version(fs.readFileSync(file, 'utf8'))) return { ok: false, conflict: true, note: 'Read the file first and pass its version as base_version.', current: this.read(slug) };
    fs.unlinkSync(file);
    this.writeIndex();
    this.onChange({ name: slug, action: 'deleted', by });
    return { ok: true };
  }
}
