// Scheduled tasks, like Claude Code Desktop's: a prompt that starts a new chat on a schedule.
// Runs while this server runs (it's meant for an always-on machine). Stored in <data>/schedules.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'schedules.json');
const CATCH_UP_MS = 7 * 24 * 3600_000;
const PRESETS = ['manual', 'once', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'];
const MODES = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];

// ---------- cron (5 fields, local time): minute hour day-of-month month day-of-week ----------
function field(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? parseInt(stepS, 10) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map((x) => parseInt(x, 10));
      if (Number.isNaN(a)) throw new Error(`Bad cron field "${spec}"`);
      lo = a;
      hi = b == null || Number.isNaN(b) ? (stepS ? max : a) : b;
    }
    if (!(step > 0) || lo < min || hi > max || lo > hi) throw new Error(`Bad cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day month weekday');
  const dow = field(f[4].replace(/7/g, '0'), 0, 6);
  return { min: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

function cronMatches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk; // classic cron: either matches
}

/** The cron expression a task's preset stands for. */
export function cronFor(t) {
  const [h, m] = String(t.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  switch (t.preset) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${t.weekday ?? 1}`;
    case 'custom':
      return t.cron;
    default:
      return null;
  }
}

/** Next run strictly after `from` (ms), or null. */
export function nextRun(t, from = Date.now()) {
  if (!t.enabled) return null;
  if (t.preset === 'once') return t.runAt && t.runAt > (t.lastRun || 0) ? t.runAt : null;
  const expr = cronFor(t);
  if (!expr) return null;
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (cronMatches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ---------- store ----------
let tasks = [];
try {
  tasks = JSON.parse(fs.readFileSync(FILE, 'utf8')).tasks || [];
} catch {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify({ tasks }, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

const view = (t) => ({ ...t, nextRun: nextRun(t), cronExpr: cronFor(t) });
export const listTasks = () => tasks.map(view);
export const getTask = (id) => tasks.find((t) => t.id === id);

function clean(input, base = {}) {
  const t = { ...base };
  if (input.name != null) t.name = String(input.name).trim().slice(0, 80);
  if (input.prompt != null) t.prompt = String(input.prompt).slice(0, 20_000);
  if (input.cwd != null) t.cwd = String(input.cwd);
  if (input.preset != null) {
    if (!PRESETS.includes(input.preset)) throw new Error(`Schedule must be one of ${PRESETS.join(', ')}`);
    t.preset = input.preset;
  }
  if (input.time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(input.time)) throw new Error('Time is HH:MM');
    t.time = input.time;
  }
  if (input.weekday != null) t.weekday = Math.min(6, Math.max(0, parseInt(input.weekday, 10) || 0));
  if (input.cron != null) t.cron = String(input.cron).trim();
  if (input.runAt != null) t.runAt = typeof input.runAt === 'number' ? input.runAt : Date.parse(input.runAt);
  if (input.permissionMode != null) t.permissionMode = MODES.includes(input.permissionMode) ? input.permissionMode : 'default';
  if (input.model != null) t.model = String(input.model).slice(0, 100);
  if (input.effort != null) t.effort = String(input.effort);
  if (input.worktree != null) t.worktree = !!input.worktree;
  if (input.enabled != null) t.enabled = !!input.enabled;
  if (!t.name) throw new Error('A name is required');
  if (!t.prompt?.trim()) throw new Error('Instructions are required');
  if (!t.cwd) throw new Error('A folder is required');
  if (t.preset === 'custom') {
    parseCron(t.cron);
    // Like Desktop's form: at most once an hour.
    const c = parseCron(t.cron);
    if (c.min.size > 1) throw new Error('Custom schedules can run at most once an hour (use a single minute)');
  }
  if (t.preset === 'once' && !(t.runAt > 0)) throw new Error('A one-time task needs a date and time');
  return t;
}

export function createTask(input) {
  const t = clean({ preset: 'daily', time: '09:00', permissionMode: 'default', enabled: true, ...input }, { id: crypto.randomUUID(), createdAt: Date.now(), history: [] });
  t.lastCheck = Date.now();
  tasks.push(t);
  save();
  return view(t);
}

export function updateTask(id, input) {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('No such task');
  tasks[i] = clean(input, tasks[i]);
  tasks[i].lastCheck = Date.now();
  save();
  return view(tasks[i]);
}

export function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  save();
}

// ---------- running ----------
let runner = null; // async (task, { manual }) => sessionId

export async function runTask(id, why = 'manual') {
  const t = getTask(id);
  if (!t) throw new Error('No such task');
  const entry = { at: Date.now(), why };
  try {
    entry.sessionId = await runner(t);
    entry.status = 'started';
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message;
  }
  t.lastRun = entry.at;
  t.history = [entry, ...(t.history || [])].slice(0, 50);
  save();
  return entry;
}

function tick() {
  const now = Date.now();
  for (const t of tasks) {
    if (!t.enabled || t.preset === 'manual') continue;
    const since = Math.max(t.lastCheck || 0, t.lastRun || 0, now - CATCH_UP_MS);
    let due;
    try {
      due = t.preset === 'once' ? (t.runAt && t.runAt <= now && t.runAt > (t.lastRun || 0) ? t.runAt : null) : nextRun(t, since);
    } catch {
      continue;
    }
    t.lastCheck = now;
    if (due && due <= now) {
      // Missed while the server was down: one catch-up run, like Desktop.
      runTask(t.id, now - due > 5 * 60_000 ? 'catch-up' : 'schedule').catch(() => {});
      if (t.preset === 'once') t.enabled = false;
    }
  }
  save();
}

export function startScheduler(run) {
  runner = run;
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, 30_000).unref?.();
}
