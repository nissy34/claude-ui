// Coordination helpers for Projects: notes, plain-text search, note targeting and similar-thread
// checks. Everything here is code, no model: matches are words and file paths, so they can miss;
// search and the warm brief of a new thread are the safety net.

export const NOTE_KINDS = ['fix', 'gotcha', 'reusable', 'fact', 'warning'];
export const NOTE_TTL_MS = 7 * 86_400_000;
export const NOTE_MAX_CHARS = 300;
export const NOTES_PER_HOUR = 10;
export const DELIVERY_MAX_NOTES = 5;
export const DELIVERY_MAX_CHARS = 1000;

const STOP = new Set(
  'the a an and or but if then than that this these those with without for from into onto over under about after before when while where what which who whom whose why how all any both each few more most other some such only own same so too very can will just should would could may might must shall not no nor are was were been being have has had having does did doing done its it they them their there here you your yours our ours his her hers him she he we us me my mine use used using uses also via per like make makes made need needs one two three get gets got set sets new old now still yet thread threads project file files code work works working change changes changed add adds added fix fixes fixed'.split(
    ' '
  )
);

/** Significant lower-case words (3+ letters, no stop words) of a text. */
export function words(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9_]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

const base = (f) => String(f).split(/[\\/]/).pop().toLowerCase();
const stem = (f) => base(f).replace(/\.[^.]+$/, '');

/** Normalise a note's file list: strings, relative paths, at most 20. */
export function cleanFiles(files) {
  return (Array.isArray(files) ? files : files ? [files] : [])
    .map((f) => String(f || '').trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .slice(0, 20);
}

/** Does a note matter to a thread? Its files overlap the thread's changed files, or its words its brief. */
export function noteMatchesThread(note, thread) {
  const nf = note.files || [];
  const changed = thread.changedFiles || [];
  if (nf.length && changed.length) {
    const set = new Set(changed);
    const bases = new Set(changed.map(base));
    if (nf.some((f) => set.has(f) || bases.has(base(f)))) return true;
  }
  const brief = `${thread.title || ''} ${thread.brief || ''}`;
  const bw = words(brief);
  // A file named in the note that the brief names too ("math.js", or "math").
  if (nf.some((f) => bw.has(stem(f)) || brief.toLowerCase().includes(base(f)))) return true;
  const nw = words(note.text);
  let hits = 0;
  for (const w of nw) if (bw.has(w)) hits++;
  return hits >= 2;
}

/** Live notes: not retracted, not replaced, not expired (durable ones keep). */
export function liveNotes(notes, now = Date.now()) {
  return Object.values(notes || {}).filter((n) => !n.retracted && !n.replacedBy && (n.durable || now - n.ts < NOTE_TTL_MS));
}

/** One note as a line: kind, source thread, time, text, files. */
export function noteLine(n, threadTitle) {
  const when = new Date(n.ts).toISOString().slice(0, 16).replace('T', ' ');
  const src = n.kind === 'decision' ? 'the user' : threadTitle ? `thread "${threadTitle}"` : 'a thread';
  return `- [${n.kind}] ${n.id} from ${src}, ${when} UTC: ${n.text}${n.files?.length ? ` (files: ${n.files.join(', ')})` : ''}`;
}

/** Notes that fit one delivery (5 notes or 1,000 characters); the rest are counted. */
export function packNotes(list, titleOf) {
  const lines = [];
  let chars = 0;
  for (const n of list) {
    const l = noteLine(n, titleOf(n.by));
    if (lines.length >= DELIVERY_MAX_NOTES || (lines.length && chars + l.length > DELIVERY_MAX_CHARS)) break;
    lines.push(l);
    chars += l.length;
  }
  return { lines, taken: list.slice(0, lines.length), more: list.length - lines.length };
}

/**
 * Plain-text search. docs: [{ source, thread, title, text, ts }]. Every query word found scores
 * a point (a whole-phrase hit scores more); returns the best snippets.
 */
export function search(docs, query, { limit = 8, exclude } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const qw = [...words(q)];
  if (!qw.length && q.length < 3) return [];
  const terms = qw.length ? qw : [q];
  const hits = [];
  for (const d of docs) {
    if (exclude && d.thread === exclude) continue;
    const low = d.text.toLowerCase();
    let score = 0;
    let first = -1;
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0) {
        score++;
        if (first < 0 || i < first) first = i;
      }
    }
    if (!score) continue;
    if (terms.length > 1 && score < Math.min(2, terms.length)) continue;
    if (q.length > 6 && low.includes(q)) score += 2;
    const start = Math.max(0, first - 80);
    const snippet = (start ? '…' : '') + d.text.slice(start, start + 280).replace(/\s+/g, ' ').trim() + (start + 280 < d.text.length ? '…' : '');
    hits.push({ source: d.source, thread: d.thread || null, title: d.title || null, score: score + (d.boost || 0), ts: d.ts || 0, snippet });
  }
  return hits.sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, limit);
}

/** Open or recently resolved threads whose title and brief look like the new one. */
export function similarThreads(threads, title, brief, { now = Date.now(), recentMs = 7 * 86_400_000 } = {}) {
  const a = words(`${title} ${title} ${brief}`);
  if (a.size < 2) return [];
  const out = [];
  for (const t of threads) {
    if (t.resolved && now - (t.resolvedAt || t.lastActivity || 0) > recentMs) continue;
    if (t.sideOf) continue;
    const b = words(`${t.title} ${t.title} ${t.brief || ''}`);
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const tw = words(t.title);
    const titleHits = [...words(title)].filter((w) => tw.has(w)).length;
    const jacc = inter / (a.size + b.size - inter || 1);
    // Titles carry the intent; briefs in one codebase share many words, so they only confirm.
    const titleClose = titleHits >= 2 && titleHits * 2 >= Math.min(words(title).size, tw.size);
    if ((titleClose && jacc >= 0.1) || (titleHits >= 1 && jacc >= 0.5)) out.push({ t, score: jacc + titleHits * 0.1 });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 3).map((x) => x.t);
}

/** Memory file an engine-written note goes to, by kind. */
export const MEMORY_FILE_FOR = {
  fix: ['gotchas-and-fixes', 'Problems hit in this project and how they were solved (written by the engine from shared notes)'],
  gotcha: ['gotchas-and-fixes', 'Problems hit in this project and how they were solved (written by the engine from shared notes)'],
  reusable: ['reusable-helpers', 'Helpers, scripts and patterns that already exist in this project (written by the engine from shared notes)'],
  fact: ['project-facts', 'Facts about this project learned by threads (written by the engine from shared notes)'],
  warning: ['warnings', 'Standing warnings for this project (written by the engine from shared notes)'],
  decision: ['user-decisions', "The user's decisions and preferences, in their own words (written by the engine)"],
};
