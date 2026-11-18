// The URL opener: MCP servers and CLIs that "open the browser" for a sign-in reach our
// open-url.js instead, so the page opens in the built-in browser on this machine (where its
// redirect to http://127.0.0.1:<port> lands) and shows up in the UI on any device.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'open-url.js');
const NAMES = ['claude-web-open', 'xdg-open', 'x-www-browser', 'www-browser'];
let binDir = null;

function setup() {
  if (binDir !== null) return binDir;
  binDir = '';
  try {
    const dir = path.join(config.dataDir, 'bin');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'claude-web-open.cmd'), `@"${process.execPath}" "${SCRIPT}" %*\r\n`);
    } else {
      const body = `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`;
      for (const n of NAMES) fs.writeFileSync(path.join(dir, n), body, { mode: 0o755 });
    }
    binDir = dir;
  } catch (e) {
    console.error('URL opener setup failed:', e.message);
  }
  return binDir;
}

/** Add the opener to a child process environment. sid: the chat/terminal it belongs to, if any. */
export function withOpener(env, sid = '') {
  const dir = setup();
  if (!dir || !config.browser) return env;
  const win = process.platform === 'win32';
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = dir + path.delimiter + (env[pathKey] || '');
  env.BROWSER = path.join(dir, win ? 'claude-web-open.cmd' : 'claude-web-open');
  env.CW_INTERNAL_URL = config.internalUrl;
  env.CW_INTERNAL_TOKEN = config.internalToken;
  if (sid) env.CW_SESSION_ID = sid;
  return env;
}
