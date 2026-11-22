// Side chat (Desktop's /btw, Ctrl+;): a quick question about the conversation that doesn't go into
// it. Runs a throwaway fork of the chat's CLI session with read-only tools and nothing saved.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { claudeEnv, withGatewayArgs } from './gateway.js';
import { resolveCommand } from './launch.js';
import { transcriptPath } from './chat.js';

export function sideChat(session, question, history, { onDelta, onDone }) {
  const m = session.meta;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--tools', 'Read,Grep,Glob', ...config.claudeArgs];
  if (m.claudeSessionId && fs.existsSync(transcriptPath(m.cwd, m.claudeSessionId))) args.push('--resume', m.claudeSessionId, '--fork-session');
  if (m.model) args.push('--model', m.model);
  const prior = (Array.isArray(history) ? history : [])
    .slice(-20)
    .map((h) => `Q: ${String(h.q || '').slice(0, 4000)}\nA: ${String(h.a || '').slice(0, 8000)}`)
    .join('\n\n');
  const prompt =
    `(Side question from the user, asked in a side panel. It is not part of the main task: answer it directly and briefly from the conversation so far, reading files only if needed. Don't change anything and don't continue the main work.)` +
    (prior ? `\n\nEarlier side questions:\n${prior}` : '') +
    `\n\n${question}`;
  const env = claudeEnv();
  const cmd = resolveCommand(config.claudeBin, withGatewayArgs(args));
  const p = spawn(cmd.file, cmd.args, { cwd: m.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let text = '';
  let err = '';
  let finished = false;
  const done = (e) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onDone(e ? { error: e } : { text });
  };
  const timer = setTimeout(() => (p.kill('SIGKILL'), done('Took too long (3 minutes).')), 180_000);
  p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  p.on('error', (e) => done(e.message));
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta' && !msg.parent_tool_use_id) {
      text += msg.event.delta.text;
      onDelta(msg.event.delta.text);
    } else if (msg.type === 'result') {
      if (msg.is_error) done(msg.result || 'Failed');
      else {
        if (!text && msg.result) (text = msg.result), onDelta(msg.result);
        done();
      }
    }
  });
  p.on('close', (code) => done(code ? err.trim().split('\n').slice(-3).join('\n') || `claude exited with code ${code}` : null));
  p.stdin.end(prompt);
  return () => p.kill('SIGTERM');
}
