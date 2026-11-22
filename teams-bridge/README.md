# Teams bridge

Talk to your agents from a Microsoft Teams chat. The bridge runs next to Claude UI and only makes **outbound** calls, so it works on a server nobody can reach from outside:

- It polls one Teams chat through Microsoft Graph for what you write (every 5 seconds).
- It long-polls Claude UI's attention feed (`/api/bridge/*`) for what is waiting on you.

```
 Teams chat  ◄── Graph (HTTPS, outbound) ──  teams-bridge  ── /api/bridge ──►  Claude UI
```

## What it does

**Things waiting on you show up in the chat**, each with a short number:

| In Claude UI | In Teams | You reply |
| --- | --- | --- |
| A permission prompt | `#3 · my-chat wants to use Bash: npm test` | `yes`, `always`, or `no` plus a reason |
| AskUserQuestion | The question with numbered options | a number, your own words, one line per question |
| A project decision card | The options, the recommended one marked | a number |
| A plan (ExitPlanMode) | The plan | `yes`, or `no` plus what to change |
| An MCP sign-in link | The link | `done` after you sign in, `no` to cancel |
| A coordinator post, a finished chat started from Teams, `notify_user` | The text | reply to continue that conversation |

Answer by **replying to the message** (swipe it on the phone, or hover and Reply), or by writing `#3 yes`. A bare `yes` or `2` answers the one open request when there is only one. Whichever side answers first wins: answer in the web UI and the Teams message is marked "Answered in the web UI".

MCP sign-in **forms** (usernames, passwords) never go to Teams; fill those in the web UI.

**You can start work:**

| You write | It does |
| --- | --- |
| any text | goes to whoever you last talked to (or `TEAMS_DEFAULT_PROJECT`, or your only project) |
| `/project Claude UI: add a dark mode` | sends it to that project's coordinator |
| `/new my-repo: fix the flaky login test` | starts a new chat in that folder; you get its result when it finishes |
| `/to Claude UI` | plain text now goes to that project (or chat) |
| `/status` | projects, running chats, how many requests wait on you |
| `/waiting` | re-posts everything waiting on you |
| `/stop my-chat` | stops a chat |
| `/folders`, `/help` | |

While you used the web UI in the last 5 minutes (`TEAMS_AWAY_MINUTES`), questions wait there instead of pinging you; they go to Teams once you step away. Coordinator posts and finished chats are only sent while you are away. `notify_user` always goes out.

Agents get one new tool, `notify_user` (built-in `ui` MCP), to tell you something without waiting. To ask and wait they keep using AskUserQuestion, which already reaches Teams.

## Setup

### 1. An app registration (once)

You need an Entra app registration that may read and send your chat messages:

1. Entra admin center > App registrations > New registration. Single tenant.
2. Authentication > Add a platform > **Mobile and desktop applications** > custom redirect URI **`http://localhost`**.
3. Authentication > Advanced settings > **Allow public client flows: Yes**.
4. API permissions > Microsoft Graph > Delegated: **Chat.ReadWrite**, **User.Read** (`offline_access` is added automatically). Grant consent if your tenant needs it.
5. Copy the **Application (client) ID** and **Directory (tenant) ID**.

In the newer Entra screen this is Authentication > **Add Redirect URI** > Mobile and desktop applications > custom URI `http://localhost`. If you can't add `http://localhost`, Microsoft's own `https://login.microsoftonline.com/common/oauth2/nativeclient` works the same way: add that and set `TEAMS_REDIRECT_URI` to it.

No client secret, no public endpoint. Nothing listens on `http://localhost`: after you sign in, the browser lands on an error page there, and you copy that page's address back to the bridge.

### 2. Settings

In `.env` (Docker) or the environment:

```sh
TEAMS_TENANT_ID=<directory id>
TEAMS_CLIENT_ID=<application id>
# TEAMS_DEFAULT_PROJECT=Claude UI
```

The bridge reads Claude UI's token from `~/.claude-web/bridge-token` (created on first start). On another machine, set `CW_BRIDGE_TOKEN` to the same value on both sides and `CLAUDE_UI_URL` on the bridge.

### 3. Run it

Docker (uses the same image as Claude UI):

```sh
docker compose --profile teams up -d --build
```

Without Docker: `node teams-bridge/bridge.mjs` (Node 20+, no dependencies).

The first time, the bridge asks you to sign in, and the web UI says so. Open **Settings > Teams** in Claude UI:

1. Press **Sign in to Microsoft** and sign in with your work account, in any browser where you can (your work computer is fine).
2. The browser ends on `http://localhost/?code=…` with a "can't be reached" error. That's expected.
3. Copy that whole address into the box on the page and press **Finish sign-in**.

