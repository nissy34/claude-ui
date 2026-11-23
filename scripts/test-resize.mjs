#!/usr/bin/env node
// Browser test for drag-to-resize side columns (web/src/ui/resizable.jsx): serves the built UI
// (npm run build first) with the fake CLI, then drags the sidebar, details rail, side panel and
// project panel edges, checks widths are clamped, saved across reloads, reset by double-click
// and Enter, moved by the arrow keys, and that phones get no handles.
// Set SHOTS=<dir> to save desktop screenshots.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed (it is an optional dependency)');
  process.exit(1);
}
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resize-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n\nA change so the Changes panel has something to show.\n');

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: 'pw',
  CW_DATA_DIR: path.join(tmp, 'data'),
  CW_PROJECTS_ROOT: path.join(tmp, 'projects'),
  CW_CLAUDE_BIN: path.join(here, 'fake-claude.mjs'),
  CW_BROWSER: '0',
  CW_AUTO_TITLES: '0',
  FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET']) delete env[k];

let failures = 0;
let passes = 0;
const check = (cond, msg, extra) => {
  if (cond) passes++, console.log(`  ok   ${msg}`);
  else failures++, console.log(`  FAIL ${msg}`, extra !== undefined ? String(extra).slice(0, 600) : '');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));

const width = (page, sel) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
async function drag(page, sel, dx) {
  const h = page.locator(`${sel} > .resize-handle`).first();
  const b = await h.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
  await sleep(100);
}
const shoot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, name + '.png') }));

