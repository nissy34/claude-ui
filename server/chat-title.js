// Short descriptive chat titles, like Claude Desktop's ("Fix arm64 build in gpu-remote PR"),
// instead of the raw start of the first message.
//
// Order of preference for a chat's name:
//   1. a name the user (or a chat, via rename_session) gave it: meta.customName, never touched here
//   2. a title Claude Code itself stored in the transcript (/rename "custom-title", or "ai-title",
//      which interactive sessions write)
//   3. a title from one quick, tool-less call to a small model, after the first turn
//   4. the first line of the first message (set in ChatSession.send as a placeholder)
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { claudeEnv, withGatewayArgs } from './gateway.js';
import { resolveCommand } from './launch.js';

const SYSTEM = [
  'You name chat conversations for a sidebar list.',
  'Reply with only the title: 2 to 6 words, sentence case, saying what the user wants done or asked about.',
  'Keep names of projects, files, tools and products. Drop URLs, greetings and filler.',
  'No quotes, no trailing period, no emoji, no "Title:" prefix.',
].join(' ');

const MAX_PROMPT = 3000;

/** Clean a model reply into a sidebar title, or '' if it is unusable. */
export function cleanTitle(raw) {
  let t = String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) || '';
  t = t
    .replace(/^(title|chat title)\s*:\s*/i, '')
    .replace(/^[#*_`"'“”‘’\s]+|[*_`"'“”‘’\s]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  return t;
}

/** Title Claude Code stored in its transcript: a /rename wins over its own ai-title. */
export async function transcriptTitle(file) {
  if (!file || !fs.existsSync(file)) return null;
  let custom = '';
  let ai = '';
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
        if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (custom) return { title: custom.trim().slice(0, 80), source: 'custom' };
  if (ai) return { title: ai.trim().slice(0, 80), source: 'ai' };
  return null;
}

/** First user text and first assistant reply text from a chat's event log. */
export function firstExchange(events) {
  let user = '';
  let assistant = '';
  for (const e of events) {
    if (!user && e.k === 'user' && !e.from && typeof e.text === 'string' && e.text.trim()) user = e.text.trim();
    if (user && !assistant && e.k === 'block' && !e.parent && e.block?.type === 'text' && e.block.text?.trim()) assistant = e.block.text.trim();
    if (user && assistant) break;
  }
  return { user, assistant };
}

/**
 * Ask a small model for a title. Runs the user's own claude CLI once, with no tools, no MCP
 * servers, no hooks and no saved session, so it costs a fraction of a cent and leaves no trace
 * in Past conversations. Resolves to '' on any failure.
 */
export function generateTitle({ user, assistant, env = {}, cwd = config.scratchDir, timeoutMs = 45_000 }) {
  if (!user && !assistant) return Promise.resolve('');
  const half = MAX_PROMPT / 2;
  const prompt =
    `Name this conversation.\n\n<first_user_message>\n${user.slice(0, assistant ? half : MAX_PROMPT) || '(only pictures)'}\n</first_user_message>` +
    (assistant ? `\n\n<assistant_reply_start>\n${assistant.slice(0, half)}\n</assistant_reply_start>` : '');
  const args = [
    '-p',
    '--model', config.titleModel,
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', 'user',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--system-prompt', SYSTEM,
  ];
  const e = claudeEnv(env);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let p;
    try {
      const cmd = resolveCommand(config.claudeBin, withGatewayArgs(args));
      p = spawn(cmd.file, cmd.args, { cwd, env: e, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish('');
    }
    const timer = setTimeout(() => {
      p.kill();
      finish('');
    }, timeoutMs);
    p.on('error', () => finish(''));
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        finish(j.is_error ? '' : cleanTitle(j.result));
      } catch {
        finish('');
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

// One title call at a time, so a backfill of many chats doesn't start many processes at once.
let chain = Promise.resolve();
export function queueTitle(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
