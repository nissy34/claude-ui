# Contributing

Thanks for helping out. Claude Web is a self-hosted web UI for the Claude Code CLI: a Node server (Express + WebSockets) in `server/` and a React front end built with Vite in `web/`.

## Setup

You need Node 20.6 or newer and the `claude` CLI on your `PATH`. Terminal sessions also need the build tools for `node-pty` (see Requirements in the README); without them, install still succeeds and chat sessions work.

```bash
npm install
npm run build                  # builds the front end into dist/
CW_PASSWORD=dev npm start      # serves the app on http://127.0.0.1:8787
```

For front-end work, keep the server running and start Vite alongside it:

```bash
npm run dev                    # Vite on :5173 with hot reload, proxied to :8787
```

To use a `.env` file instead of inline variables, copy `.env.example` to `.env` and run `npm run start:env`. The README's Development section has a map of the main files.

## Testing

There is no automated test suite or linter yet, so `npm test` and `npm run lint` don't exist. Before opening a pull request:

1. Run `npm run build` and make sure it finishes without errors.
2. Start the app with `CW_PASSWORD=dev npm start`, log in, and try the parts you changed in a browser: start a chat, send a message, and check that tool cards, permissions and the session list still behave.
3. If you touched Terminal sessions, `node-pty`, Docker or the built-in browser, check those paths too.

A pull request that adds a real test setup is welcome.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Write the title as what the change does for the user, for example "Make Stop always stop".
- Say in the description what you changed and how you checked it.
- Update the README when you add a setting or change how the app is installed or run.
