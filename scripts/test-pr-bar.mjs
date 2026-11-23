#!/usr/bin/env node
// The checklist and PR bar pinned above the composer, with the fake CLI and fake gh.
// A project thread and a regular chat each link to a PR on another branch (the folder's own branch
// has no PR), so the bar shows the linked PR; its CI dropdown lists the checks.
// Run: node scripts/test-pr-bar.mjs   (SHOTS=<dir> also saves screenshots; CHROMIUM_PATH picks the browser)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(here, "..", "dist", "index.html"))) {
  console.error("dist/ is missing: run `npm run build` first");
  process.exit(1);
}
const { chromium } = await import("playwright-core");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cw-prbar-"));
const port = 20000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const repo = path.join(tmp, "projects", "streamer");
fs.mkdirSync(repo, { recursive: true });
const git = (...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd: repo,
  });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "# streamer\n");
git("add", ".");
git("commit", "-qm", "init");
git(
  "remote",
  "add",
  "origin",
  "https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer.git",
);
const PR =
  "https://github-chf01.example.com/hyperscale/hyperscale-ui-streamer/pull/1494";

const env = {
  ...process.env,
  CW_PORT: String(port),
  CW_PASSWORD: "pw",
  CW_DATA_DIR: path.join(tmp, "data"),
  CW_PROJECTS_ROOT: path.join(tmp, "projects"),
  CW_CLAUDE_BIN: path.join(here, "fake-claude.mjs"),
  CW_GH_BIN: path.join(here, "fake-gh.mjs"),
  FAKE_GH_MODE: "none",
  CW_BROWSER: "0",
  CW_AUTO_TITLES: "0",
  CW_PROJECT_BATCH_QUIET_MS: "300",
  CW_PROJECT_BATCH_MAX_MS: "1500",
  CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
};
for (const k of [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
])
  delete env[k];

let failures = 0;
const check = (cond, msg, extra) => {
  if (!cond) failures++;
  console.log(
    `  ${cond ? "ok  " : "FAIL"} ${msg}`,
    !cond && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "",
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";
async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${j.error || res.status}`);
  return j;
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const call = (tool, input) =>
  `@@call project__${tool} ${JSON.stringify(input)}`;

const server = spawn(
  process.execPath,
  [path.join(here, "..", "server", "index.js")],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
server.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
server.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(d));
let browser;
try {
  await until(() => fetch(base + "/api/me").then(() => true), 15_000, "server");
  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  cookie = res.headers.get("set-cookie").split(";")[0];

  console.log("A thread that pushes to a PR on another branch");
  const steps = [
    { step: "Read the review comments on #1494", status: "completed" },
    { step: "Fix the Pods query", status: "completed" },
    { step: "Push to the PR branch", status: "in_progress" },
    { step: "Reply to the reviewer", status: "pending" },
  ];
  const brief = [
    call("update_checklist", { title: "Address review on #1494", steps }),
    call("post_message", {
      kind: "progress",
      text: `Pushed the fix to ${PR}.`,
    }),
    "@@sleep 300",
  ].join("\n");
  const { project } = await api("/api/cprojects", {
    method: "POST",
    body: {
      name: "Streamer",
      folders: [repo],
      prompt: `review it\n${call("start_thread", { title: "Address review comments", brief, new: true })}\n${call("post_message", { text: "on it" })}`,
    },
  });
  const t = await until(
    async () =>
      (await api(`/api/cprojects/${project.id}`)).project.threads.find(
        (x) => x.pr?.number === 1494,
      ),
    30_000,
    "thread PR",
  );
  check(
    t.pr.linked && t.pr.head === "multisession",
    "the thread shows the PR it linked to (its own branch has none)",
    t.pr,
  );
  check(t.checklist?.steps?.length === 4, "the thread has its checklist");

  console.log("A regular chat that linked a PR");
  const { session } = await api("/api/sessions", {
    method: "POST",
    body: { cwd: repo, kind: "chat" },
  });

  const exe =
    process.env.CHROMIUM_PATH ||
    (fs.existsSync("/opt/pw-browsers/chromium")
      ? "/opt/pw-browsers/chromium"
      : undefined);
  browser = await chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox"],
  });
  const shots = process.env.SHOTS;
  for (const [label, vp, scheme] of [
    ["desktop-light", { width: 1400, height: 860 }, "light"],
    ["desktop-dark", { width: 1400, height: 860 }, "dark"],
    ["phone", { width: 390, height: 844 }, "light"],
  ]) {
    const ctx = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: shots ? 2 : 1,
      colorScheme: scheme,
      isMobile: label === "phone",
      hasTouch: label === "phone",
    });
    await ctx.addCookies([
      {
        name: cookie.split("=")[0],
        value: cookie.split("=").slice(1).join("="),
        url: base,
      },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${base}/#p=${project.id}&t=${t.id}`);
    const bar = page.locator(".pjp-dock .prbar");
    await bar.waitFor({ timeout: 15_000 });
    check(
      (await bar.innerText()).includes("#1494") &&
        (await bar.innerText()).includes("multisession") &&
        (await bar.innerText()).includes("+1"),
      `${label}: thread PR bar shows number, branch and size`,
    );
    const cl = page.locator(".pjp-dock .pjp-cl.pinned");
    check(
      (await cl.count()) === 1 &&
        (await page.locator(".pjp-thread .pjp-cl").count()) === 0,
      `${label}: checklist is pinned above the composer, not in the feed`,
    );
    if (shots)
      await page.screenshot({ path: path.join(shots, `thread-${label}.png`) });
    await bar.locator(".prbar-ci").click();
    await page.locator(".prbar-checks li").first().waitFor({ timeout: 10_000 });
    check(
      (await page.locator(".prbar-checks li").count()) === 2,
      `${label}: CI dropdown lists the checks`,
    );
    if (shots)
      await page.screenshot({
        path: path.join(shots, `thread-ci-${label}.png`),
      });
    await page.keyboard.press("Escape");
    await cl.locator(".pjp-cl-head").click();
    check(
      (await page.locator(".pjp-dock .pjp-cl-step").count()) === 0,
      `${label}: checklist folds to one line`,
    );
    if (shots && label === "desktop-light")
      await page.screenshot({ path: path.join(shots, `thread-folded.png`) });

    if (label === "desktop-light") {
      await page.goto(`${base}/#s=${session.id}`);
      const ta = page
        .locator(".composer textarea, .composer [contenteditable]")
        .first();
      await ta.waitFor({ timeout: 10_000 });
      await ta.click();
      await page.keyboard.type(`@@say Opened ${PR}`);
      await page.keyboard.press("Enter");
      const cbar = page.locator(".chat-prbar .prbar");
      await cbar.waitFor({ timeout: 20_000 });
      check(
        (await cbar.innerText()).includes("#1494"),
        "chat: PR bar shows the PR the chat linked to",
      );
      await cbar.locator(".prbar-x").click();
      check(
        (await page.locator(".chat-prbar .prbar").count()) === 0,
        "chat: × hides the bar",
      );
      await page.evaluate(() => localStorage.removeItem("prbar-dismissed"));
      await page.reload();
      await page.locator(".chat-prbar .prbar").waitFor({ timeout: 20_000 });
      if (shots)
        await page.screenshot({
          path: path.join(shots, `chat-desktop-light.png`),
        });
    }
    await ctx.close();
  }
} catch (e) {
  failures++;
  console.log("  FAIL", e.message);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
