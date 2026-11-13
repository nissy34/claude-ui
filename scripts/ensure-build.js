// Rebuilds the web UI when the built files are missing or older than the source,
// so `npm start` after a `git pull` never serves a stale UI.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'dist', 'index.html');

function newest(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

let builtAt = 0;
try {
  builtAt = fs.statSync(built).mtimeMs;
} catch {}
const srcAt = Math.max(newest(path.join(root, 'web')), fs.statSync(path.join(root, 'package.json')).mtimeMs);
if (builtAt < srcAt) {
  console.log(builtAt ? 'Web UI source changed since the last build, rebuilding…' : 'Building the web UI…');
  try {
    execSync('npx vite build', { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('UI build failed. Run `npm install` (it needs the dev dependencies), then `npm run build`.');
    process.exit(1);
  }
}
