// Shared notes: a small store that Claude Desktop (through the handoff MCP), the chats in this UI
// (through the built-in notes tools) and the Settings page all read and write. Use it for
// handoffs, decisions, preferences and anything both sides should remember.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'notes.json');
const MAX_NOTES = 1000;
const MAX_CONTENT = 100_000;

let notes = load();

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const brief = (n, chars = 200) => ({ id: n.id, title: n.title, tags: n.tags, source: n.source, updated: new Date(n.updated).toISOString(), preview: n.content.slice(0, chars) });

function find(ref) {
  if (!ref) return null;
  const r = String(ref).trim();
  return notes.find((n) => n.id === r) || notes.find((n) => n.title.toLowerCase() === r.toLowerCase()) || null;
}

/** Newest first. query matches title, content and tags (all words must match). */
export function listNotes({ query, tag, limit = 50 } = {}) {
  let list = [...notes].sort((a, b) => b.updated - a.updated);
  if (tag) list = list.filter((n) => n.tags.includes(String(tag).toLowerCase()));
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) list = list.filter((n) => words.every((w) => `${n.title}\n${n.content}\n${n.tags.join(' ')}`.toLowerCase().includes(w)));
  return list.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((n) => brief(n));
}

export function getNote(ref) {
  const n = find(ref);
  if (!n) throw new Error(`No note "${ref}". list_notes shows what exists.`);
  return { ...n, created: new Date(n.created).toISOString(), updated: new Date(n.updated).toISOString() };
}

/** Create, replace, or (append=true) add to a note. A note is found by id, or else by exact title. */
export function writeNote({ id, title, content, tags, append, source }) {
  title = String(title || '').trim().slice(0, 200);
  content = String(content ?? '');
  const existing = find(id) || find(title);
  if (id && !existing) throw new Error(`No note with id "${id}".`);
  const now = Date.now();
  const cleanTags = Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : null;
  if (existing) {
    if (title) existing.title = title;
    existing.content = (append && existing.content ? `${existing.content}\n\n${content}` : content).slice(-MAX_CONTENT);
    if (cleanTags) existing.tags = cleanTags;
    existing.updated = now;
    if (source) existing.source = source;
    save();
    return { note: brief(existing), updated: true };
  }
  if (!title) throw new Error('title is required for a new note');
  if (notes.length >= MAX_NOTES) throw new Error(`Too many notes (${MAX_NOTES}). Delete some first.`);
  const n = { id: crypto.randomBytes(5).toString('hex'), title, content: content.slice(0, MAX_CONTENT), tags: cleanTags || [], source: source || 'unknown', created: now, updated: now };
  notes.push(n);
  save();
  return { note: brief(n), created: true };
}

export function deleteNote(ref) {
  const n = find(ref);
  if (!n) throw new Error(`No note "${ref}".`);
  notes = notes.filter((x) => x !== n);
  save();
  return { ok: true, deleted: n.title };
}
