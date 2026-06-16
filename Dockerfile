# syntax=docker/dockerfile:1
#
# Backend image — also reused for docs-agent / sheets-agent (same code,
# discriminated by AGENT_KIND at runtime; see src/agent.ts).
#
# Runs via `tsx` (no tsc build) exactly like the prod systemd unit.

# ── deps: compile native modules (better-sqlite3, node-pty) for Linux ──
FROM node:20-bookworm AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── runtime: node + docker CLI ──
FROM node:20-bookworm AS runtime
WORKDIR /app

# Docker CLI + compose plugin so the backend (and the Claude agent it runs)
# can `docker ps` / `docker exec ai-ide-playwright …` against the HOST daemon
# via the mounted /var/run/docker.sock (Docker-out-of-Docker). tmux/git are
# used by some skills + boot recipes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git tmux \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI on PATH — warmStartClaudeCli() auto-detects it. Do NOT
# carry a Windows CLAUDE_PATH into the container.
RUN npm install -g @anthropic-ai/claude-code

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production \
    HOME=/root \
    HOST=0.0.0.0 \
    PORT=8090
EXPOSE 8090 4100 4101
CMD ["node_modules/.bin/tsx", "src/index.ts"]
