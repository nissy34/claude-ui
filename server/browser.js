// The built-in browser: one headless Chromium on the server, one tab per chat session.
// Claude drives it through the "browser" MCP server (mcp-browser.js -> /internal/browser/*),
// and the web UI shows the same tab live in the Browser panel and can click and type into it.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {}
  }
  return null;
}

let pw;
let browserPromise = null;
const tabs = new Map(); // sessionId -> { context, page, console: [], listeners:Set, version }

export function browserAvailable() {
  if (pw === undefined) pw = loadPlaywright();
  return !!pw && config.browser;
}

async function launch() {
  if (!browserAvailable()) throw new Error('The built-in browser needs Playwright on the server: run `npm install` and `npx playwright-core install chromium` in the claude-ui folder (or set CW_BROWSER_PATH to a Chrome/Edge binary).');
  const base = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const attempts = config.browserPath ? [{ ...base, executablePath: config.browserPath }] : [base, { ...base, channel: 'chrome' }, { ...base, channel: 'msedge' }];
  let last;
  for (const opts of attempts) {
    try {
      const b = await pw.chromium.launch(opts);
      b.on('disconnected', () => {
        browserPromise = null;
        tabs.clear();
      });
      return b;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Could not start Chromium: ${last?.message?.split('\n')[0]}. Run \`npx playwright install chromium\` on the server or set CW_BROWSER_PATH.`);
}

function getBrowser() {
  if (!browserPromise) browserPromise = launch().catch((e) => ((browserPromise = null), Promise.reject(e)));
  return browserPromise;
}

function bump(t) {
  t.version++;
  for (const fn of t.listeners) fn();
}

// Sign-in pages (opened by MCP servers and CLIs through the URL opener, or by Sign in) open as
// tabs of a separate browser whose profile is kept on disk, so SSO cookies survive restarts and
// later sign-ins finish by themselves. Claude's own tabs stay throwaway. A sign-in tab closes
// itself once it lands on its http://127.0.0.1:<port> callback.
export const isSigninId = (id) => /^signin-\d+$/.test(String(id));
let signinPromise = null;
let signinSeq = 0;
const signinListeners = new Set();
export function onSigninChange(fn) {
  signinListeners.add(fn);
  return () => signinListeners.delete(fn);
}
const signinChanged = () => signinListeners.forEach((fn) => fn(signinList()));

async function launchSignin() {
  if (!browserAvailable()) throw new Error('The built-in browser is not available on this server.');
  const dir = path.join(config.dataDir, 'browser-profile');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true };
  const attempts = config.browserPath ? [{ ...base, executablePath: config.browserPath }] : [base, { ...base, channel: 'chrome' }, { ...base, channel: 'msedge' }];
  let last;
  for (const opts of attempts) {
    try {
      const ctx = await pw.chromium.launchPersistentContext(dir, opts);
      ctx.on('close', () => {
        signinPromise = null;
        for (const id of [...tabs.keys()]) if (isSigninId(id)) tabs.delete(id);
        signinChanged();
      });
      // A popup from a sign-in page replaces it in the same tab.
      ctx.on('page', async (p) => {
        const opener = await p.opener().catch(() => null);
        if (!opener) return;
        const owner = [...tabs.values()].find((t) => t.page === opener);
        if (!owner) return;
        // Popups start on about:blank; wait for the page it is really opening.
        if (p.url() === 'about:blank') await p.waitForURL((u) => u.href !== 'about:blank', { timeout: 15_000 }).catch(() => {});
        const url = p.url();
        await p.close().catch(() => {});
        if (url && url !== 'about:blank') owner.page.goto(url).catch(() => {});
      });
      for (const p of ctx.pages()) await p.close().catch(() => {});
      return ctx;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Could not start the sign-in browser: ${last?.message?.split('\n')[0]}`);
}

const LOOPBACK_PAGE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i;
const isCallback = (u) => LOOPBACK_PAGE.test(u) && /[?&](code|error)=/i.test(u) && /[?&]state=/i.test(u);

/** Open a sign-in page in a new tab of the sign-in browser. Returns its tab id. */
export async function openSignin(url) {
  if (!signinPromise) signinPromise = launchSignin().catch((e) => ((signinPromise = null), Promise.reject(e)));
  const context = await signinPromise;
  const page = await context.newPage();
  const id = `signin-${++signinSeq}`;
  const t = { context, page, console: [], listeners: new Set(), version: 0, signin: true, opened: Date.now(), done: false, start: normalizeUrl(url) };
  tabs.set(id, t);
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    bump(t);
    signinChanged();
  });
  // Any main-frame navigation to a non-local address (even one answered by an instant redirect).
  page.on('request', (rq) => {
    if (rq.isNavigationRequest() && rq.frame() === page.mainFrame() && !LOOPBACK_PAGE.test(rq.url())) t.leftLocal = true;
  });
  page.on('load', () => {
    bump(t);
    const local = LOOPBACK_PAGE.test(page.url());
    if (!local) t.leftLocal = true;
    // Back on a local page after the identity provider: that's the callback, and the waiting
    // process has its answer. (A CLI may also start on its own local page, so only after leaving.)
    else if (!t.done && (t.leftLocal || (isCallback(page.url()) && page.url() !== t.start))) {
      t.done = true;
      signinChanged();
      setTimeout(() => closeSignin(id), 4000);
    }
  });
  page.on('close', () => {
    tabs.delete(id);
    signinChanged();
  });
  signinChanged();
  setTimeout(() => closeSignin(id), 20 * 60_000).unref?.(); // a sign-in nobody finished
  page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  return id;
}

/** Resolves true if the sign-in tab finishes (or closes) within ms, false if it still waits for the user. */
export function signinSettled(id, ms) {
  return new Promise((resolve) => {
    const check = () => {
      const t = tabs.get(id);
      return !t || t.done;
    };
    if (check()) return resolve(true);
    const off = onSigninChange(() => check() && (off(), clearTimeout(timer), resolve(true)));
    const timer = setTimeout(() => (off(), resolve(check())), ms);
  });
}

export function signinList() {
  return [...tabs.entries()]
    .filter(([id]) => isSigninId(id))
    .map(([id, t]) => ({ id, url: t.page.url(), done: t.done, opened: t.opened }));
}

export async function closeSignin(id) {
  const t = tabs.get(id);
  if (!t?.signin) return;
  await t.page.close().catch(() => {});
}

async function tab(sessionId, create = true) {
  let t = tabs.get(sessionId);
  if (t && !t.page.isClosed()) return t;
  if (!create) return null;
  if (isSigninId(sessionId)) throw new Error('This sign-in page was closed');
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  t = { context, page, console: [], listeners: new Set(), version: 0 };
  page.on('console', (m) => {
    t.console.push({ type: m.type(), text: m.text().slice(0, 2000), ts: Date.now() });
    if (t.console.length > 300) t.console.shift();
  });
  page.on('pageerror', (e) => {
    t.console.push({ type: 'pageerror', text: String(e.message || e).slice(0, 2000), ts: Date.now() });
    if (t.console.length > 300) t.console.shift();
  });
  page.on('framenavigated', (f) => f === page.mainFrame() && bump(t));
  page.on('load', () => bump(t));
  // Popups open in the same tab so the panel keeps showing what Claude sees.
  context.on('page', async (p) => {
    if (p === page) return;
    const url = p.url();
    await p.close().catch(() => {});
    if (url && url !== 'about:blank') page.goto(url).catch(() => {});
  });
  tabs.set(sessionId, t);
  return t;
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url is required');
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return (/^[\w-]+(\.[\w-]+)+/.test(u) ? 'https://' : 'http://') + u;
  return u;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// Numbered list of visible interactive elements; the numbers are refs for click/type.
async function annotate(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-cw-ref]').forEach((el) => el.removeAttribute('data-cw-ref'));
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
      n++;
      el.setAttribute('data-cw-ref', String(n));
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || el.getAttribute('href') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      out.push(`[${n}] ${tag}${type ? `(${type})` : ''} ${label}${r.top > innerHeight || r.bottom < 0 ? ' (offscreen)' : ''}`);
      if (n >= 250) break;
    }
    return out;
  });
}

function target(page, a) {
  if (a.ref != null) return page.locator(`[data-cw-ref="${Number(a.ref)}"]`).first();
  if (a.selector) return page.locator(a.selector).first();
  if (a.text) return page.getByText(a.text, { exact: false }).first();
  return null;
}

async function snapshot(page) {
  const elements = await annotate(page).catch(() => []);
  const text = await page
    .evaluate(() => document.body?.innerText || '')
    .catch(() => '');
  return { url: page.url(), title: await page.title().catch(() => ''), text: text.replace(/\n{3,}/g, '\n\n').slice(0, 12_000), elements };
}

// ---- operations used by both the MCP tools and the UI ----
export async function run(sessionId, op, a = {}) {
  const t = await tab(sessionId);
  const { page } = t;
  try {
    switch (op) {
      case 'navigate':
        await page.goto(normalizeUrl(a.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settle(page);
        return snapshot(page);
      case 'back':
        await page.goBack({ timeout: 10_000 }).catch(() => {});
        await settle(page);
        return snapshot(page);
      case 'forward':
        await page.goForward({ timeout: 10_000 }).catch(() => {});
        await settle(page);
        return snapshot(page);
      case 'reload':
        await page.reload({ timeout: 30_000 });
        await settle(page);
        return snapshot(page);
      case 'snapshot':
        return snapshot(page);
      case 'click': {
        if (a.x != null && a.y != null) await page.mouse.click(Number(a.x), Number(a.y));
        else {
          const loc = target(page, a);
          if (!loc) throw new Error('Give ref, selector, text, or x and y');
          await loc.click({ timeout: 10_000 });
        }
        await settle(page);
        return a.quiet ? { ok: true } : snapshot(page);
      }
      case 'type': {
        const loc = target(page, { ref: a.ref, selector: a.selector, text: a.findText });
        if (loc) await loc.fill(String(a.text ?? ''), { timeout: 10_000 });
        else await page.keyboard.type(String(a.text ?? ''));
        if (a.submit) await page.keyboard.press('Enter');
        await settle(page);
        return a.quiet ? { ok: true } : snapshot(page);
      }
      case 'press':
        await page.keyboard.press(String(a.key || 'Enter'));
        await settle(page);
        return a.quiet ? { ok: true } : snapshot(page);
      case 'scroll':
        await page.mouse.wheel(Number(a.dx) || 0, Number(a.dy) || 600);
        await page.waitForTimeout(200);
        return a.quiet ? { ok: true } : snapshot(page);
      case 'evaluate': {
        const v = await page.evaluate(`(async () => { ${/\breturn\b/.test(a.script || '') ? a.script : `return (${a.script})`} })()`);
        return { result: v === undefined ? null : v };
      }
      case 'console': {
        const list = t.console.slice(-(Number(a.limit) || 50));
        if (a.clear) t.console.length = 0;
        return { messages: list };
      }
      case 'resize':
        await page.setViewportSize({ width: Math.max(320, Math.min(2560, Number(a.width) || 1280)), height: Math.max(320, Math.min(2000, Number(a.height) || 800)) });
        return { ok: true };
      case 'wait':
        if (a.text) await page.getByText(a.text).first().waitFor({ timeout: Math.min(Number(a.timeout) || 10, 60) * 1000 });
        else await page.waitForTimeout(Math.min(Number(a.seconds) || 1, 30) * 1000);
        return snapshot(page);
      default:
        throw new Error(`Unknown browser action ${op}`);
    }
  } finally {
    bump(t);
  }
}

export async function screenshot(sessionId, { type = 'png', quality, fullPage = false } = {}) {
  const t = await tab(sessionId);
  return t.page.screenshot({ type, quality: type === 'jpeg' ? quality || 70 : undefined, fullPage, timeout: 15_000 });
}

export async function state(sessionId) {
  const t = await tab(sessionId, false);
  if (!t) return { open: false, available: browserAvailable() };
  const vp = t.page.viewportSize();
  return { open: true, available: true, url: t.page.url(), title: await t.page.title().catch(() => ''), version: t.version, width: vp?.width, height: vp?.height };
}

export function onChange(sessionId, fn) {
  const t = tabs.get(sessionId);
  if (!t) return () => {};
  t.listeners.add(fn);
  return () => t.listeners.delete(fn);
}

export async function closeTab(sessionId) {
  if (isSigninId(sessionId)) return closeSignin(sessionId);
  const t = tabs.get(sessionId);
  tabs.delete(sessionId);
  await t?.context.close().catch(() => {});
}

export async function shutdown() {
  const ctx = await signinPromise?.catch(() => null);
  await ctx?.close().catch(() => {});
}
