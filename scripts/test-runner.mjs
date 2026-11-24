#!/usr/bin/env node
// Tests for the session runner (server/runner.js) and its client: spawn, live output, detach and
// reattach from an offset with nothing lost or repeated, exit while detached, process-group
// signals, spool trimming on ack, PTYs.   npm run test:runner
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerClient } from '../server/runner-client.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-runner-'));
const sock = path.join(dir, 'runner.sock');
let failures = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

const runner = spawn(process.execPath, [path.join(root, 'server/runner.js')], { env: { ...process.env, CW_RUNNER_SOCKET: sock, CW_RUNNER_TRIM_AT: '4096' }, stdio: ['ignore', 'pipe', 'inherit'] });
let runnerLog = '';
runner.stdout.on('data', (d) => (runnerLog += d));
await until(() => fs.existsSync(sock));

async function client() {
  const c = new RunnerClient(sock);
  await c.connect();
  return c;
}

/** Collects a process's output (by offset, so a repeat or gap shows) and its exit. */
function collector(c, id) {
  const st = { text: '', next: 0, gaps: 0, repeats: 0, exit: null, stderr: '' };
  st.h = {
    out(offset, buf) {
      if (offset < st.next) st.repeats++;
      if (offset > st.next) st.gaps++;
      st.text += buf.toString('utf8');
      st.next = offset + buf.length;
    },
    err(buf) {
      st.stderr += buf.toString('utf8');
    },
    exit(code, signal, offset) {
      st.exit = { code, signal, offset };
    },
  };
  c.watch(id, st.h);
  return st;
}

const env = { ...process.env };
const node = process.execPath;

