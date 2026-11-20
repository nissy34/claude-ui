#!/usr/bin/env node
// Syntax check for the server and scripts (there is no build step for them): `node --check` on each file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server', 'scripts'].flatMap((dir) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((f) => /\.(m?js)$/.test(f))
    .map((f) => path.join(dir, f)),
);
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`${f}:\n${e.stderr}`);
  }
}
console.log(`${files.length - bad} of ${files.length} files parse`);
process.exit(bad ? 1 : 0);
