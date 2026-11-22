# Teams bridge

Talk to your agents from a Microsoft Teams chat. The bridge runs next to Claude UI and only makes **outbound** calls, so it works on a server nobody can reach from outside:

- It polls one Teams chat through Microsoft Graph for what you write (every 5 seconds).
- It long-polls Claude UI's attention feed (`/api/bridge/*`) for what is waiting on you.

```
 Teams chat  ◄── Graph (HTTPS, outbound) ──  teams-bridge  ── /api/bridge ──►  Claude UI
```

## What it does

**Things waiting on you show up in the chat as cards** (Adaptive Cards: a title, the command or options laid out, an "Open in web UI" link when `CW_PUBLIC_URL` or `TEAMS_UI_LINK` is set). These cards are read-only, so you answer by replying. For tappable buttons, add the optional workflow (see Buttons). If your tenant doesn't let users post cards, the bridge falls back to formatted text by itself (`TEAMS_CARDS=0` forces text).

| In Claude UI | In Teams | You reply |
| --- | --- | --- |
| A permission prompt | `my-chat wants to use Bash: npm test` | `yes`, `always`, or `no` plus a reason |
| AskUserQuestion | The question with numbered options | a number, your own words, one line per question |
| A project decision card | The options, the recommended one marked | a number |
| A plan (ExitPlanMode) | The plan | `yes`, or `no` plus what to change |
| An MCP sign-in link | The link | `done` after you sign in, `no` to cancel |
| A coordinator post, a finished chat started from Teams, `notify_user` | The text | reply to continue that conversation |

Answer by **replying to the message** (swipe it on the phone, or hover and Reply). Your message gets 👀 while it's being worked on, and ✅ once the answer is back. A bare `yes` or `2` answers the one open request when there is only one. Whichever side answers first wins: answer in the web UI and the Teams message is marked "Answered in the web UI".

MCP sign-in **forms** (usernames, passwords) never go to Teams; fill those in the web UI.

**Just write what you want.** Plain messages go to the **Assistant**, a chat in Claude UI on Haiku that acts as your chief of staff. It sees what's waiting on you, your projects and your chats, and turns "tell the Claude UI project to add dark mode", "yes to the npm one" or "what's everyone doing?" into the right action, then answers in a sentence or two. It only answers a request when your words clearly say what to answer; otherwise it asks back. The Assistant is pinned in the web UI's sidebar, so you can read the whole conversation there and talk to it from the UI too. Replying to one of its messages continues with it; replying to a request with more than yes/no also goes to it, with that request as context.

`TEAMS_ASSISTANT=0` turns it off (plain text then goes to whoever you last talked to). On the server, `CW_ASSISTANT_MODEL` picks the model (default `haiku`) and `CW_ASSISTANT_APPROVE=0` stops it from approving tools (it can still answer questions and decisions).

**Commands work without the Assistant:**

| You write | It does |
| --- | --- |
| any text | goes to the Assistant (with `TEAMS_ASSISTANT=0`: to whoever you last talked to, `TEAMS_DEFAULT_PROJECT`, or your only project) |
| `/project Claude UI: add a dark mode` | sends it to that project's coordinator |
| `/new my-repo: fix the flaky login test` | starts a new chat in that folder; you get its result when it finishes |
| `/to Claude UI` | plain text now goes to that project (or chat) |
| `/status` | projects, running chats, how many requests wait on you |
| `/waiting` | re-posts everything waiting on you |
| `/stop my-chat` | stops a chat |
| `/folders`, `/help` | |

While you used the web UI in the last 5 minutes (`TEAMS_AWAY_MINUTES`), questions wait there instead of pinging you; they go to Teams once you step away. Coordinator posts and finished chats are only sent while you are away. `notify_user` always goes out.

Agents (other chats) get one new tool, `notify_user` (built-in `ui` MCP), to tell you something without waiting. To ask and wait they keep using AskUserQuestion, which already reaches Teams.

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

Messages the bridge posts appear as written by you, so Teams doesn't notify you about them. If you want your phone to ring for questions, add a Teams **Workflows** webhook: in Teams, Workflows > "Post to a chat when a webhook request is received", pick "Chat with Flow bot", copy the URL into `TEAMS_PING_URL`. The bridge then also sends a short ping through it for each request and post (an outbound HTTPS call), with an **Open in Teams** button that jumps to the post to answer. Reply in your chat with yourself as usual.

### Threads (channel mode, optional)

One chat gets crowded when several things run at once. In channel mode the bridge uses a Teams channel instead, and each project or chat gets its own thread there, holding its questions, updates and result:

- A reply in a thread goes to that thread's project or chat. A one-word `yes`, `no` or number answers the request waiting in that thread.
- A new post goes to the Assistant, and its answer comes back as a reply under your post. Commands work as new posts too. `/new folder: task` makes that post the new chat's thread.

You need the delegated permissions **ChannelMessage.Send**, **ChannelMessage.Read.All** (admin consent), **Team.ReadBasic.All** and **Channel.ReadBasic.All** on the app registration. Then set the channel by name:

