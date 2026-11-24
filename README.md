# Claude Web

A self-hosted web UI for [Claude Code](https://code.claude.com) that you run on an always-on machine and open from your laptop or phone. It drives the real `claude` CLI on that machine, so it uses your existing login, `~/.claude` settings, `CLAUDE.md` files, MCP servers, skills and permission rules.

Sessions live on the server. Close the tab, open it on your phone, and the same conversation is there, still running.

## Features

**Chat sessions** (the default) work like the Claude Code desktop app:

- Light and dark themes (follows the system, or pick one), a project-grouped sidebar with search and archive, and a new-chat dialog (Ctrl/Cmd+K; Ctrl/Cmd+B hides the sidebar)
- Streaming replies with Markdown and syntax-highlighted code, with copy buttons on code blocks and messages
- Tool calls as cards: shell commands and output, file reads, searches, and **diffs** for edits and new files. Click a file name to open it in the preview pane
- **Changes panel**: every uncommitted change in the session's folder (git diff, plus new files), per-file diffs, and file previews in tabs
- **Permission prompts** in the chat: Allow, Always allow (Claude's own suggested rule), or Deny with a note. Claude's **questions** show as clickable options, and **plan approval** works in plan mode
- **Edit an earlier message**: the conversation forks from that point and files Claude changed are restored (Claude Code file checkpoints)
- **Child sessions**: ask Claude to "open another session for X" and it starts a parallel chat, nested under the parent in the sidebar. The parent can message it, wait for it and read its result, and you can open and talk to it directly
- **Chats talk to each other**: one `send_to_session` tool works in every direction (parent to child, child to parent via id `parent`, any chat to any chat), and the receiver sees who sent it. Messages are non-blocking by default (updates, results); `wait_for_reply` makes it a blocking question that returns the answer. Messages that arrive while a chat is busy queue up and are delivered together, in order, when its turn ends; the chat shows the queue above the composer
- **Clone from git** in the new-chat dialog: paste a repository address and it is cloned into the projects folder (with progress) and a chat opens in it. Private repositories use the server's own git login (credential helper or SSH key); git never prompts, so a missing login shows an error instead of hanging
- **New chat** works like the desktop app: type the first message, and pick where Claude works with the chip under the box (search, No folder, starred and recent folders and environments, More, New folder, Clone from git, New environment; ⚙ and ☆ on hover)
- **Environments** (Local, like the desktop app's): a named set of folders and environment variables. A chat started in one works in the first folder, gets the other folders added to its workspace (`--add-dir`), and passes the variables to Claude and the commands it runs. Each folder can start on a branch (Current or a picked one) and can run in its own worktree. Stored in `~/.claude-web/environments.json`
- **Worktrees**: tick Worktree under the New chat box (or use a project's ⋯ menu) and the chat gets its own git worktree on a new `claude/…` branch, so chats in the same repo don't edit each other's files and each has its own Changes view. Deleting the chat removes its worktree when it has no uncommitted changes, and its branch when it has no commits
- Composer with permission mode (Shift+Tab cycles), model, effort, `@` file mentions, a slash-command menu, image paste/drag/attach, **any-file attachments** (uploaded to the server and handed to Claude), browser dictation, a context-usage ring with Compact, queued follow-ups, and Stop (Esc)
- Consecutive tool calls fold into one compact row you can expand
- Commit, Commit and push, and Create PR buttons in the Changes panel
- **Settings** (Ctrl/Cmd+,): theme, chat text size, Enter-to-send, notifications, defaults for new chats (model, mode, effort), saved permission rules with remove, MCP servers, plugins, account and version info. Keyboard shortcuts sheet with Ctrl/Cmd+/
- Live task list (TodoWrite) docked above the composer. Sub-agent activity folds into its Task card
- A terminal drawer in every chat (a shell in the same folder), and **Open in Claude's terminal** (chat ⋯ menu) to continue the same conversation in Claude Code's own terminal UI, then **Back to chat**
- **Artifacts**: web pages and dashboards, images, SVG, Markdown, PDFs and CSVs that Claude writes open in the side panel with zoom, reload, download, new tab and full screen. HTML runs sandboxed. The **Artifacts** gallery in the sidebar lists them across all chats
- **Built-in browser**: each chat has a headless Chromium tab on the server. Claude drives it with `browser` tools (open a URL, read the page, click, type, screenshot, console, phone/tablet viewports), so it can start your dev server and test it. The **Browser** panel shows the same tab live, and you can click, type and scroll in it
- **Customize**: add, edit, remove and turn on or off MCP servers (per project), including their usernames and passwords, environment variables, API keys and headers, browse/install/enable/disable/update/uninstall plugins, set plugin options such as usernames and passwords (Configure) and add marketplaces, and create, edit, turn off or delete skills
- Sidebar with Pinned and Projects sections; each chat's ⋯ menu (or right-click) has Mark as unread, Pin, Rename, Archive and Delete, with U/P/R/A/D shortcuts
- Composer **+** menu (upload files, open the browser, skills and commands, connectors and their status, add plugins) and a plan usage-limits popover
- Session info: model, MCP servers and their status, context size, usage-limit meters and reset times
- If Claude's login on the server expires, the chat shows a "Log in again" button that opens a terminal for `/login`
- Resume any past Claude Code conversation for a folder from **Past conversations**, or **Continue** the latest one
- Browser notifications when Claude finishes or needs approval while the tab is in the background

**Terminal sessions** run the interactive `claude` TUI (or a plain shell) in a persistent pty, rendered with xterm.js. They include a phone key bar (Esc, Tab, Shift+Tab, arrows, Ctrl, ^C, paste) and a compose box.

**Everywhere:** password login, a live session list across devices, and it works as a home-screen app on iOS and Android.

### Not the same as the desktop app

- Files live on the server. Attachments are uploaded copies; Claude can't browse your phone's or laptop's disk.
- No native OS integration (computer use, the Chrome extension, system notifications beyond the browser's). Dictation uses the browser's speech recognition where available. The built-in browser runs on the server, not on your laptop or phone.
- claude.ai features outside Claude Code (projects, artifacts, connectors set up on claude.ai) aren't part of the CLI, so they aren't here.
- Cloud sessions and teleport are not supported. Everything runs on your machine.
- The look is inspired by the desktop app but uses its own icons and no Anthropic brand assets.

## How it works

```
 phone / laptop ──HTTPS/WSS──▶  node server  ──stdio──▶  claude (stream-JSON)   one per chat
                                 (this repo)  ──pty────▶  claude TUI / shell      one per terminal
```

- A chat session is one long-lived `claude --input-format stream-json --output-format stream-json` process, with `--permission-prompt-tool stdio` so tool approvals come back to the browser. This is the same protocol the Agent SDK uses.
- Each chat is pinned to a Claude session id (`--session-id`, later `--resume`), so it survives idle shutdowns and server restarts: the next message resumes the conversation.
- Chat events are logged under `~/.claude-web/chats/`, and terminal screens are saved under `~/.claude-web/screens/`, so history shows up after a restart.

> **Billing note.** Chat sessions run Claude Code in headless (print / stream-JSON) mode; terminal sessions run the interactive CLI. Anthropic decides how each mode counts against your plan. Check your plan's usage page if that matters to you, and use Terminal sessions if you want the plain interactive CLI.

## Requirements

- A Linux, macOS or Windows machine that stays on
- Node.js 20.6+ (or only Docker: see [Run it in Docker](#run-it-in-docker))
- Optional, for Terminal sessions: build tools for `node-pty` (`build-essential` and `python3` on Debian/Ubuntu; Xcode CLT on macOS; see Windows below). If `node-pty` can't build, install still succeeds and chat sessions work.
- Claude Code installed and logged in as the user that will run the server (`npm i -g @anthropic-ai/claude-code`, then run `claude` once)

## Install

```bash
git clone https://github.com/nissy34/claude-ui ~/claude-ui
cd ~/claude-ui
npm install
npx playwright-core install chromium   # for the built-in browser (skip if you set CW_BROWSER_PATH or have Chrome/Edge)
npm run build

npm run hash-password -- 'pick a strong password'   # copy the output
cp .env.example .env                               # paste it into CW_PASSWORD_HASH, set CW_PROJECTS_ROOT
npm run start:env                                  # reads .env
```

Open `http://127.0.0.1:8787` on that machine. For other devices, see below.

### Run it as a service (systemd)

```bash
sudo cp deploy/claude-web.service /etc/systemd/system/claude-web@.service
sudo cp .env /etc/claude-web.env && sudo chmod 600 /etc/claude-web.env
sudo systemctl daemon-reload
sudo systemctl enable --now claude-web@$USER
journalctl -u claude-web@$USER -f
```

The unit runs as your user so Claude finds your login and settings. If `node` or `claude` live somewhere unusual (nvm, volta), fix the `PATH=` line in the unit.

### Run it in Docker

Use this when the machine has Docker but no Node (or you can't install software on it). The image contains Node, the UI, the `claude` CLI, git, the GitHub CLI, the `docker` CLI, `uv`/`uvx` for Python MCP servers, terminal support and the built-in browser. The container shares your host's Claude data, so chats started in the UI show up in `claude --resume` on the host and the other way round.

How it lines up with the host:

- `~/.claude` and `~/.claude.json` (login, sessions, settings, skills, MCP config) and `~/.claude-web` are mounted at the **same paths** as on the host. Claude files sessions under the folder path, so your projects folder is mounted at its host path too.
- The server runs as **your user** (uid/gid taken from the owner of `~/.claude`), with `HOME` set to your host home, so every file it writes is yours.

```bash
git clone https://github.com/nissy34/claude-ui ~/claude-ui
cd ~/claude-ui
cp .env.example .env
# In .env: set CW_PROJECTS_ROOT to a full path (e.g. /home/you/projects) if it isn't ~/projects
docker compose build claude-ui
docker run --rm --entrypoint node claude-ui server/hash-password.js 'pick a strong password'
# paste the output into CW_PASSWORD_HASH in .env
scripts/deploy.sh --no-pull
docker compose logs -f
```

It runs as two containers from the same image: `runner` holds the chats' Claude Code processes and terminals, and `claude-ui` is the web server. That split is what lets you update without stopping running chats (below).

In `.env`, also set `CW_PUBLIC_URL=http://<machine>:8787` (the address other computers use), so Settings > Claude Desktop shows that instead of the container id.

Open `http://<machine>:8787`. It listens on all interfaces; change the port mapping in `docker-compose.yml` to `127.0.0.1:8787:8787` to keep it local, or set `CW_PORT` in `.env` for another host port.

- **Before the first start**, `~/.claude`, `~/.claude.json` and `~/.gitconfig` must exist on the host (they do once you've used `claude`; `touch ~/.gitconfig` is enough for the last). Compose stops with an error instead of creating them as empty folders.
- **Git name and email for commits:** set them in Settings > Account > Git identity. They are kept in `~/.claude-web`, so they survive rebuilds, and apply at once to every chat and terminal. Left empty, chats use the `user.name`/`user.email` from your host `~/.gitconfig`, or a default (`$USER <$USER@claude-ui.local>`) when that has none, so commits never fail with "Please tell me who you are". A repository's own git config still wins. The same section has **Credit Claude as co-author** (on by default): every chat adds `Co-Authored-By: Claude <model> <noreply@anthropic.com>` to its commits, naming the chat's model, even behind an AI gateway or when a settings file turns attribution off.
- **Not logged in yet?** Log in from inside the container as yourself: `docker compose exec -u "$(id -u)" claude-ui claude` and run `/login`. The login lands in your host `~/.claude`. A plain `docker compose exec` runs as root, so always pass `-u "$(id -u)"`.
- **Git over SSH:** the compose file has commented options. Forwarding your SSH agent (`${SSH_AUTH_SOCK}:/ssh-agent` plus `SSH_AUTH_SOCK: /ssh-agent`) keeps the keys on the host; mounting `~/.ssh` read-only also works. HTTPS remotes with a token (or `gh auth setup-git` after mounting `~/.config/gh`) need neither.
- **Python MCP servers** started with `uvx` (or `python`, `pip`) work out of the box. uv's cache and the Pythons it downloads live in the `uv-cache` and `uv-data` volumes, so they survive `docker compose up --build`.
- **Playwright in your projects** (tests, scripts, MCP servers) uses its normal browser folder, `~/.cache/ms-playwright`, kept in the `ms-playwright` volume. Each project's Playwright downloads the browser build it needs once (`npx playwright install chromium`) and keeps it through rebuilds. The UI's own built-in browser is a separate Chromium inside the image, passed to the UI as `CW_BROWSER_PATH`, so it doesn't pin the build your projects use.
- **Docker in chats:** the image has the `docker` CLI with `docker compose` and `docker buildx`, and the compose file mounts the host's Docker socket (`/var/run/docker.sock`), so chats can build images and run containers. They run on the host's Docker, next to the Claude UI container, not inside it. Your projects are mounted at their host paths, so bind mounts like `docker run -v "$PWD":/src ...` point at the right folder. A container a chat publishes on a port is reached at the host's address (from inside a chat, `localhost` is the Claude UI container, so use `host.docker.internal`, which the compose file points at the host). Access to the socket is the same as root on the host: to turn it off, delete the `docker.sock` volume in `docker-compose.yml` and set `WITH_DOCKER=0` in `.env` for a smaller image. If your socket lives elsewhere, mount it and set `DOCKER_HOST=unix:///path` in `.env`.
- **Other tools your projects or MCP servers need** (compilers, `make`, a Python or Go toolchain) must be in the image: set `EXTRA_APT_PACKAGES="golang make"` in `.env` and rebuild. MCP servers whose config points at a path under your home need that folder mounted too.
- **Update** with `scripts/deploy.sh`: it pulls, rebuilds and restarts only the web server. Chats keep working through it, mid-turn too (a long Bash command, a permission prompt, background tasks), and the new server picks them up within seconds, with nothing lost. Don't use `docker compose up --build` for updates: it works, but recreating the runner stops every chat. See [Updating without stopping chats](#updating-without-stopping-chats).
- **New Claude Code version:** the CLI doesn't update itself inside the container. `scripts/deploy.sh --runner` rebuilds with the latest version (pin one with `CLAUDE_CODE_VERSION=` in `.env`), waits until no chat is working, then restarts both containers; chats cut off anyway resume by themselves. `WITH_BROWSER=0` builds a smaller image without the built-in browser.
- Same-path sharing assumes a Linux host. Docker Desktop on Windows or macOS runs a Linux VM, so host paths and container paths don't match and sessions won't line up with a native `claude` there.

### Updating without stopping chats

`scripts/deploy.sh` (Docker) updates the web server while chats keep running:

| Command | What restarts | Running chats |
| --- | --- | --- |
| `scripts/deploy.sh` | the web server | keep running, picked up again |
| `scripts/deploy.sh --ref my-branch` | the web server, on that branch | keep running |
| `scripts/deploy.sh --runner` | both (new Claude Code version, runner changes) | waits until none is working; new messages queue meanwhile; cut-off chats resume |

How it works: the `runner` container (`server/runner.js`) owns every chat's Claude Code process and every terminal, spools their output to `~/.claude-web/runner/`, and keeps them going while the web server is away. The web server talks to it over a Unix socket (`CW_RUNNER`); on shutdown each chat notes where it stopped reading, and the next server picks every chat up from there and replays what it missed. The built-in MCP tools (sessions, browser, notes) retry for up to a minute while the server restarts. The built-in browser restarts with the server.

A failed build never touches the running server. If the new server doesn't pass its health check, `deploy.sh` puts the previous image back. Outside Docker you can get the same by running `node server/runner.js` as its own service and setting `CW_RUNNER` to its socket (`~/.claude-web/runner/runner.sock`) for the server; without `CW_RUNNER` chats are child processes of the server, as before, and a restart stops them (they resume by themselves afterwards; `CW_AUTO_RESUME=0` turns that off).

`node server/ctl.js status|drain [--wait]|undrain` (or `docker compose exec claude-ui node server/ctl.js ...`) shows what is working and drains the server by hand.

### Windows

Native Windows works for chat sessions. In PowerShell:

```powershell
git clone https://github.com/nissy34/claude-ui $HOME\claude-ui
cd $HOME\claude-ui
npm install
npm run build
npm run hash-password -- "pick a strong password"
copy .env.example .env      # paste the hash into CW_PASSWORD_HASH, set CW_PROJECTS_ROOT=C:\Users\you\projects
npm run start:env
```

- `claude` must work in the same PowerShell (`claude --version`). Both the npm `claude.cmd` shim and the native `claude.exe` are supported.
- Terminal sessions need `node-pty`, which compiles on install and needs the Visual Studio Build Tools ("Desktop development with C++"). Without them, `npm install` still succeeds and only Terminal and Shell sessions are unavailable. Shell sessions use PowerShell; set `CW_SHELL` to change it.
- To keep it running, use Task Scheduler ("At log on", action `node`, arguments `--env-file=.env server\index.js`, start in the repo folder) or a service wrapper such as NSSM.
- If you already use Claude Code inside WSL2, run the Linux instructions inside WSL instead.

## Reaching it from your phone

The server binds to `127.0.0.1` by default. Don't expose it to the internet over plain HTTP: anyone who gets in can run commands on the machine.

**Tailscale (easiest):** install Tailscale on the server and your phone, then

```bash
tailscale serve --bg 8787
```

and open `https://<machine>.<tailnet>.ts.net` on your phone. You get HTTPS, and only your devices can reach it. Set `CW_TRUST_PROXY=1`.

**Reverse proxy:** Caddy example (automatic HTTPS):

```
claude.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `CW_TRUST_PROXY=1`. WebSockets pass through Caddy without extra config; on nginx add the usual `Upgrade`/`Connection` headers.

Then use "Add to Home Screen" for a full-screen app.

## Projects (coordinator + threads)

A **Project** is one conversation with a coordinator that hands work to parallel **threads**, like Projects in Claude Code. Create one with **＋** next to *Projects* in the sidebar: pick folders and the models for each role.

- **Project chat**: you talk to the coordinator. It answers quick questions itself (it can read the code but has no shell or edit tools) and starts threads for real work. Thread cards and decision cards show up inline, with live status.
- **Threads** are ordinary chats in their own git worktree and branch, started with a brief and the exact words you wrote (cited, not paraphrased). Open one to talk to it directly, answer its permission prompts, or watch it work. A checklist and decision cards sit above its chat.
- **Overview** groups threads by status: Waiting on you, Ready for review, Working, Queued, Landing, Snoozed, Idle, Resolved. Stop, resolve, snooze or fork a thread from its card.
- **Suggested threads**: work you didn't ask for but may want (a missing test, a cleanup) arrives as a card with Start and Dismiss instead of a thread.
- **Notes between threads.** A thread that learns something others could hit (a fix, a gotcha, a reusable helper, a fact, a warning) shares it in one line. The engine hands each note only where it matters: warnings to every open thread, notes naming files to running threads in the same repo whose brief or changed files match, and the rest only to search. Notes arrive at a thread's next wake or, mid-turn, after its next tool call (a PostToolUse HTTP hook); they never start a turn. Your answers to decision cards reach every open thread and memory. Threads resolve with what they learned, search the project before digging (`project_search`), and start with the top search hits and the board in their brief. The coordinator only does judgment: it gets board changes, notes marked for it, and signals (two threads changed the same file, a thread looks stuck, a dependency landed). Context › Activity lists what passed between threads.
- **Side question** (in a thread's bar) forks the thread into a side thread that looks at the same worktree and answers you there, without interrupting the thread or waking the coordinator.
- **Move into a project…** (a regular chat's ⋯ menu) turns an existing chat into a thread of a project, keeping its folder, branch and history.
- **Models per role**: coordinator default Sonnet at low effort, threads Opus at high effort. Change them in the project's Settings; the coordinator can pick a cheaper model per thread for small jobs.

How it works (server/cprojects.js): code, not a model, owns the project. Every input becomes an event in an append-only log (`~/.claude-web/cprojects/<id>/events.jsonl`); a reducer derives statuses; a router decides which session to wake; the engine delivers queued events to an idle session as one labelled envelope per turn and marks it delivered when the CLI echoes it. So:

- Thread results are batched for the coordinator (held 10 s after the last one, at most 60 s, sent at once when no other thread is working). Ten threads finishing together cost one coordinator turn.
- Proactivity (quiet / normal / chatty) changes routing rules, so it is enforced; what you tell the coordinator ("only tell me when something finishes") is saved as a setting.
- Every message carries a trust label stamped by the server (principal = you, relay = another Claude, system = the engine) inside a per-session random marker, so a thread's text can't pose as you. Decision cards for steps that can't be undone can only be answered in the web UI. "Always ask before" rules (project Settings > Advanced) still prompt in Auto mode.
- The coordinator's context is reset to a digest (recent chat, thread table, open cards and promises) past a token threshold; promises it makes ("I'll tell you when both are done") are recorded with `follow_up` and survive the reset.
- Restarts replay the log: queued wakes are delivered, wakes in flight are re-sent unless the transcript shows them, and turns cut off get a "check what was already done" wake. A session woken more than 20 times in 10 minutes pauses the project.
- Project memory (`memory/`, one file per subject, versioned writes, generated MEMORY.md) and a shared library folder are given to every session.

The handoff MCP has project tools too: `projects_list`, `project_status`, `project_send`, `project_thread`, `project_message_thread`, `project_answer_decision`, `project_answer_suggestion`, `project_move_chat`, `project_create`, `project_update`.

Tests: `node scripts/test-projects.mjs` runs the engine end to end against a scripted fake CLI (`scripts/fake-claude.mjs`).

CI (`.github/workflows/ci.yml`) runs on every pull request and push to main, with no Claude login or real CLI: `npm run check` (syntax), `npm run build`, `npm test` (the engine checks above, on Node 22 and 24) and `npm run test:ui` (headless Chrome signs in, opens a chat and sends a message against the fake CLI, on a desktop and a phone viewport; set `CHROMIUM_PATH` to pick the browser locally).

## Claude Desktop handoff

The server is also an MCP server that the Claude Desktop app can use, so the two can hand work to each other. From Desktop you can say "continue this tonight on my machine" (starts a chat here, or leaves the brief in a new chat's message box for you to send later), ask "what did that chat do?", send a chat new instructions, and keep **notes** that every chat here can read and write too (the built-in `notes` tools).

Notes have two scopes:
- **Folder notes** are Claude Code's own memory for that folder (`~/.claude/projects/<repo path>/memory/`, one file per note plus the `MEMORY.md` index). Every Claude Code session in the folder loads the index, so chats here, the terminal and the Desktop app's Code tab on this machine all see them, and listing a folder's notes also shows what Claude remembered by itself. Worktrees share their repo's memory. A user-level `autoMemoryDirectory` setting is respected.
- **Global notes** (preferences, things that span folders) live in `~/.claude-web/notes.json`; chats here get a short list of them in their system prompt.

A chat's notes tools default to its own folder (`scope: "global"` for global notes). From Desktop, pass `folder` (from `list_folders`) for folder notes; leave it out for global notes. Settings > Claude Desktop > Notes lists, adds, edits and deletes both.

Tools Desktop gets: `list_folders` (the old name `list_projects` still works), `list_sessions`, `get_session` (transcript, files edited, commands run, uncommitted changes), `handoff`, `send_message`, `stop_session`, `rename_session`, `archive_session`, `set_session_options` (model, effort, permission mode), `list_notes`, `read_note`, `write_note`, `delete_note`. `get_session` also returns the chat's current task list.

Chats here get the same session control (`stop_session`, `rename_session`, `archive_session` next to `set_session_options`), and an `update_plan` tool that shows a live task list with a progress bar above the message box.

**Set it up** in Settings > Claude Desktop, which shows your token and ready-to-copy snippets.

**Claude Code** (the Desktop app's Code tab, the terminal, IDEs) takes HTTP MCP servers directly:

```bash
claude mcp add --scope user --transport http claude-ui http://192.168.1.20:8787/mcp --header "Authorization: Bearer <token>"
```

or in a project's `.mcp.json`: `{"mcpServers": {"claude-ui": {"type": "http", "url": "http://192.168.1.20:8787/mcp", "headers": {"Authorization": "Bearer <token>"}}}}`.

**The Desktop chat** needs a small local proxy: its config file only starts local (stdio) servers, and custom connectors connect from Anthropic's cloud, which can't reach a LAN address. Pick one:

- **uvx:** runs the open-source [`mcp-proxy`](https://pypi.org/project/mcp-proxy/) package; needs [uv](https://docs.astral.sh/uv/) on the Desktop computer.
- **Node bridge:** download `/mcp/bridge.mjs` (a single dependency-free script; needs Node 18+).

In Claude Desktop: Settings > Developer > Edit Config, add the server to `claude_desktop_config.json`, then quit and reopen Desktop:

```json
{
  "mcpServers": {
    "claude-ui": {
      "command": "uvx",
      "args": ["mcp-proxy", "--transport", "streamablehttp", "-H", "Authorization", "Bearer <token>", "http://192.168.1.20:8787/mcp"]
    }
  }
}
```

or, with the Node bridge:

```json
{
  "mcpServers": {
    "claude-ui": {
      "command": "node",
      "args": ["C:\\Users\\you\\claude-ui-bridge.mjs", "http://192.168.1.20:8787/mcp"],
      "env": { "CLAUDE_UI_TOKEN": "<token from Settings > Claude Desktop>" }
    }
  }
}
```

`npx mcp-remote http://host:8787/mcp --allow-http --header "Authorization:${AUTH}"` (with `AUTH=Bearer <token>` in `env`) should work too (untested).

Desktop on another computer needs the server to listen on your network (`CW_HOST=0.0.0.0`, or your LAN/Tailscale address). The endpoint is MCP Streamable HTTP at `POST /mcp`, authenticated with a bearer token (stored in `~/.claude-web/mcp-token`; make a new one in Settings, or pin it with `CW_MCP_TOKEN`). It refuses browser requests (any `Origin` header) and rate-limits wrong tokens like the login. Chats started from Desktop use "Ask before edits" unless Desktop asks for another mode, so an unattended chat stops at its first permission prompt and waits for you in the UI.

## Teams bridge

Talk to your agents from Microsoft Teams: permission prompts, questions and project decision cards show up in your Teams chat with yourself, and you answer by replying. You can also message a project's coordinator or start a chat in a folder from Teams. It is a separate small service (`teams-bridge/`) that only makes outbound calls (Microsoft Graph polling), so it works on a server with no inbound access. Setup and commands: [teams-bridge/README.md](teams-bridge/README.md).

## Claude OAuth token

Instead of the interactive Claude login on the server, chats can sign in with a long-lived OAuth token. Run `claude setup-token` on any computer where you are signed in to Claude, then paste the token (`sk-ant-oat01-…`) in **Settings > Account > Claude login**, press **Test token**, and pick **Sign in with: OAuth token**. It uses the same subscription, needs no browser on the server and lasts a year.

Every claude process the server starts then gets `CLAUDE_CODE_OAUTH_TOKEN`, and loses what Claude Code would pick over it (API keys, Bedrock/Vertex/Foundry, another base URL, an `apiKeyHelper`), also through `--settings` so `~/.claude/settings.json` can't override it. **Claude login** goes back to the server's own login, even if `.env` or settings.json set a token. The AI gateway below still wins when it is set to **Always** or is standing in as a fallback. The token is kept in `~/.claude-web/claude-token.json` (mode 600) and is never sent back to the browser.

## Company AI gateway

To send Claude's requests through an Anthropic-compatible company gateway with a personal key, open **Settings > Account > AI gateway**, enter the gateway address (usually ending in `/anthropic`) and your key, press **Test connection**, and pick **Use the gateway**:

- **Off**: every chat uses the Claude subscription (the Claude login is never touched).
- **Always**: every chat uses the gateway.
- **As fallback**: chats use the subscription and move to the gateway only while it is out of its usage limit, then come back when the limit resets. The weekly limit is ticked by default, the 5-hour limit is not. **Back to subscription now** ends it early.

Open chats switch with their next message. When the gateway is in use, every claude process the server starts (chats, project threads, terminals, the Assistant, chat titles, model list) gets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and the model picker shows the gateway's models ("From gateway"). The choice is also passed as `--settings` env, which wins over `~/.claude/settings.json` and `.env`, so Bedrock or another gateway configured there can't override it. The key is kept in `~/.claude-web/gateway.json` (mode 600) and is never sent back to the browser.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

| Variable | Default | |
|---|---|---|
| `CW_PASSWORD_HASH` / `CW_PASSWORD` | (required) | Login password; prefer the hash from `npm run hash-password` |
| `CW_PROJECTS_ROOT` | `~/projects` or `~` | Folders directly inside it appear as projects |
| `CW_HOST` / `CW_PORT` | `127.0.0.1` / `8787` | Listen address |
| `CW_DATA_DIR` | `~/.claude-web` | Session list, chat logs, screens, cookie secret |
| `CW_CLAUDE_BIN` | `claude` | Path to the CLI |
| `CW_CLAUDE_ARGS` | | Extra args for every `claude` process |
| `CW_CHAT_IDLE_MINUTES` | `30` | Stop idle chat processes (they resume on the next message); `0` keeps them |
| `CW_UPLOAD_DAYS` | `30` | Delete files and images sent in chats (and pictures tools returned) after this many days; `0` keeps them. Deleting a chat deletes its files right away |
| `CW_ALLOW_ANY_DIR` | `0` | `1` allows sessions outside the projects root |
| `CW_SCRATCH_DIR` | `~/.claude-web/scratch` | Folder that "No folder" chats run in (shared, so Past conversations works there) |
| `CW_AUTO_TITLES` | `1` | Give chats a short title after the first reply, from one quick no-tools call to `CW_TITLE_MODEL` (about $0.001 per chat). A rename always wins; `0` keeps the first line of the first message |
| `CW_TITLE_MODEL` | `haiku` | Model for chat titles |
| `CW_CHILD_SESSIONS` | `1` | `0` turns off the built-in sessions tools (child sessions) |
| `CW_PROMPT_SUGGESTIONS` | `1` | `0` stops asking the CLI for a suggested next message after each turn |
| `CW_DESKTOP_MCP` | `1` | `0` turns off the Claude Desktop handoff server (`/mcp`) and the shared notes tools |
| `CW_PUBLIC_URL` | | Address other computers use to reach the server (e.g. `http://myserver:8787` or your Tailscale URL), used in the Claude Desktop setup snippets. Set it when running in Docker, where the hostname is the container id |
| `CW_MCP_TOKEN` | generated | Fixed bearer token for `/mcp` instead of the generated one |
| `CW_BROWSER` | `1` | `0` turns off the built-in browser |
| `CW_BROWSER_PATH` | | A Chrome/Chromium/Edge binary for the built-in browser. Without it, the Playwright Chromium is used, then an installed Chrome or Edge |
| `CW_TRUST_PROXY` | `0` | `1` behind a reverse proxy / Tailscale Serve |
| `CW_COOKIE_SECURE` | auto | Force the `Secure` cookie flag on/off |
| `CW_SESSION_DAYS` | `30` | Login lifetime |

## Security

- One password, scrypt-hashed if you use `CW_PASSWORD_HASH`; login attempts are rate-limited per IP.
- Auth is an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. WebSocket upgrades check the cookie and the `Origin` header. Change `CW_SECRET` (or delete `~/.claude-web/secret`) to log out every device. Chats started with **No folder** run in `CW_SCRATCH_DIR`.
- Sessions can only start inside `CW_PROJECTS_ROOT` unless you set `CW_ALLOW_ANY_DIR=1`.
- The password, hash and secret are stripped from the environment of every process the server starts.
- The Claude Desktop handoff endpoint (`/mcp`) uses its own bearer token, refuses browser origins, and rate-limits wrong tokens. Anyone with the token can start chats, so treat it like the password.
- Whoever can log in can do anything Claude or a shell can do as your user. Treat the password like an SSH key.

## Development

```bash
npm install
CW_PASSWORD=dev npm start      # API + websocket on :8787
npm run dev                    # Vite on :5173 with hot reload, proxied to :8787
```

Layout:

```
server/index.js       HTTP API, auth, websocket routing, static files
server/chat.js        chat sessions: claude stream-JSON process, events, permissions, edit/rewind
server/mcp-sessions.js  stdio MCP server that gives each chat the child-session tools
server/git.js         changes (git diff), file search and preview, worktrees
server/sessions.js    session store + terminal (pty) sessions
web/src/chat/         chat UI (messages, tool cards, diffs, permissions, composer)
web/src/              app shell, sidebar, login, terminal view
deploy/               systemd unit
```
