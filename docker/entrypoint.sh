#!/bin/sh
# Runs the server as your host user, with your host home path, so the CLI reads
# and writes the same ~/.claude (sessions, login, settings) as Claude on the host.
set -e

# Image defaults (browser on/off) unless already set in the environment.
while IFS='=' read -r k v; do
  [ -n "$k" ] && [ -z "$(printenv "$k")" ] && export "$k=$v"
done < /etc/claude-ui.env

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

: "${HOME:?HOME must be set to your home folder path on the host}"
mkdir -p "$HOME"

# Your uid/gid: PUID/PGID if set, otherwise the owner of the mounted ~/.claude.
uid=${PUID:-$(stat -c %u "$HOME/.claude" 2>/dev/null || echo 1000)}
gid=${PGID:-$(stat -c %g "$HOME/.claude" 2>/dev/null || echo "$uid")}

if [ "$uid" = 0 ]; then
  exec "$@"
fi

name=${USER:-claude}
getent group "$gid" >/dev/null || echo "$name:x:$gid:" >> /etc/group
if ! getent passwd "$uid" >/dev/null; then
  echo "$name:x:$uid:$gid::$HOME:/bin/bash" >> /etc/passwd
fi

# Docker creates the parent folders of bind mounts (and missing mount sources)
# as root. Hand those to you; anything already yours is left alone.
find "$HOME" -maxdepth 3 -xdev -type d -user 0 -exec chown "$uid:$gid" {} + 2>/dev/null || true

# Run as you. Keep the env (HOME, CW_*), drop root's groups.
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
