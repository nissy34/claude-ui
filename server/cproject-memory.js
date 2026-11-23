// Project memory: notes every session in a project shares, as files. One file per subject with
// frontmatter (name, description); MEMORY.md is generated from the frontmatter by this module,
// never edited by a model, so two writers can't corrupt it. Writes are versioned: a write names
// the version it read, and a stale write is refused with the current text to merge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FILE = 4096;
const MAX_FILES = 200;
export const MAX_INDEX = 16 * 1024; // MEMORY.md: the file lines plus the pinned part
const TYPES = ['user', 'feedback', 'project', 'reference'];

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

function render(name, description, body, type) {
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${oneLine(description)}${type ? `\ntype: ${type}` : ''}\n---\n\n${String(body || '').trim()}\n`;
}

/**
 * Line diff of two small texts (LCS), as hunks with `context` unchanged lines around each change.
 * Lines are [op, text] with op ' ', '+' or '-'; a gap between hunks is a ['…', ''] line.
 */
export function lineDiff(a, b, { context = 2, maxLines = 80 } = {}) {
  const A = a ? a.replace(/\n$/, '').split('\n') : [];
  const B = b ? b.replace(/\n$/, '').split('\n') : [];
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;
  const ops = [];
  if (n * m > 250000) {
    for (const l of a2) ops.push(['-', l]);
    for (const l of b2) ops.push(['+', l]);
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) ops.push([' ', a2[i++]]), j++;
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) ops.push(['-', a2[i++]]);
      else ops.push(['+', b2[j++]]);
    }
  }
  const all = [...A.slice(0, pre).map((l) => [' ', l]), ...ops, ...A.slice(A.length - suf).map((l) => [' ', l])];
  const keep = new Array(all.length).fill(false);
  all.forEach(([op], k) => {
    if (op === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [];
  let gap = false;
  all.forEach((line, k) => {
    if (!keep[k]) return void (gap = out.length > 0);
    if (gap) out.push(['…', '']);
    gap = false;
    out.push(line);
  });
  if (keep.length && !keep[keep.length - 1] && out.length) out.push(['…', '']);
  const added = all.filter(([op]) => op === '+').length;
  const removed = all.filter(([op]) => op === '-').length;
  return { lines: out.slice(0, maxLines), clipped: out.length > maxLines, added, removed };
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

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
      return { name: f.slice(0, -3), description: meta.description || '', type: meta.type || null, size: Buffer.byteLength(text), version: version(text), modified: st.mtimeMs, by: meta.by || null };
    });
  }

  /** Free text the user pins in MEMORY.md (facts and links with no file of their own). */
  pinned() {
    try {
      return fs.readFileSync(path.join(this.dir, '.pinned'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  fileLines() {
    return this.entries()
      .map((e) => `- [${e.name}](${e.name}.md): ${e.description || '(no description)'}`)
      .join('\n');
  }

  /** MEMORY.md: the engine owns the file lines; the Pinned part is the user's. */
  index() {
    const pin = this.pinned();
    return [this.fileLines(), pin ? `## Pinned\n${pin}` : ''].filter(Boolean).join('\n\n');
  }

  setPinned(text, { by } = {}) {
    text = String(text || '').trim();
    const size = Buffer.byteLength(this.fileLines()) + Buffer.byteLength(text) + 20;
    if (size > MAX_INDEX) throw new Error(`MEMORY.md would be ${Math.ceil(size / 1024)} KB; the limit is 16 KB. Shorten the pinned part.`);
    const before = this.snapshot(null);
    fs.writeFileSync(path.join(this.dir, '.pinned'), text ? `${text}\n` : '');
    this.writeIndex();
    this.onChange({ name: 'MEMORY.md', action: 'pinned', by, diffs: this.diffs(before, null) });
    return this.indexInfo();
  }

  indexInfo() {
    const text = this.index();
    return { size: Buffer.byteLength(text), cap: MAX_INDEX, pinned: this.pinned(), lines: this.fileLines() };
  }

  /** What a change is diffed against: MEMORY.md and the one file it touches. */
  snapshot(slug) {
    return { index: readText(path.join(this.dir, 'MEMORY.md')), file: slug ? readText(path.join(this.dir, `${slug}.md`)) : null };
  }

  /** The diffs a memory.changed event carries, so the UI can show what was added (MEMORY.md first). */
  diffs(before, slug) {
    const out = [];
    const idx = lineDiff(before.index, readText(path.join(this.dir, 'MEMORY.md')));
    if (idx.added || idx.removed) out.push({ file: 'MEMORY.md', ...idx });
    if (slug) {
      const f = lineDiff(before.file, readText(path.join(this.dir, `${slug}.md`)));
      if (f.added || f.removed) out.push({ file: `${slug}.md`, ...f });
    }
    return out;
  }

  writeIndex() {
    fs.writeFileSync(path.join(this.dir, 'MEMORY.md'), `${this.index()}\n`);
  }

  list() {
    return { files: this.entries().map(({ name, description, type, size, version: v, modified }) => ({ name, description, type, size, version: v, modified: new Date(modified).toISOString() })), index: this.indexInfo(), note: 'memory_read a file for its text and version; memory_write with base_version to change it.' };
  }

  read(name) {
    const slug = memorySlug(name);
    const file = path.join(this.dir, `${slug}.md`);
    if (!slug || !fs.existsSync(file)) throw new Error(`No memory file "${name}". memory_list shows them.`);
    const text = fs.readFileSync(file, 'utf8');
    const { meta, body } = parse(text);
    return { name: slug, description: meta.description || '', type: meta.type || null, modified: new Date(fs.statSync(file).mtimeMs).toISOString(), content: body.trim(), version: version(text) };
  }

  /** Create or replace a file. baseVersion is required to change an existing file. */
  write({ name, description, content, baseVersion, by, type }) {
    const slug = memorySlug(name);
    if (!slug) throw new Error('name is required (a short kebab-case subject, e.g. "deploy-process")');
    if (slug === 'memory') throw new Error('"memory" is reserved for the index (MEMORY.md); pick a name for the subject.');
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
    let kind = TYPES.includes(type) ? type : null;
    if (!kind && exists) kind = parse(fs.readFileSync(file, 'utf8')).meta.type || null; // keep the type it had
    const text = render(slug, description, content, kind);
    if (Buffer.byteLength(text) > MAX_FILE) throw new Error(`Too long (${Buffer.byteLength(text)} bytes; the limit is ${MAX_FILE}). Summarise it, or split it into files by subject.`);
    const before = this.snapshot(slug);
    fs.writeFileSync(file, text);
    this.writeIndex();
    this.onChange({ name: slug, action: exists ? 'updated' : 'created', by, diffs: this.diffs(before, slug) });
    return { ok: true, name: slug, version: version(text), created: !exists };
  }

  remove(name, { baseVersion, by, force = false } = {}) {
    const slug = memorySlug(name);
    const file = path.join(this.dir, `${slug}.md`);
    if (!fs.existsSync(file)) throw new Error(`No memory file "${name}"`);
    if (!force && baseVersion !== version(fs.readFileSync(file, 'utf8'))) return { ok: false, conflict: true, note: 'Read the file first and pass its version as base_version.', current: this.read(slug) };
    const before = this.snapshot(slug);
    fs.unlinkSync(file);
    this.writeIndex();
    this.onChange({ name: slug, action: 'deleted', by, diffs: this.diffs(before, slug) });
    return { ok: true };
  }
}

/** Consecutive memory.changed events in a feed collapse into one row with all their names and diffs. */
export function collapseMemoryEvents(feed) {
  const out = [];
  for (const e of feed) {
    if (e.type !== 'memory.changed') {
      out.push(e);
      continue;
    }
    const last = out[out.length - 1];
    const names = e.body.names || [e.body.name];
    const diffs = e.body.diffs || [];
    if (last?.type === 'memory.changed' && last.from?.kind === e.from?.kind && last.from?.id === e.from?.id) {
      const merged = [...last.body.diffs];
      for (const d of diffs) {
        const same = merged.findIndex((x) => x.file === d.file);
        if (same < 0) merged.push(d);
        else merged[same] = { ...d, lines: [...merged[same].lines, ['…', ''], ...d.lines], added: merged[same].added + d.added, removed: merged[same].removed + d.removed };
      }
      out[out.length - 1] = { ...last, ts: e.ts, body: { ...last.body, names: [...new Set([...last.body.names, ...names])], actions: [...new Set([...last.body.actions, e.body.action])], diffs: merged } };
    } else out.push({ ...e, body: { ...e.body, names, actions: [e.body.action], diffs } });
  }
  return out;
}
