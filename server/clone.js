// "Clone from git" in New chat: git clone into the projects root, reporting progress.
// Private repos work through the host's own git credentials (credential helper, SSH keys);
// git is told never to prompt, so a missing login fails with a message instead of hanging.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

// https://host/owner/repo(.git), http://, ssh://, git://, and scp-style git@host:owner/repo.
const URL_RE = /^(?:(?:https?|ssh|git):\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/i;

export function repoName(url) {
  const last = String(url).trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || '';
  return last.replace(/\.git$/i, '');
}

export function checkClone(url, name) {
  url = String(url || '').trim();
  if (!URL_RE.test(url) || url.startsWith('-')) throw new Error('Enter a git address like https://github.com/owner/repo or git@github.com:owner/repo.git');
  name = String(name || '').trim() || repoName(url);
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Folder name: use letters, numbers, dot, dash or underscore');
  const dest = path.join(config.projectsRoot, name);
  if (fs.existsSync(dest)) throw new Error(`A folder called ${name} already exists in ${config.projectsRoot}. Pick another name, or open it from the list.`);
  return { url, name, dest };
}

function hint(text) {
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|Host key verification failed|Repository not found|access denied|403/i.test(text)) {
    return ' This machine has no login for that repository. Set up git credentials (or an SSH key) for the user that runs Claude UI, then try again.';
  }
  return '';
}

/**
 * Runs the clone. onProgress gets { phase, percent, line }. Resolves to the real path, rejects
 * with git's message. Returns { promise, cancel }.
 */
export function cloneRepo({ url, dest }, onProgress) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
  const proc = spawn('git', ['-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', url, dest], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  let cancelled = false;
  const promise = new Promise((resolve, reject) => {
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      tail = (tail + d).slice(-4000);
      // git redraws progress lines with \r.
      for (const line of d.split(/[\r\n]+/)) {
        const m = line.match(/^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/);
        if (m) onProgress?.({ phase: m[1].trim(), percent: Number(m[2]), line: line.trim() });
        else if (line.trim()) onProgress?.({ line: line.trim() });
      }
    });
    proc.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git is not installed on the server' : e.message)));
    proc.on('close', (code) => {
      if (code === 0 && !cancelled) return resolve(fs.realpathSync(dest));
      fs.rmSync(dest, { recursive: true, force: true });
      if (cancelled) return reject(new Error('Clone cancelled'));
      const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating|Total))|\d+%/.test(l));
      const msg = lines.slice(-3).join(' ') || `git clone failed (exit ${code})`;
      reject(new Error(msg.replace(/([^.!?])$/, '$1.') + hint(tail)));
    });
  });
  const cancel = () => {
    if (proc.exitCode !== null) return;
    cancelled = true;
    proc.kill();
  };
  return { promise, cancel };
}
