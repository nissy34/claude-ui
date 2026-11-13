// The models this account can use, as the CLI reports them (initialize control request: the
// same list the SDK's supportedModels() returns). Cached, refreshed by chats as they start.
import { spawn } from 'node:child_process';
import { config, PRIVATE_ENV } from './config.js';
import { resolveCommand } from './launch.js';

let cache = null;
let cachedAt = 0;
let inflight = null;

export function setModels(list) {
  cache = list.map((x) => ({
    value: x.value,
    resolvedModel: x.resolvedModel || x.value,
    displayName: x.displayName || x.value,
    description: x.description || '',
    efforts: x.supportedEffortLevels || [],
  }));
  cachedAt = Date.now();
}

function fetchFromCli() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of PRIVATE_ENV) delete env[k];
    const cmd = resolveCommand(config.claudeBin, [...config.claudeArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    let p;
    try {
      p = spawn(cmd.file, cmd.args, { env, cwd: config.projectsRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let buf = '';
    const done = (v) => {
      clearTimeout(t);
      try {
        p.kill();
      } catch {}
      resolve(v);
    };
    const t = setTimeout(() => done(null), 20_000);
    p.on('error', () => done(null));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'control_response' && msg.response?.request_id === 'models') return done(msg.response.response?.models || null);
        } catch {}
      }
    });
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

export async function getModels() {
  if (cache && Date.now() - cachedAt < 30 * 60_000) return cache;
  inflight ||= fetchFromCli().then((list) => {
    inflight = null;
    if (list) setModels(list);
    return cache;
  });
  return (await inflight) || cache || [];
}
