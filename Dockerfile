# Claude UI plus the Claude Code CLI in one image, so the host only needs Docker.
# See "Run it in Docker" in README.md: docker-compose.yml shares your host's
# Claude data (sessions, login, settings) with the container.

FROM node:22-bookworm-slim AS node

# Layers are ordered so a code change only redoes the last steps: everything
# that depends on package-lock.json (npm installs, the built-in browser) comes
# before the app's source is copied in. Keep it that way when adding steps.

FROM ubuntu:24.04 AS toolchain
COPY --from=node /usr/local/ /usr/local/
# Build tools for node-pty (Terminal and Shell sessions).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./

# Runtime dependencies only. Rebuilt only when package*.json change.
FROM toolchain AS deps
RUN npm ci --omit=dev --no-audit --no-fund

# The web app, built with the dev dependencies (vite etc.).
FROM toolchain AS build
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build

FROM ubuntu:24.04
# Pin a version (e.g. 2.1.0) for reproducible builds; rebuild to update.
ARG CLAUDE_CODE_VERSION=latest
# 0 = leave out the built-in browser (Chromium, about 400 MB).
ARG WITH_BROWSER=1
# 0 = leave out the docker CLI (chats run docker through the host's socket).
ARG WITH_DOCKER=1
# Anything else your projects or MCP servers need, e.g. "golang make jq".
ARG EXTRA_APT_PACKAGES=""

COPY --from=node /usr/local/ /usr/local/

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client gh ripgrep less procps jq \
      python3 python3-venv python3-pip python-is-python3 tini util-linux locales libatomic1 $EXTRA_APT_PACKAGES; \
    rm -rf /var/lib/apt/lists/*; \
    # The image's "ubuntu" user (uid 1000) would shadow your own user inside
    # the container (ssh and git look up the home folder by uid).
    userdel -r ubuntu 2>/dev/null || true

# uv / uvx, for Python-based MCP servers (e.g. "command": "uvx" in your MCP config).
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv \
 && ln -s /opt/uv/bin/uv /opt/uv/bin/uvx /usr/local/bin/

# The docker CLI with the compose and buildx plugins, from Docker's own apt
# repository. No daemon: docker-compose.yml mounts the host's Docker socket, so
# containers a chat starts run on the host, next to this one.
RUN if [ "$WITH_DOCKER" = 1 ]; then \
      set -eux; \
      install -m 0755 -d /etc/apt/keyrings; \
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin; \
      rm -rf /var/lib/apt/lists/*; \
    fi

RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
# Dependencies before source: this layer and the browser install below stay
# cached until package-lock.json changes.
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

# The built-in browser lives in the image at /ms-playwright and is handed to
# claude-ui alone as CW_BROWSER_PATH. PLAYWRIGHT_BROWSERS_PATH is set only for
# this install, never image-wide, so chats, MCP servers and the scripts they run
# keep Playwright's default (~/.cache/ms-playwright, a volume in
# docker-compose.yml) and download whichever build their own Playwright wants.
# --with-deps also installs the system libraries those builds need.
RUN if [ "$WITH_BROWSER" = 1 ]; then \
      export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
      && exe=$(node -p "require('playwright-core').chromium.executablePath()") \
      && test -x "$exe" \
      && echo "CW_BROWSER_PATH=$exe" > /etc/claude-ui.env \
      && rm -rf /var/lib/apt/lists/*; \
    else echo "CW_BROWSER=0" > /etc/claude-ui.env; fi \
    && touch /etc/claude-ui.env

COPY docker/entrypoint.sh /usr/local/bin/claude-ui-entrypoint

# The app itself, last. A code change only redoes these two copies (and the
# vite build in the build stage).
COPY . .
COPY --from=build /app/dist ./dist

# The CLI can't update itself inside the image (rebuild instead).
ENV DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production \
    LANG=C.UTF-8 \
    SHELL=/bin/bash \
    CW_HOST=0.0.0.0 \
    CW_IN_DOCKER=1 \
    CW_PORT=8787

EXPOSE 8787
ENTRYPOINT ["tini", "--", "claude-ui-entrypoint"]
CMD ["node", "server/index.js"]
