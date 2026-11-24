#!/usr/bin/env bash
# Update Claude UI running in Docker (docker-compose.yml) without stopping running chats.
#
#   scripts/deploy.sh             pull, rebuild and restart the web server. Chats and terminals keep
#                                 running in the runner container and are picked up again.
#   scripts/deploy.sh --runner    also restart the runner (a new Claude Code version, or a change to
#                                 server/runner.js). Waits until no chat is working, then restarts
#                                 both; chats cut off anyway resume by themselves.
#
# Options:
#   --ref <branch>    deploy this branch (fetched from origin) instead of the current one
#   --no-pull         build what is checked out
#   --force           with --runner: restart without waiting for chats to finish
#   --timeout <min>   with --runner: give up waiting after this long (default 720)
#   --no-rollback     keep a new server that fails its health check
#
# The first run on an older single-container setup restarts everything once.
set -euo pipefail
cd "$(dirname "$0")/.."

ref="" pull=1 runner=0 force=0 timeout=720 rollback=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift ;;
    --no-pull) pull=0 ;;
    --runner) runner=1 ;;
    --force) force=1 ;;
    --timeout) timeout="$2"; shift ;;
    --no-rollback) rollback=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
dc() { docker compose "$@"; }
running() { [ -n "$(dc ps -q --status running "$1" 2>/dev/null)" ]; }

before=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
if [ "$pull" = 1 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "This checkout has uncommitted changes; commit or stash them, or use --no-pull." >&2
    exit 1
  fi
  current=$(git rev-parse --abbrev-ref HEAD)
  if [ -n "$ref" ] && [ "$ref" != "$current" ]; then
    say "Switching to $ref"
    git fetch --quiet origin "$ref"
    git checkout --quiet "$ref" 2>/dev/null || git checkout --quiet -b "$ref" --track "origin/$ref"
  fi
  say "Pulling $(git rev-parse --abbrev-ref HEAD)"
  git pull --ff-only --quiet
fi
export GIT_COMMIT
GIT_COMMIT=$(git rev-parse --short HEAD)
say "Deploying $before -> $GIT_COMMIT"

# Keep the running image for a rollback.
if docker image inspect claude-ui >/dev/null 2>&1; then docker tag claude-ui claude-ui:previous; fi

say "Building the web server"
dc build claude-ui

health() {
  # Asked from inside the web server's container, so it doesn't depend on the published port.
  for _ in $(seq 1 30); do
    got=$(dc exec -T claude-ui node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(j=>console.log(j.commit||'up')).catch(()=>process.exit(1))" 2>/dev/null || true)
    if [ -n "$got" ]; then echo "$got"; return 0; fi
    sleep 2
  done
  return 1
}

first=0
if ! docker image inspect claude-ui-runner >/dev/null 2>&1 || [ -z "$(dc ps -aq runner 2>/dev/null)" ]; then first=1; fi

if [ "$first" = 1 ]; then
  say "First start of the runner (this restarts anything already running once)"
  docker tag claude-ui claude-ui-runner
  # An older single container holds the port the runner publishes now.
  dc rm -sf claude-ui >/dev/null 2>&1 || true
  dc up -d runner claude-ui
elif [ "$runner" = 1 ]; then
  if running claude-ui && [ "$force" = 0 ]; then
    say "Waiting for chats to finish (new messages wait in their queues meanwhile)"
    if ! dc exec -T claude-ui node server/ctl.js drain --wait --timeout "$timeout" --reason "runner upgrade"; then
      echo "Chats are still working. The server keeps draining; run with --force, or: docker compose exec claude-ui node server/ctl.js undrain" >&2
      exit 2
    fi
  fi
  say "Restarting the runner and the web server"
  docker tag claude-ui claude-ui-runner
  dc up -d --force-recreate runner claude-ui
else
  running runner || dc up -d runner
  say "Restarting the web server (chats keep running)"
  dc up -d --no-deps claude-ui
fi

if got=$(health); then
  say "Up: $got"
  exit 0
fi
echo "The new web server did not answer its health check." >&2
if [ "$rollback" = 1 ] && docker image inspect claude-ui:previous >/dev/null 2>&1; then
  say "Rolling back to the previous image ($before)"
  docker tag claude-ui:previous claude-ui
  dc up -d --no-deps claude-ui
  health >/dev/null && say "Rolled back" || echo "The previous image did not come up either: docker compose logs claude-ui" >&2
fi
exit 3
