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
- **Worktrees**: start a chat in an isolated git worktree on its own branch, from the new-chat dialog or a project's ⋯ menu
- Composer with permission mode (Shift+Tab cycles), model, effort, `@` file mentions, a slash-command menu, image paste/drag/attach, **any-file attachments** (uploaded to the server and handed to Claude), browser dictation, a context-usage ring with Compact, queued follow-ups, and Stop (Esc)
- Consecutive tool calls fold into one compact row you can expand
- Commit, Commit and push, and Create PR buttons in the Changes panel
- **Settings** (Ctrl/Cmd+,): theme, chat text size, Enter-to-send, notifications, defaults for new chats (model, mode, effort), saved permission rules with remove, MCP servers, plugins, account and version info. Keyboard shortcuts sheet with Ctrl/Cmd+/
- Live task list (TodoWrite) docked above the composer. Sub-agent activity folds into its Task card
- A terminal drawer in every chat (a shell in the same folder), and **Open in Claude's terminal** (chat ⋯ menu) to continue the same conversation in Claude Code's own terminal UI, then **Back to chat**
- **Artifacts**: web pages and dashboards, images, SVG, Markdown, PDFs and CSVs that Claude writes open in the side panel with zoom, reload, download, new tab and full screen. HTML runs sandboxed. The **Artifacts** gallery in the sidebar lists them across all chats
- **Built-in browser**: each chat has a headless Chromium tab on the server. Claude drives it with `browser` tools (open a URL, read the page, click, type, screenshot, console, phone/tablet viewports), so it can start your dev server and test it. The **Browser** panel shows the same tab live, and you can click, type and scroll in it
- **Customize**: add, remove and turn on or off MCP servers (per project), browse/install/enable/disable/update/uninstall plugins and add marketplaces, and create, edit, turn off or delete skills
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

Use this when the machine has Docker but no Node (or you can't install software on it). The image contains Node, the UI, the `claude` CLI, git, the GitHub CLI, `uv`/`uvx` for Python MCP servers, terminal support and the built-in browser. The container shares your host's Claude data, so chats started in the UI show up in `claude --resume` on the host and the other way round.

How it lines up with the host:

- `~/.claude` and `~/.claude.json` (login, sessions, settings, skills, MCP config) and `~/.claude-web` are mounted at the **same paths** as on the host. Claude files sessions under the folder path, so your projects folder is mounted at its host path too.
- The server runs as **your user** (uid/gid taken from the owner of `~/.claude`), with `HOME` set to your host home, so every file it writes is yours.

```bash
git clone https://github.com/nissy34/claude-ui ~/claude-ui
cd ~/claude-ui
cp .env.example .env
# In .env: set CW_PROJECTS_ROOT to a full path (e.g. /home/you/projects) if it isn't ~/projects
docker compose build
docker compose run --rm --no-deps claude-ui node server/hash-password.js 'pick a strong password'
# paste the output into CW_PASSWORD_HASH in .env
docker compose up -d
docker compose logs -f
```

In `.env`, also set `CW_PUBLIC_URL=http://<machine>:8787` (the address other computers use), so Settings > Claude Desktop shows that instead of the container id.

Open `http://<machine>:8787`. It listens on all interfaces; change the port mapping in `docker-compose.yml` to `127.0.0.1:8787:8787` to keep it local, or set `CW_PORT` in `.env` for another host port.

- **Before the first start**, `~/.claude`, `~/.claude.json` and `~/.gitconfig` must exist on the host (they do once you've used `claude` and set `git config --global user.name`). Compose stops with an error instead of creating them as empty folders.
- **Not logged in yet?** Log in from inside the container as yourself: `docker compose exec -u "$(id -u)" claude-ui claude` and run `/login`. The login lands in your host `~/.claude`. A plain `docker compose exec` runs as root, so always pass `-u "$(id -u)"`.
- **Git over SSH:** the compose file has commented options. Forwarding your SSH agent (`${SSH_AUTH_SOCK}:/ssh-agent` plus `SSH_AUTH_SOCK: /ssh-agent`) keeps the keys on the host; mounting `~/.ssh` read-only also works. HTTPS remotes with a token (or `gh auth setup-git` after mounting `~/.config/gh`) need neither.
- **Python MCP servers** started with `uvx` (or `python`, `pip`) work out of the box. uv's cache and the Pythons it downloads live in the `uv-cache` and `uv-data` volumes, so they survive `docker compose up --build`.
- **Other tools your projects or MCP servers need** (compilers, `make`, a Python or Go toolchain) must be in the image: set `EXTRA_APT_PACKAGES="golang make"` in `.env` and rebuild. MCP servers whose config points at a path under your home need that folder mounted too.
- **Update** with `git pull && docker compose up -d --build`. The CLI doesn't update itself inside the container; the rebuild picks up the latest version (pin one with `CLAUDE_CODE_VERSION=` in `.env`). `WITH_BROWSER=0` builds a smaller image without the built-in browser.
- Same-path sharing assumes a Linux host. Docker Desktop on Windows or macOS runs a Linux VM, so host paths and container paths don't match and sessions won't line up with a native `claude` there.

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

## Claude Desktop handoff

The server is also an MCP server that the Claude Desktop app can use, so the two can hand work to each other. From Desktop you can say "continue this tonight on my machine" (starts a chat here, or leaves the brief in a new chat's message box for you to send later), ask "what did that chat do?", send a chat new instructions, and keep **shared notes** that every chat here can read and write too (the built-in `notes` tools).

Tools Desktop gets: `list_projects`, `list_sessions`, `get_session` (transcript, files edited, commands run, uncommitted changes), `handoff`, `send_message`, `list_notes`, `read_note`, `write_note`, `delete_note`.

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
| `CW_ALLOW_ANY_DIR` | `0` | `1` allows sessions outside the projects root |
| `CW_CHILD_SESSIONS` | `1` | `0` turns off the built-in sessions tools (child sessions) |
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
- Auth is an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. WebSocket upgrades check the cookie and the `Origin` header. Change `CW_SECRET` (or delete `~/.claude-web/secret`) to log out every device.
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
