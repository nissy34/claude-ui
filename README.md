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
- **Worktrees**: start a chat in an isolated git worktree on its own branch, from the new-chat dialog or a project's ⋯ menu
- Composer with permission mode (Shift+Tab cycles), model, effort, `@` file mentions with autocomplete, slash-command autocomplete, image paste/drag/attach, and Stop (Esc)
- Live task list (TodoWrite) docked above the composer. Sub-agent activity folds into its Task card
- A terminal drawer in every chat (a shell in the same folder)
- Session info: model, MCP servers and their status, context size, usage-limit meters and reset times
- If Claude's login on the server expires, the chat shows a "Log in again" button that opens a terminal for `/login`
- Resume any past Claude Code conversation for a folder from **Past conversations**, or **Continue** the latest one
- Browser notifications when Claude finishes or needs approval while the tab is in the background

**Terminal sessions** run the interactive `claude` TUI (or a plain shell) in a persistent pty, rendered with xterm.js. They include a phone key bar (Esc, Tab, Shift+Tab, arrows, Ctrl, ^C, paste) and a compose box.

**Everywhere:** password login, a live session list across devices, and it works as a home-screen app on iOS and Android.

### Not the same as the desktop app

- Files live on the server. Attachments are images you paste or pick; you can't browse your phone's or laptop's disk from it.
- No native OS integration (computer use, the Chrome extension, system notifications beyond the browser's, dictation).
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
- Node.js 20.6+
- Optional, for Terminal sessions: build tools for `node-pty` (`build-essential` and `python3` on Debian/Ubuntu; Xcode CLT on macOS; see Windows below). If `node-pty` can't build, install still succeeds and chat sessions work.
- Claude Code installed and logged in as the user that will run the server (`npm i -g @anthropic-ai/claude-code`, then run `claude` once)

## Install

```bash
git clone https://github.com/nissy34/claude-ui ~/claude-ui
cd ~/claude-ui
npm install
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
| `CW_TRUST_PROXY` | `0` | `1` behind a reverse proxy / Tailscale Serve |
| `CW_COOKIE_SECURE` | auto | Force the `Secure` cookie flag on/off |
| `CW_SESSION_DAYS` | `30` | Login lifetime |

## Security

- One password, scrypt-hashed if you use `CW_PASSWORD_HASH`; login attempts are rate-limited per IP.
- Auth is an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. WebSocket upgrades check the cookie and the `Origin` header. Change `CW_SECRET` (or delete `~/.claude-web/secret`) to log out every device.
- Sessions can only start inside `CW_PROJECTS_ROOT` unless you set `CW_ALLOW_ANY_DIR=1`.
- The password, hash and secret are stripped from the environment of every process the server starts.
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