```sh
TEAMS_CHANNEL="My team / Claude"
```

`bridge.mjs channels` lists the names. Everyone in the channel sees the posts, so use a team or private channel that only you are in. Only your own messages are read. If your tenant asks for a new sign-in after you add the permissions, Settings > Teams shows it. Threads are named after the project or the chat's title. Adding **ChannelMessage.ReadWrite** (admin consent) also lets the bridge rename a thread when the chat gets its proper title, and mark answered requests on the card itself. Without it, names stay as they started, and an answered request gets a short "✓ Answered" reply in its thread instead.

### Buttons (optional, a Teams workflow)

Cards the bridge posts itself can't have working buttons (that needs a registered bot). A Power Automate workflow can: the bridge sends each request to the workflow (an outbound HTTPS call), the workflow shows it as a card with buttons in your chat with the Workflows bot and waits, then posts what you tapped back into that chat, where the bridge reads it. The buttons come from the request: Yes / Always / No and a reason box for tool approvals, the options and a text box for questions, one button per option for decisions, Sign in / Done / Cancel for sign-ins. Because the Workflows bot posts the card, your phone also rings.

Make the workflow once, at make.powerautomate.com > Create > Instant cloud flow > skip:

1. Trigger **When a Teams webhook request is received** (Microsoft Teams). Who can trigger: **Anyone** (the URL is the secret).
2. Action **Post card in a chat or channel and wait for a response** (in some languages: "Post adaptive card and wait for a response"):
   - Post as **Flow bot**, Post in **Chat with Flow bot**, Recipient: you.
   - Message: an expression, `string(triggerBody()?['attachments']?[0]?['content'])`.
   - Update message: `✓ Sent`. Should update card: **Yes**.
3. Action **Post message in a chat or channel**:
   - Post as **Flow bot**, Post in **Chat with Flow bot**, Recipient: you.
   - Message: an expression, `concat('cw:', string(body('Post_card_in_a_chat_or_channel_and_wait_for_a_response')?['data']))`. Use your step 2 action's name, with spaces as underscores (often `Post_adaptive_card_and_wait_for_a_response`).
4. Save, then copy the trigger's URL into `TEAMS_FLOW_URL`.

The bridge finds the chat with the Workflows bot by itself after the first card. If it doesn't, list your chats (`bridge.mjs chats`) and set `TEAMS_FLOW_CHAT_ID`. Each card carries a random secret, and only answers that echo it back count. Requests still appear in your own chat too, where replying keeps working. With `TEAMS_FLOW_URL` set, `TEAMS_PING_URL` isn't needed for requests.

If a request is answered somewhere else first, its workflow card keeps its buttons. Tapping one then just says it was already answered.

## Staying signed in

The bridge keeps its Microsoft sign-in itself: it refreshes the access token before it runs out, and every refresh rolls the refresh token forward, so it stays signed in as long as it runs. Tokens are kept in `~/.claude-web/teams-bridge/token.json` (mode 600).

If your company has a **sign-in frequency** policy (for example "sign in again every 7 days"), no refresh can get past it. When that happens the web UI tells you, and you sign in again in Settings > Teams.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `TEAMS_TENANT_ID` | `organizations` | Entra tenant id or domain |
| `TEAMS_CLIENT_ID` | (required) | app registration |
| `TEAMS_CHAT_ID` | `48:notes` | the chat to use |
| `TEAMS_CHANNEL` | | channel mode: `Team / Channel`, one thread per project or chat (or `TEAMS_TEAM_ID` + `TEAMS_CHANNEL_ID`) |
| `TEAMS_AUTH` | `browser` | `browser`, `device` (device code) or `auto` (device code, then browser) |
| `TEAMS_REDIRECT_URI` | `http://localhost` | must match the app registration |
| `TEAMS_CARDS` | `1` | post requests and updates as Adaptive Cards; `0` = formatted text |
| `TEAMS_UI_LINK` | `CW_PUBLIC_URL` | web UI address for the cards' links, e.g. `http://bamba:8787` |
| `TEAMS_ASSISTANT` | `1` | plain text goes to the Assistant; `0` = to the last target |
| `TEAMS_DEFAULT_PROJECT` | the only project | with the Assistant off: who gets plain text before you pick with `/to` |
| `TEAMS_AWAY_MINUTES` | `5` | hold questions while you use the web UI; `0` sends at once |
| `TEAMS_ALLOW_PERMISSIONS` | `1` | `0` = answer questions and decisions only, approve tools in the web UI |
| `TEAMS_POLL_SECONDS` | `5` | how often to read the chat (minimum 2) |
| `TEAMS_PING_URL` | | Workflows webhook for phone notifications |
| `TEAMS_FLOW_URL` | | workflow webhook for cards with buttons (see Buttons) |
| `TEAMS_FLOW_CHAT_ID` | found by itself | your chat with the Workflows bot |
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
