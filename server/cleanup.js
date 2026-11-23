// Automatic clean up of what chats leave in the data dir: files and pictures you sent
// (<data dir>/uploads/<chat>/…) and pictures tools returned (<data dir>/tool-images/).
// Anything older than CW_UPLOAD_DAYS (default 30, like Claude Code's own transcript clean up;
// 0 keeps everything) is deleted at start and then once a day. Deleting a chat deletes its
// uploads right away (sessions.js).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Delete files under `dir` last changed before `cutoff`, then folders left empty (but not a chat's
 * own uploads folder, which its running Claude has open with --add-dir). Returns the count.
 */
function sweep(dir, cutoff, depth = 0) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        n += sweep(p, cutoff, depth + 1);
        if (depth > 0 && !fs.readdirSync(p).length) fs.rmdirSync(p);
      } else if (fs.lstatSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        n++;
      }
    } catch {}
  }
  return n;
}

export function cleanOldFiles(days = config.uploadDays, now = Date.now()) {
  if (!(days > 0)) return 0;
  const cutoff = now - days * DAY;
  return sweep(path.join(config.dataDir, 'uploads'), cutoff) + sweep(path.join(config.dataDir, 'tool-images'), cutoff);
}

export function startCleanup() {
  const run = () => {
    const n = cleanOldFiles();
    if (n) console.log(`clean up: deleted ${n} uploaded file(s) and picture(s) older than ${config.uploadDays} days`);
  };
  setTimeout(run, 30_000).unref?.();
  setInterval(run, DAY).unref?.();
}
