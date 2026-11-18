# Claude UI plus the Claude Code CLI in one image, so the host only needs Docker.
# See "Run it in Docker" in README.md: docker-compose.yml shares your host's
# Claude data (sessions, login, settings) with the container.

FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04 AS build
COPY --from=node /usr/local/ /usr/local/
# Build tools for node-pty (Terminal and Shell sessions).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build && npm prune --omit=dev

FROM ubuntu:24.04
# Pin a version (e.g. 2.1.0) for reproducible builds; rebuild to update.
ARG CLAUDE_CODE_VERSION=latest
# 0 = leave out the built-in browser (Chromium, about 400 MB).
ARG WITH_BROWSER=1
# Anything else your projects or MCP servers need, e.g. "golang make jq".
ARG EXTRA_APT_PACKAGES=""

COPY --from=node /usr/local/ /usr/local/

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client gh ripgrep less procps jq \
      python3 python3-venv python3-pip python-is-python3 tini util-linux locales $EXTRA_APT_PACKAGES; \
    rm -rf /var/lib/apt/lists/*; \
    # The image's "ubuntu" user (uid 1000) would shadow your own user inside
    # the container (ssh and git look up the home folder by uid).
    userdel -r ubuntu 2>/dev/null || true

# uv / uvx, for Python-based MCP servers (e.g. "command": "uvx" in your MCP config).
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv \
 && ln -s /opt/uv/bin/uv /opt/uv/bin/uvx /usr/local/bin/

RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY --from=build /app /app

# Browsers live in the image, not in your (mounted) home folder.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$WITH_BROWSER" = 1 ]; then \
      node node_modules/playwright-core/cli.js install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/*; \
    else echo "CW_BROWSER=0" > /etc/claude-ui.env; fi; \
    touch /etc/claude-ui.env

COPY docker/entrypoint.sh /usr/local/bin/claude-ui-entrypoint

# The CLI can't update itself inside the image (rebuild instead).
ENV DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production \
    LANG=C.UTF-8 \
    SHELL=/bin/bash \
    CW_HOST=0.0.0.0 \
    CW_PORT=8787

EXPOSE 8787
ENTRYPOINT ["tini", "--", "claude-ui-entrypoint"]
CMD ["node", "server/index.js"]