The bridge posts "Connected" in your chat with yourself, and you are done. The link and the steps are also in `docker compose logs teams-bridge`, and from a terminal you can run the same steps with:

```sh
docker compose --profile teams run --rm teams-bridge node teams-bridge/bridge.mjs login
```

Device code sign-in (microsoft.com/devicelogin) is often blocked by company policy, so it is off by default. `TEAMS_AUTH=device` uses only it, and `TEAMS_AUTH=auto` tries it first and falls back to the browser.

### Which chat

By default the bridge uses your **chat with yourself** in Teams (`48:notes`). To use another chat, list yours and set `TEAMS_CHAT_ID`:

```sh
docker compose --profile teams run --rm teams-bridge node teams-bridge/bridge.mjs chats
```

In a chat with other people, only your own messages are read.

### Phone notifications (optional)

Messages the bridge posts appear as written by you, so Teams doesn't notify you about them. If you want your phone to ring for questions, add a Teams **Workflows** webhook: in Teams, Workflows > "Post to a chat when a webhook request is received", pick "Chat with Flow bot", copy the URL into `TEAMS_PING_URL`. The bridge then also sends a short ping through it for each request and post (an outbound HTTPS call). Reply in your chat with yourself as usual.

## Staying signed in

The bridge keeps its Microsoft sign-in itself: it refreshes the access token before it runs out, and every refresh rolls the refresh token forward, so it stays signed in as long as it runs. Tokens are kept in `~/.claude-web/teams-bridge/token.json` (mode 600).

If your company has a **sign-in frequency** policy (for example "sign in again every 7 days"), no refresh can get past it. When that happens the web UI tells you, and you sign in again in Settings > Teams.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `TEAMS_TENANT_ID` | `organizations` | Entra tenant id or domain |
| `TEAMS_CLIENT_ID` | (required) | app registration |
| `TEAMS_CHAT_ID` | `48:notes` | the chat to use |
| `TEAMS_AUTH` | `browser` | `browser`, `device` (device code) or `auto` (device code, then browser) |
| `TEAMS_REDIRECT_URI` | `http://localhost` | must match the app registration |
| `TEAMS_DEFAULT_PROJECT` | the only project | who gets plain text before you pick with `/to` |
| `TEAMS_AWAY_MINUTES` | `5` | hold questions while you use the web UI; `0` sends at once |
| `TEAMS_ALLOW_PERMISSIONS` | `1` | `0` = answer questions and decisions only, approve tools in the web UI |
| `TEAMS_POLL_SECONDS` | `5` | how often to read the chat (minimum 2) |
| `TEAMS_PING_URL` | | Workflows webhook for phone notifications |
| `CLAUDE_UI_URL` | `http://127.0.0.1:8787` | |
| `CW_BRIDGE_TOKEN` / `CW_BRIDGE_TOKEN_FILE` | `~/.claude-web/bridge-token` | |
| `TEAMS_DATA_DIR` | `~/.claude-web/teams-bridge` | state and tokens |

On the Claude UI side, `CW_BRIDGE_API=0` turns the feed off.

## Security

- Approving a permission prompt from Teams runs code on your server. Only messages from your own account are read, the bridge API needs its own token, and browsers can't call it. Set `TEAMS_ALLOW_PERMISSIONS=0` to keep tool approvals in the web UI.
- Prompts show the command or file path (trimmed), never file contents. Sign-in forms stay in the web UI.
- Messages go through your Teams tenant like any other chat message.

## Claude UI API (for other companions)

All under `/api/bridge`, `Authorization: Bearer <bridge token>`, requests with an `Origin` header are refused.

- `GET /attention` → `{ seq, items, lastSeen }`: open permission prompts, questions, plans, sign-ins, decisions.
- `GET /events?after=<seq>&wait=<seconds>` → `{ seq, lastSeen, events }`, long-poll. Events: `ask`, `resolved`, `post` (coordinator), `turn` (finished chat started from the bridge), `notify`.
- `POST /answer` `{ id, text?, choice?, behavior?: allow|always|deny|accept|decline, answers? }`.
- `POST /act` `{ action: project_send|new_chat|send|stop|status|folders, ... }`.
- `POST /status` `{ state, message, code?, url? }`: the bridge's own state, shown in Settings > Teams and as a notice in the web UI.
- `GET /signin-reply?wait=<seconds>` → `{ url }`: the address pasted in Settings > Teams, handed over once.

Test: `npm run test:bridge` (fake CLI and a fake Graph server).
