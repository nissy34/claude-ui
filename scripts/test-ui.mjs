#!/usr/bin/env node
// Browser smoke test: serves the built UI (npm run build first) with the scripted fake CLI
// (scripts/fake-claude.mjs), then signs in, opens a chat, sends a message and waits for the reply
// in headless Chromium, on a desktop and a phone viewport. Fails on page errors.
// Run: node scripts/test-ui.mjs   (CHROMIUM_PATH=/path/to/chrome to pick the browser)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed (it is an optional dependency)');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ui-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

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
  if (cond) {
    passes++;
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`, extra !== undefined ? String(extra).slice(0, 600) : '');
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));

let browser;
async function main() {
  const end = Date.now() + 15_000;
  while (!(await fetch(base + '/api/me').then(() => true).catch(() => false))) {
    if (Date.now() > end) throw new Error('server did not start');
    await sleep(150);
  }

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const viewports = [
    { name: 'desktop', viewport: { width: 1280, height: 800 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  ];
  for (const vp of viewports) {
    console.log(`UI on ${vp.name}`);
    const ctx = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

    await page.goto(base + '/');
    const pw = page.getByPlaceholder('Password');
    await pw.waitFor({ timeout: 10_000 });
    check(true, 'the login page loads');
    await pw.fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const err = await page.locator('.login .error').waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
    check(err, 'a wrong password shows an error');
    await pw.fill('pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const signedIn = await page.locator('.login').waitFor({ state: 'detached', timeout: 10_000 }).then(() => true).catch(() => false);
    check(signedIn, 'signing in leaves the login page');

    const cookies = await ctx.cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ cwd: repo, kind: 'chat', name: `UI smoke ${vp.name}` }) });
    const { session } = await res.json();
    check(session?.id, 'a chat is created', JSON.stringify(session));

    await page.goto(`${base}/#s=${session.id}`);
    const box = page.locator('[contenteditable][data-placeholder]').first();
    const hasBox = await box.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    check(hasBox, 'the chat opens with a composer');
    await page.getByText(`UI smoke ${vp.name}`).first().waitFor({ timeout: 5_000 }).then(
      () => check(true, 'the chat name shows'),
      () => check(false, 'the chat name shows'),
    );
    if (hasBox) {
      await box.click();
      await page.keyboard.type(`hello from ${vp.name}`);
      // Enter sends on desktop; touch devices use the Send button (Enter adds a line there).
      if (vp.hasTouch) await page.locator('button.send').click();
      else await page.keyboard.press('Enter');
      const replied = await page.getByText(`ok: hello from ${vp.name}`).first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
      check(replied, 'sending a message shows the reply');
    }
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    if (failures && process.env.SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${vp.name}.png`) });
    }
    await ctx.close();
  }
}

async function cleanup() {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(300);
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}

main().then(
  async () => {
    console.log(`\n${passes} passed, ${failures} failed`);
    await cleanup();
    process.exit(failures ? 1 : 0);
  },
  async (e) => {
    console.error(e);
    await cleanup();
    process.exit(1);
  },
);