let browser;
async function main() {
  const end = Date.now() + 15_000;
  while (!(await fetch(base + '/api/me').then(() => true).catch(() => false))) {
    if (Date.now() > end) throw new Error('server did not start');
    await sleep(150);
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  console.log('desktop');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByPlaceholder('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.login').waitFor({ state: 'detached', timeout: 10_000 });
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const post = (u, body) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }).then((r) => r.json());
  const { session } = await post('/api/sessions', { cwd: repo, kind: 'chat', name: 'Resize test' });
  await page.goto(`${base}/#s=${session.id}`);
  await page.locator('.sidebar').waitFor();
  await page.locator('.session-rail').waitFor({ timeout: 10_000 });
  await shoot(page, '1-default');

  // Sidebar: handle on its right edge.
  const s0 = await width(page, '.sidebar');
  check(s0 === 280, 'sidebar starts at its default width', s0);
  await drag(page, '.sidebar', 80);
  check((await width(page, '.sidebar')) === 360, 'dragging the sidebar edge widens it', await width(page, '.sidebar'));
  await drag(page, '.sidebar', 600);
  check((await width(page, '.sidebar')) === 480, 'sidebar stops at its max', await width(page, '.sidebar'));
  await drag(page, '.sidebar', -600);
  check((await width(page, '.sidebar')) === 200, 'sidebar stops at its min', await width(page, '.sidebar'));
  await drag(page, '.sidebar', 120);

  // Details rail: handle on its left edge, drag left to widen.
  const r0 = await width(page, '.session-rail');
  await drag(page, '.session-rail', -100);
  check((await width(page, '.session-rail')) === r0 + 100, 'dragging the details rail edge left widens it', `${r0} -> ${await width(page, '.session-rail')}`);
  await shoot(page, '2-sidebar-and-rail-resized');

  // Reload: widths are kept.
  await page.reload();
  await page.locator('.session-rail').waitFor({ timeout: 10_000 });
  check((await width(page, '.sidebar')) === 320, 'sidebar width is kept after a reload', await width(page, '.sidebar'));
  check((await width(page, '.session-rail')) === r0 + 100, 'rail width is kept after a reload', await width(page, '.session-rail'));

  // Keyboard: arrows move 16px (64 with Shift), Enter resets.
  const sh = page.locator('.sidebar > .resize-handle');
  await sh.focus();
  await page.keyboard.press('ArrowRight');
  check((await width(page, '.sidebar')) === 336, 'ArrowRight on the sidebar handle widens it 16px', await width(page, '.sidebar'));
  await page.keyboard.press('Shift+ArrowLeft');
  check((await width(page, '.sidebar')) === 272, 'Shift+ArrowLeft narrows it 64px', await width(page, '.sidebar'));
  check((await sh.getAttribute('aria-valuenow')) === '272' && (await sh.getAttribute('role')) === 'separator', 'the handle is a separator with its current width', await sh.getAttribute('aria-valuenow'));
  await page.keyboard.press('Enter');
  check((await width(page, '.sidebar')) === 280, 'Enter resets the sidebar', await width(page, '.sidebar'));
  await page.locator('.session-rail > .resize-handle').dblclick();
  await sleep(100);
  check((await width(page, '.session-rail')) === r0, 'double-click resets the rail', await width(page, '.session-rail'));

  // Side panel (Changes).
  await page.getByTitle('Changes and files').click();
  await page.locator('.side-panel').waitFor();
  const p0 = await width(page, '.side-panel');
  await drag(page, '.side-panel', -150);
  const p1 = await width(page, '.side-panel');
  check(p1 === p0 + 150, 'dragging the side panel edge widens it', `${p0} -> ${p1}`);
  await shoot(page, '3-side-panel-resized');
  await drag(page, '.side-panel', -2000);
  const pmax = await width(page, '.side-panel');
  const chat = await width(page, '.chat-view');
  check(chat >= 300, 'a very wide side panel still leaves room for the chat', `panel ${pmax}, chat ${chat}`);
  await drag(page, '.side-panel', 2000);
  check((await width(page, '.side-panel')) === 320, 'side panel stops at its min', await width(page, '.side-panel'));
  await page.locator('.side-panel > .resize-handle').dblclick();
  await sleep(100);
  check((await width(page, '.side-panel')) === p0, 'double-click resets the side panel', await width(page, '.side-panel'));
  // Wide mode keeps its own width.
  await drag(page, '.side-panel', -60);
  await page.getByTitle('Wider').click();
  const w0 = await width(page, '.side-panel');
  await drag(page, '.side-panel', 100);
  check((await width(page, '.side-panel')) === w0 - 100, 'wide mode can be resized too', `${w0} -> ${await width(page, '.side-panel')}`);
  await page.getByTitle('Narrower').click();
  check((await width(page, '.side-panel')) === p0 + 60, 'normal mode keeps its own width', await width(page, '.side-panel'));
  // Iframes (Browser, artifacts) must not swallow the drag.
  check(await page.evaluate(() => !document.body.classList.contains('pane-dragging')), 'the drag class is cleared after a drag');

  // Project panel.
  const { project } = await post('/api/cprojects', { name: 'Resize project', folders: [] });
  if (project?.id) {
    await page.goto(`${base}/#p=${project.id}`);
    const has = await page.locator('.pj-right').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (has) {
      const j0 = await width(page, '.pj-right');
      await drag(page, '.pj-right', -120);
      check((await width(page, '.pj-right')) === j0 + 120, 'dragging the project panel edge widens it', `${j0} -> ${await width(page, '.pj-right')}`);
      await shoot(page, '4-project-panel-resized');
    } else check(false, 'project view opens', page.url());
  } else check(false, 'project is created', JSON.stringify(project));
  check(errors.length === 0, 'no page errors on desktop', errors.join('\n'));
  await ctx.close();

  console.log('phone');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await pctx.newPage();
  // Saved desktop widths must not leak into the phone layout.
  await pp.goto(base + '/');
  await pp.evaluate(() => {
    localStorage.setItem('cw.width.sidebar', '470');
    localStorage.setItem('cw.width.panel', '900');
  });
  await pp.getByPlaceholder('Password').fill('pw');
  await pp.getByRole('button', { name: 'Sign in' }).click();
  await pp.locator('.login').waitFor({ state: 'detached', timeout: 10_000 });
  await pp.goto(`${base}/#s=${session.id}`);
  await pp.locator('.sidebar').waitFor({ state: 'attached' });
  check(!(await pp.locator('.sidebar > .resize-handle').isVisible()), 'phones get no sidebar handle');
  check((await width(pp, '.sidebar')) === Math.min(Math.round(390 * 0.86), 330), 'phone drawer keeps its own width', await width(pp, '.sidebar'));
  await pctx.close();
}

main()
  .catch((e) => (failures++, console.error(e)))
  .finally(async () => {
    await browser?.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
