// Cross-platform helpers for starting processes.
// On Windows, `claude` installed via npm is a .cmd shim, which can't be spawned directly.
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

function findOnPath(bin) {
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return bin;
  const exts = isWin ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return bin;
}

/** Returns { file, args } ready for child_process.spawn or node-pty. */
export function resolveCommand(bin, args) {
  if (!isWin) return { file: bin, args };
  const full = findOnPath(bin);
  if (/\.(cmd|bat)$/i.test(full)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', full, ...args] };
  }
  return { file: full, args };
}

export function defaultShell() {
  if (isWin) return { file: process.env.CW_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.CW_SHELL || process.env.SHELL || '/bin/bash', args: ['-l'] };
}