try {
  // ---- hello, permissions ----
  const a = await client();
  ok(a.info.protocol === 1 && a.info.runnerId, 'hello returns protocol and runner id');
  ok((fs.statSync(sock).mode & 0o777) === 0o600, 'socket is private (0600)');

  // ---- spawn, write, live output ----
  const echo = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l==='quit')process.exit(3);process.stdout.write('echo:'+l+'\\n');}});setInterval(()=>{},1000);`;
  let st = collector(a, 'chat1');
  const sp = await a.request('spawn', { id: 'chat1', kind: 'pipe', file: node, args: ['-e', echo], cwd: dir, env, meta: { label: 'x' } });
  ok(sp.pid > 0, 'spawn returns a pid');
  a.notify('write', { id: 'chat1', data: 'hello\n' });
  ok(await until(() => st.text.includes('echo:hello')), 'live output arrives');
  let dup = null;
  try {
    await a.request('spawn', { id: 'chat1', kind: 'pipe', file: node, args: ['-e', ''], cwd: dir, env });
  } catch (e) {
    dup = e.message;
  }
  ok(/already running/.test(dup || ''), 'a running id cannot be spawned twice');

  // ---- detach: the server goes away, output keeps spooling ----
  const consumed = st.next;
  a.request('ack', { id: 'chat1', offset: consumed });
  await sleep(50);
  a.close();
  await sleep(100);
  // Write through a second, short-lived client that never attaches (as if the CLI kept talking).
  const w = await client();
  for (let i = 0; i < 5; i++) w.notify('write', { id: 'chat1', data: `while-down-${i}\n` });
  await sleep(300);
  w.close();

  // ---- reattach from the last offset ----
  const b = await client();
  const st2 = collector(b, 'chat1');
  st2.next = consumed;
  const at = await b.request('attach', { id: 'chat1', from: consumed });
  ok(at.alive && at.from === consumed && !at.gap, 'attach from the last offset succeeds');
  ok(await until(() => st2.text.includes('while-down-4')), 'output written while detached is replayed');
  ok(!st2.text.includes('echo:hello'), 'output before the offset is not replayed');
  ok(st2.repeats === 0 && st2.gaps === 0, 'replay has no gaps or repeats', `gaps ${st2.gaps} repeats ${st2.repeats}`);
  b.notify('write', { id: 'chat1', data: 'after\n' });
  ok(await until(() => st2.text.includes('echo:after')), 'live output continues after the replay');
  ok(st2.text.split('\n').filter((l) => l.startsWith('echo:while-down')).length === 5, 'each detached line arrives exactly once');

  // ---- a second attach takes over ----
  const c2 = await client();
  let detached = false;
  b.watch('chat1', { ...st2.h, detached: () => (detached = true) });
  const st3 = collector(c2, 'chat1');
  await c2.request('attach', { id: 'chat1', from: st2.next });
  ok(await until(() => detached), 'the older client is told it was detached');
  c2.notify('write', { id: 'chat1', data: 'two\n' });
  ok(await until(() => st3.text.includes('echo:two')), 'the newer client gets the output');
  c2.close();

  // ---- exit while detached ----
  const d = await client();
  const st4 = collector(d, 'chat2');
  await d.request('spawn', { id: 'chat2', kind: 'pipe', file: node, args: ['-e', "setTimeout(()=>{process.stdout.write('last words\\n');process.stderr.write('oops\\n');process.exit(7)},300)"], cwd: dir, env });
  d.close();
  await sleep(700);
  const e = await client();
  const list = await e.request('list');
  const p2 = list.procs.find((p) => p.id === 'chat2');
  ok(p2 && !p2.alive && p2.exitCode === 7, 'list shows a process that exited while detached', JSON.stringify(p2));
  const st5 = collector(e, 'chat2');
  const at2 = await e.request('attach', { id: 'chat2', from: 0 });
  ok(await until(() => st5.exit), 'attaching to an exited process delivers its exit');
  ok(st5.text === 'last words\n' && st5.exit.code === 7 && st5.exit.offset === st5.next, 'its output comes before the exit, in full');
  ok(at2.stderr.includes('oops'), 'the stderr tail is kept');
  await e.request('reap', { id: 'chat2' });
  ok(!(await e.request('list')).procs.some((p) => p.id === 'chat2'), 'reap forgets it');
  ok(!fs.existsSync(path.join(dir, 'spool', 'chat2.spool')), 'reap deletes the spool');

  // ---- a signal reaches the whole process group ----
  const st6 = collector(e, 'grp');
  const marker = path.join(dir, 'child.pid');
  await e.request('spawn', { id: 'grp', kind: 'pipe', file: 'bash', args: ['-c', `sleep 300 & echo $! > ${marker}; wait`], cwd: dir, env });
  await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim());
  const childPid = Number(fs.readFileSync(marker, 'utf8'));
  await e.request('signal', { id: 'grp', sig: 'SIGTERM' });
  ok(await until(() => st6.exit), 'signal ends the process');
  const childAlive = await until(() => {
    try {
      process.kill(childPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 2000);
  ok(childAlive, 'and the tool it started (same process group)');

  // ---- trim on ack ----
  const st7 = collector(e, 'big');
  await e.request('spawn', { id: 'big', kind: 'pipe', file: node, args: ['-e', "for(let i=0;i<400;i++)process.stdout.write('line '+String(i).padStart(4,'0')+' '+'x'.repeat(40)+'\\n');setInterval(()=>{},1000)"], cwd: dir, env });
  ok(await until(() => st7.text.includes('line 0399')), 'large output arrives');
  await e.request('ack', { id: 'big', offset: st7.next - 100 });
  const big = (await e.request('list')).procs.find((p) => p.id === 'big');
  ok(big.spoolStart === st7.next - 100 && fs.statSync(path.join(dir, 'spool', 'big.spool')).size === 100, 'ack trims the spool');
  const st8 = { text: '' };
  const f = await client();
  f.watch('big', { out: (o, b) => (st8.text += b.toString()) });
  const at3 = await f.request('attach', { id: 'big', from: 0 });
  ok(at3.gap && at3.from === big.spoolStart, 'attaching before the trimmed start reports a gap');
  ok(await until(() => st8.text.length === 100), 'and replays what is left');
  await f.request('signal', { id: 'big', sig: 'SIGKILL' });

  // ---- PTY ----
  if (f.info.pty) {
    const st9 = collector(f, 'term');
    await f.request('spawn', { id: 'term', kind: 'pty', file: 'bash', args: ['--norc', '--noprofile'], cwd: dir, env: { ...env, PS1: '$ ' }, cols: 80, rows: 24 });
    f.notify('write', { id: 'term', data: 'echo pty-$((6*7))\r' });
    ok(await until(() => st9.text.includes('pty-42')), 'a PTY runs and echoes');
    await f.request('resize', { id: 'term', cols: 100, rows: 30 });
    f.notify('write', { id: 'term', data: 'stty size\r' });
    ok(await until(() => st9.text.includes('30 100')), 'resize reaches the PTY');
    f.notify('write', { id: 'term', data: 'exit\r' });
    ok(await until(() => st9.exit), 'a PTY exit is reported');
  } else console.log('skip PTY tests (node-pty not available)');

  // ---- bad requests ----
  let bad = null;
  try {
    await f.request('nope');
  } catch (err) {
    bad = err.message;
  }
  ok(/unknown op/.test(bad || ''), 'an unknown op is refused');
  try {
    await f.request('spawn', { id: '../x', file: node });
  } catch (err) {
    bad = err.message;
  }
  ok(/bad id/.test(bad || ''), 'an id with a path in it is refused');
  f.close();

  // ---- runner shutdown ends its processes ----
  const g = await client();
  let lost = false;
  g.on('lost', () => (lost = true));
  const pid1 = (await g.request('list')).procs.find((p) => p.id === 'chat1').pid;
  runner.kill('SIGTERM');
  ok(await until(() => lost), 'clients see the runner go away');
  const gone = await until(() => {
    try {
      process.kill(pid1, 0);
      return false;
    } catch {
      return true;
    }
  }, 4000);
  ok(gone, 'a runner shutdown stops its processes');
} catch (e) {
  console.error(e);
  failures++;
} finally {
  runner.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall runner tests passed');
process.exit(failures ? 1 : 0);
