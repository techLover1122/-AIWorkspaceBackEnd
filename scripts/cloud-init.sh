#!/usr/bin/env bash
#
# AI-IDE Studio — EC2 cloud-init startup script
#
# This script is designed to run as **root** on a fresh Ubuntu 22.04/24.04
# EC2 instance via cloud-init (user-data). It's fully non-interactive —
# no prompts, no `read` calls, no human input required.
#
# What it does:
#   1. apt base packages + Node.js 20 LTS + Claude Code CLI + code-server
#   2. Clones backend (AIWorkspaceBackEnd) + frontend (AIWorkspaceFrontEnd)
#      into /home/ubuntu/AI-IDE/{backend,frontend}
#   3. npm install in both projects (as the ubuntu user)
#   4. Configures code-server to bind 0.0.0.0:8080 with auth disabled
#   5. Creates systemd services for backend + frontend + code-server so
#      everything auto-starts on boot
#   6. Docs/Sheets bridge — installs tmux boot recipes that start
#      employee-todo (port 3456, hosts the ONLYOFFICE editor iframe)
#      and two headless Playwright co-editor sessions so docs-agent /
#      sheets-agent MCP bridges have a connected editor even when no
#      user tab is open. Requires the ai-ide-playwright container +
#      ai-ide-onlyoffice / -docs-agent / -sheets-agent systemd units
#      to already be present (provisioned by the wrapper user-data).
#
# Usage (paste into EC2 user-data field at instance launch):
#   #!/bin/bash
#   curl -fsSL https://raw.githubusercontent.com/techLover1122/-AIWorkspaceBackEnd/main/scripts/cloud-init.sh | bash
#
# Or upload directly as the user-data script.
#
# Required EC2 Security Group inbound rules (TCP):
#   - 22    (SSH)
#   - 80    (frontend — Next.js bound to privileged port via systemd
#            AmbientCapabilities; no nginx needed)
#   - 8080  (code-server — VS Code in browser)
#   - 8090  (backend — called directly by the browser, since the frontend
#            exposes the backend URL via NEXT_PUBLIC_BACKEND_URL)
#
# ⚠ SECURITY WARNING
#   code-server is configured WITHOUT authentication and bound to 0.0.0.0.
#   Anyone who can reach the EC2 public IP on port 8080 has a root shell
#   inside the VS Code terminal. RESTRICT THE SECURITY GROUP to your own
#   IP, or enable auth in /home/ubuntu/.config/code-server/config.yaml
#   before exposing this machine to the internet.
#
# Logs land in /var/log/ai-ide-install.log — `tail -f` it to watch progress.

set -euo pipefail

# cloud-init invokes user-data with a minimal env — $HOME is unset even when
# running as root. The official code-server installer (and a couple of npm
# subcommands) read $HOME and die under `set -u`, so pin it explicitly.
export HOME="${HOME:-/root}"

# Pull IMDS-derived identity + AWS creds from the shared env file written by
# user-data.sh.tftpl. Using `set -a` so every var becomes exported, then
# turning it back off to avoid polluting the rest of the script's behavior.
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

readonly REPO_BACKEND="https://github.com/techLover1122/-AIWorkspaceBackEnd.git"
readonly REPO_FRONTEND="https://github.com/techLover1122/AIWorkspaceFrontEnd.git"
readonly TARGET_USER="${TARGET_USER:-ubuntu}"
readonly TARGET_HOME="/home/${TARGET_USER}"
readonly PROJECT_DIR="${TARGET_HOME}/AI-IDE"
readonly NODE_MAJOR=20
readonly BACKEND_PORT=8090
# Traefik (installed by user-data.sh.tftpl) owns :80 and proxies
# frontend.$USER_ID.$PLATFORM_DOMAIN → 127.0.0.1:$FRONTEND_PORT, so the
# Next.js process must NOT bind a privileged port anymore.
readonly FRONTEND_PORT=3000
readonly CODE_SERVER_PORT=8080
readonly LOG_FILE="/var/log/ai-ide-install.log"

# ────────────────────────────────────────────────────────────────────
# Logging — tee everything to both console and log file
# ────────────────────────────────────────────────────────────────────

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "[$(date '+%H:%M:%S')] $*"; }
hdr() { echo; echo "═══ $* ═══"; }

# ────────────────────────────────────────────────────────────────────
# Pre-flight — must be root + Ubuntu
# ────────────────────────────────────────────────────────────────────

hdr "Pre-flight"
log "AI-IDE EC2 cloud-init script — $(date)"

if [ "$(id -u)" != "0" ]; then
  log "ERROR: this script must run as root (cloud-init context)."
  log "       If running manually, prefix with sudo."
  exit 1
fi

if ! [ -f /etc/os-release ]; then
  log "ERROR: can't read /etc/os-release — not Linux?"
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  log "ERROR: this script targets Ubuntu. Detected: ${PRETTY_NAME:-unknown}"
  exit 1
fi

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  log "ERROR: target user '$TARGET_USER' doesn't exist."
  log "       The standard Ubuntu EC2 AMI provides 'ubuntu' by default."
  exit 1
fi

log "OS: $PRETTY_NAME"
log "Target user: $TARGET_USER ($TARGET_HOME)"
log "Project will be cloned to: $PROJECT_DIR"

# Helper — run a command as the target user
as_user() {
  runuser -u "$TARGET_USER" -- "$@"
}

# ────────────────────────────────────────────────────────────────────
# Step 0 — Swap (t3.micro has 1 GB RAM; npm install OOMs without it)
# ────────────────────────────────────────────────────────────────────

hdr "Step 0 — Swap (avoids OOM during npm install on small instances)"

if swapon --show | grep -q .; then
  log "swap already active — skipping"
else
  log "Creating 2 GB /swapfile"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  # Persist across reboots.
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi
free -h

# ────────────────────────────────────────────────────────────────────
# Step 1 / 7 — apt base packages
# ────────────────────────────────────────────────────────────────────

hdr "Step 1 / 7 — apt base packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y \
  curl ca-certificates gnupg git \
  build-essential python3 unzip \
  >/dev/null

log "✓ Base packages installed"

# ────────────────────────────────────────────────────────────────────
# Step 2 / 7 — Node.js 20 LTS
# ────────────────────────────────────────────────────────────────────

hdr "Step 2 / 7 — Node.js ${NODE_MAJOR} LTS"

if command -v node >/dev/null && [ "$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')" -ge "$NODE_MAJOR" ]; then
  log "node $(node -v) already installed — skipping"
else
  log "Adding NodeSource repo and installing Node ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs >/dev/null
fi

log "✓ node $(node -v) / npm $(npm -v)"

# ────────────────────────────────────────────────────────────────────
# Step 3 / 7 — Claude Code CLI
# ────────────────────────────────────────────────────────────────────

hdr "Step 3 / 7 — Claude Code CLI"

if command -v claude >/dev/null; then
  log "claude already installed — skipping"
else
  log "Installing @anthropic-ai/claude-code globally"
  npm install -g @anthropic-ai/claude-code
fi

log "✓ claude $(claude --version 2>/dev/null | head -1 || echo unknown)"

# ────────────────────────────────────────────────────────────────────
# Step 4 / 7 — code-server
# ────────────────────────────────────────────────────────────────────

hdr "Step 4 / 7 — code-server (VS Code in browser)"

if command -v code-server >/dev/null; then
  log "code-server already installed — skipping"
else
  log "Running official code-server install script"
  curl -fsSL https://code-server.dev/install.sh | sh
fi

log "Writing code-server config (bind 0.0.0.0:${CODE_SERVER_PORT}, auth=none)"
as_user mkdir -p "${TARGET_HOME}/.config/code-server"
cat > "${TARGET_HOME}/.config/code-server/config.yaml" <<EOF
bind-addr: 0.0.0.0:${CODE_SERVER_PORT}
auth: none
cert: false
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.config"

log "✓ code-server $(code-server --version 2>/dev/null | head -1)"

# ────────────────────────────────────────────────────────────────────
# Step 5 / 7 — Clone repos
# ────────────────────────────────────────────────────────────────────

hdr "Step 5 / 7 — Clone backend + frontend repos"

as_user mkdir -p "$PROJECT_DIR"

clone_or_pull() {
  local repo_url="$1" target_dir="$2" name="$3"
  if [ -d "${target_dir}/.git" ]; then
    log "${name}: existing checkout found — git pull"
    as_user git -C "$target_dir" pull --ff-only
  else
    log "${name}: cloning from ${repo_url}"
    as_user git clone --depth=1 "$repo_url" "$target_dir"
  fi
}

clone_or_pull "$REPO_BACKEND"  "${PROJECT_DIR}/backend"  "backend"
clone_or_pull "$REPO_FRONTEND" "${PROJECT_DIR}/frontend" "frontend"

log "✓ Both repos checked out under ${PROJECT_DIR}"

# ────────────────────────────────────────────────────────────────────
# Step 6 / 7 — npm install (frontend + backend)
# ────────────────────────────────────────────────────────────────────

hdr "Step 6 / 7 — npm install (this can take a few minutes)"

# Both repos pin the China npm mirror (registry.npmmirror.com) in their
# .npmrc and in lockfile `resolved` URLs. That mirror returns 503 constantly
# from us-west-2, so swap every reference to the official registry before
# installing. --registry on the install command alone is not enough — npm
# uses the URLs already baked into package-lock.json.
for d in "${PROJECT_DIR}/backend" "${PROJECT_DIR}/frontend"; do
  for f in "$d/.npmrc" "$d/package-lock.json"; do
    [ -f "$f" ] || continue
    log "Rewriting npmmirror.com -> npmjs.org in $f"
    as_user sed -i 's|registry\.npmmirror\.com|registry.npmjs.org|g' "$f"
  done
done

NPM_FLAGS="--no-fund --no-audit --registry=https://registry.npmjs.org"

log "backend: npm install"
as_user bash -lc "cd ${PROJECT_DIR}/backend && npm install $NPM_FLAGS"

log "frontend: npm install"
as_user bash -lc "cd ${PROJECT_DIR}/frontend && npm install $NPM_FLAGS"

log "✓ Dependencies installed"

# ────────────────────────────────────────────────────────────────────
# Step 7 / 7 — systemd services
# ────────────────────────────────────────────────────────────────────

hdr "Step 7 / 7 — systemd services (backend + frontend + code-server)"

# --- Backend service ---
# Pulls INSTANCE_ID / INSTANCE_IP / INSTANCE_URL / BUCKET_ID / AWS_REGION /
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from /etc/workspace.env (written by
# the wrapper user-data). Environment= overrides PORT so the backend listens
# on its own port, not the workspace server's.
cat > /etc/systemd/system/ai-ide-backend.service <<EOF
[Unit]
Description=AI-IDE Backend (Hono API on :${BACKEND_PORT})
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/backend
EnvironmentFile=/etc/workspace.env
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${BACKEND_PORT}
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# --- Frontend service ---
# Frontend listens on $FRONTEND_PORT (unprivileged). The browser hits it via
# Traefik at http://frontend-$USER_ID.$PLATFORM_DOMAIN/, and Traefik proxies
# to 127.0.0.1:$FRONTEND_PORT. NEXT_PUBLIC_* URLs are public hosts so the
# browser also routes through Traefik (backend → api-..., code-server → ide-...).
# The dash-separator keeps every subdomain one DNS label deep so a single
# *.platform.bytescripterz.com wildcard CNAME covers every user.
#
# NOTE on ExecStart: the upstream frontend's `npm run dev` script hard-codes
# `next dev -p 80`, which overrides any PORT env var and (since we run as
# the unprivileged ubuntu user without AmbientCapabilities) fails with
# EACCES. Bypass the npm script by calling next's binary directly.
cat > /etc/systemd/system/ai-ide-frontend.service <<EOF
[Unit]
Description=AI-IDE Frontend (Next.js on :${FRONTEND_PORT})
After=network.target ai-ide-backend.service

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/frontend
# Inherit shared instance metadata + IAM creds from the wrapper user-data.
EnvironmentFile=/etc/workspace.env
Environment=NEXT_PUBLIC_BACKEND_URL=${PLATFORM_PROTOCOL:-http}://api-${USER_ID}.${PLATFORM_DOMAIN}
Environment=NEXT_PUBLIC_CODE_SERVER_URL=${PLATFORM_PROTOCOL:-http}://ide-${USER_ID}.${PLATFORM_DOMAIN}
# Frontend uses these to detect platform-internal URLs in chat-link
# buttons and ensure the corresponding service is registered before
# the user's browser tries to load them.
Environment=NEXT_PUBLIC_USER_ID=${USER_ID}
Environment=NEXT_PUBLIC_PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
ExecStart=${PROJECT_DIR}/frontend/node_modules/.bin/next dev -p ${FRONTEND_PORT} -H 0.0.0.0
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Reload + enable + start
systemctl daemon-reload

# code-server ships its own unit at code-server@.service — enable for our user
log "Enabling code-server@${TARGET_USER}"
systemctl enable --now "code-server@${TARGET_USER}" || true

log "Enabling ai-ide-backend"
systemctl enable --now ai-ide-backend

log "Enabling ai-ide-frontend"
systemctl enable --now ai-ide-frontend

# Give the services a moment to start, then sanity-check
sleep 5
for svc in "code-server@${TARGET_USER}" ai-ide-backend ai-ide-frontend; do
  state=$(systemctl is-active "$svc" || true)
  log "  ${svc}: ${state}"
done

# ────────────────────────────────────────────────────────────────────
# Step 7b — WhatsApp sidecar (ai-ide-whatsapp.service)
# ────────────────────────────────────────────────────────────────────
#
# Tiny Go service that owns the WhatsApp connection (whatsmeow) and
# exposes a localhost-only HTTP API the Node backend proxies. Source
# lives in the backend repo at backend/whatsapp/. Built here at first
# boot and on subsequent re-runs (the build is cheap once Go is cached).
#
# Wiring:
#   - WHATSAPP_AUTH_TOKEN  shared secret, generated once and stored in
#                          /etc/workspace.env so backend + sidecar agree.
#   - 127.0.0.1:8091       sidecar listen addr (not exposed via Traefik).
#   - /var/lib/ai-ide/whatsapp/session.db   whatsmeow's pairing store.
#
# The integration is dormant until the user pairs via the chat-panel
# "Link WhatsApp" button — the sidecar runs but doesn't connect to
# WhatsApp servers until /qr or /pair-phone is hit.

hdr "Step 7b — WhatsApp sidecar (Go)"

WA_SRC="${PROJECT_DIR}/backend/whatsapp"
WA_BIN="/usr/local/bin/ai-ide-whatsapp"
WA_STATE_DIR="/var/lib/ai-ide/whatsapp"

if [ ! -d "$WA_SRC" ]; then
  log "WARN: $WA_SRC not found — skipping WhatsApp sidecar (older backend checkout?)"
else
  # 1. Install Go from the official tarball. Ubuntu's apt golang-go
  #    package is way behind (1.18 on 22.04, 1.22 on 24.04) and
  #    whatsmeow upstream pins go >= 1.25, so apt is a dead end.
  #    Tarball install is reproducible and survives re-runs (just
  #    re-extracts over the same /usr/local/go directory).
  GO_VER=1.25.5
  if ! /usr/local/go/bin/go version 2>/dev/null | grep -qE "go${GO_VER}"; then
    log "Installing Go ${GO_VER} to /usr/local/go"
    curl -fsSL "https://go.dev/dl/go${GO_VER}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm -f /tmp/go.tar.gz
    if ! grep -q '/usr/local/go/bin' /etc/profile.d/go.sh 2>/dev/null; then
      echo 'export PATH=/usr/local/go/bin:$PATH' > /etc/profile.d/go.sh
      chmod 644 /etc/profile.d/go.sh
    fi
  fi
  export PATH=/usr/local/go/bin:$PATH

  # 2. CGO toolchain — go-sqlite3 builds C source, so gcc must exist.
  if ! dpkg -s build-essential >/dev/null 2>&1; then
    log "Installing build-essential for CGO"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential
  fi

  # 3. Build the sidecar binary as the workspace user (so the module
  #    cache lives under ~/.cache/go-build, not root's). The output
  #    binary itself is installed system-wide.
  log "Building ai-ide-whatsapp sidecar"
  as_user bash -lc "export PATH=/usr/local/go/bin:\$PATH && cd '$WA_SRC' && GOFLAGS=-mod=mod CGO_ENABLED=1 go build -o /tmp/ai-ide-whatsapp ."
  install -m 755 /tmp/ai-ide-whatsapp "$WA_BIN"
  rm -f /tmp/ai-ide-whatsapp

  # 4. Generate the shared auth token once. Idempotent — if a token
  #    already exists in /etc/workspace.env we keep it (otherwise an
  #    existing paired session would be locked out after a re-run).
  if ! grep -q '^WHATSAPP_AUTH_TOKEN=' /etc/workspace.env 2>/dev/null; then
    token="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
    {
      echo ""
      echo "# ai-ide-whatsapp shared bearer token"
      echo "WHATSAPP_AUTH_TOKEN=${token}"
      echo "WHATSAPP_SIDECAR_URL=http://127.0.0.1:8091"
    } >> /etc/workspace.env
    log "Wrote WHATSAPP_AUTH_TOKEN to /etc/workspace.env"
  else
    log "WHATSAPP_AUTH_TOKEN already present in /etc/workspace.env — leaving it"
  fi

  # 5. Session store dir owned by the workspace user so the sidecar can
  #    write the sqlite db without sudo.
  mkdir -p "$WA_STATE_DIR"
  chown -R "$TARGET_USER:$TARGET_USER" "$WA_STATE_DIR"

  # 6. systemd unit. Loads /etc/workspace.env so WHATSAPP_AUTH_TOKEN
  #    propagates here. Bound to localhost only.
  cat > /etc/systemd/system/ai-ide-whatsapp.service <<EOF
[Unit]
Description=AI-IDE WhatsApp sidecar (whatsmeow on 127.0.0.1:8091)
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
EnvironmentFile=/etc/workspace.env
Environment=LISTEN_ADDR=127.0.0.1:8091
Environment=SESSION_DIR=${WA_STATE_DIR}
Environment=BACKEND_WEBHOOK_URL=http://127.0.0.1:${BACKEND_PORT}/api/whatsapp/incoming
ExecStart=${WA_BIN}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now ai-ide-whatsapp || log "WARN: failed to start ai-ide-whatsapp"
  # Restart the backend so it picks up the new WHATSAPP_AUTH_TOKEN /
  # WHATSAPP_SIDECAR_URL env vars from /etc/workspace.env.
  systemctl restart ai-ide-backend || true
  log "  ai-ide-whatsapp: $(systemctl is-active ai-ide-whatsapp || true)"
fi

# ────────────────────────────────────────────────────────────────────
# Step 8 — Docs/Sheets bridge boot recipes
# ────────────────────────────────────────────────────────────────────
#
# The ai-ide-services.service unit (provisioned by the wrapper user-
# data, not here) runs /usr/local/bin/ai-ide-restart-services.sh on
# every boot and replays every *.sh in ~/.ai-ide/services/ inside a
# fresh tmux session. We use that hook to keep two stateful pieces
# running across reboots:
#
#   employee-todo.sh         — Next.js dev server on port 3456 that
#                              serves the employees-<USER>.<DOMAIN>
#                              subdomain (mounts the ONLYOFFICE editor).
#   headless-coeditors.sh    — Two long-running Playwright headless
#                              Chromiums inside the ai-ide-playwright
#                              container. Each holds an editor session
#                              open so the ai-agent-bridge plugin can
#                              connect to docs-agent / sheets-agent
#                              even when the user has no browser tab
#                              open on the document.

hdr "Step 8 — Docs/Sheets bridge boot recipes"

SCRIPTS_SRC="${PROJECT_DIR}/backend/scripts"
SERVICES_DIR="${TARGET_HOME}/.ai-ide/services"
as_user mkdir -p "$SERVICES_DIR"

if [ -d "${SCRIPTS_SRC}/recipes" ]; then
  for recipe in employee-todo.sh headless-coeditors.sh; do
    src="${SCRIPTS_SRC}/recipes/${recipe}"
    dst="${SERVICES_DIR}/${recipe}"
    if [ -f "$src" ]; then
      log "Installing boot recipe: ${recipe}"
      install -o "$TARGET_USER" -g "$TARGET_USER" -m 755 "$src" "$dst"
    else
      log "WARN: recipe ${src} missing — skipping"
    fi
  done
else
  log "WARN: ${SCRIPTS_SRC}/recipes not found — boot recipes NOT installed"
  log "      docs-agent / sheets-agent will lose their connection after reboot"
fi

# Kick the recipes off now (don't wait for next boot). If the ai-ide-
# services.service unit isn't registered yet, fall back to launching
# the recipes directly in detached tmux sessions.
if systemctl list-unit-files | grep -q '^ai-ide-services\.service'; then
  log "Restarting ai-ide-services to pick up the new recipes"
  systemctl restart ai-ide-services || log "WARN: ai-ide-services restart failed"
else
  log "ai-ide-services.service not installed — starting recipes directly"
  for recipe in employee-todo.sh headless-coeditors.sh; do
    f="${SERVICES_DIR}/${recipe}"
    [ -f "$f" ] || continue
    name="${recipe%.sh}"
    as_user tmux kill-session -t "$name" 2>/dev/null || true
    as_user tmux new -d -s "$name" "bash '$f'" \
      || log "WARN: failed to start tmux session $name"
  done
fi

log "✓ Docs/Sheets bridge boot recipes installed"

# ────────────────────────────────────────────────────────────────────
# Make sure .claude/skills dir exists for future skill installs
# ────────────────────────────────────────────────────────────────────

as_user mkdir -p "${TARGET_HOME}/.claude/skills"

# ────────────────────────────────────────────────────────────────────
# Drop a CLAUDE.md so direct `claude` CLI invocations (terminal, code-
# server, etc.) also get proxy-environment context — not just chat
# requests routed through the backend, which inject the same content via
# the SDK's appendSystemPrompt option.
# ────────────────────────────────────────────────────────────────────

# Source /etc/workspace.env to get USER_ID / PLATFORM_DOMAIN. user-data.sh
# already exported these for the parent shell, but cloud-init.sh runs in
# its own shell — re-source defensively.
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

PROXY_DOMAIN="${PLATFORM_DOMAIN:-platform.bytescripterz.com}"
PROXY_USER="${USER_ID:-unknown}"
PROXY_SCHEME="${PLATFORM_PROTOCOL:-http}"

cat > "${TARGET_HOME}/.claude/CLAUDE.md" <<MDEOF
# Workspace environment

This workspace runs behind an edge proxy + per-user Traefik. HTTP services
exposed here are reachable from the user's browser ONLY through a public
subdomain — \`http://localhost:<port>\` URLs are NOT reachable from the
browser (it's on a different origin).

## Default service URLs

- Frontend (Next.js, port 3000):  ${PROXY_SCHEME}://frontend-${PROXY_USER}.${PROXY_DOMAIN}
- Backend API (Hono, port 8090):  ${PROXY_SCHEME}://api-${PROXY_USER}.${PROXY_DOMAIN}
- code-server / IDE (port 8080):  ${PROXY_SCHEME}://ide-${PROXY_USER}.${PROXY_DOMAIN}

## Adding a new service

When you start a new HTTP service in this workspace:

1. Bind it to localhost or 0.0.0.0 on any unprivileged port.
2. Register the port — either via the MCP tool \`register_service\` if
   you're in chat, or directly:
   \`\`\`bash
   curl -X POST -H 'Content-Type: application/json' \\
     -d '{"port": <PORT>}' \\
     "\${PROXY_ROUTER_URL}/api/services/\${USER_ID}"
   \`\`\`
3. Use the returned URL — NOT \`http://localhost:<port>\` — anywhere the
   browser needs to reach the service.

Without step 2, browser fetches will fail with DNS / CORS errors.

## Subdomain convention

A registered port \`P\` (no custom name) becomes:
  \`${PROXY_SCHEME}://port-P-${PROXY_USER}.${PROXY_DOMAIN}\`

## CORS

The browser's origin is \`${PROXY_SCHEME}://frontend-${PROXY_USER}.${PROXY_DOMAIN}\`.
Backends must allow that origin (or \`*\`) on cross-origin XHR. The default
backend already does.

## Don't

- Don't hardcode \`localhost\` / \`127.0.0.1\` URLs in browser-facing code.
- Don't bind privileged ports (<1024). Port 80 is Traefik's.
- Don't print \`http://localhost:<port>\` as the dev URL — the user will
  copy it and get a broken page. Print the registered public URL instead.

# Chat output: links

Links you write in chat replies render as inline pill-buttons that open
the URL as a workspace tab (not plain \`<a>\` tags). So:

- Always write a URL as a markdown link with a short descriptive label:
  \`[Open the dashboard](http://frontend-...)\`. Never paste raw URLs.
- Don't say "navigate to ..." or "open ... in your browser". Just give
  the link button — one click does it.
- Code-formatted URLs (\`http://...\`) stay as code; only markdown links
  become buttons. Use code for URLs the user copies, link syntax for
  URLs they should open.

# Iframe compatibility

Every service exposed through the workspace is rendered inside an iframe
in the user's AI-IDE UI. Anything you build MUST be embeddable or the
user sees a blank tab.

## Rule: don't block framing

- Don't set \`X-Frame-Options: DENY\` or \`SAMEORIGIN\`. If a framework
  sets it by default (Helmet, Spring Security, Django middleware, older
  Next.js), remove or override it.
- Don't set a CSP with \`frame-ancestors 'none'\` or \`frame-ancestors
  'self'\`. Either omit \`frame-ancestors\` or use \`frame-ancestors *\`
  (or the frontend origin specifically).
- Don't write \"frame-buster\" JS like
  \`if (window.top !== window.self) window.top.location = …\`.

## Rule: cookies must work cross-origin

The iframe URL is a different origin from the parent frontend, so any
cookie the iframe relies on must be:

- \`SameSite=None; Secure\` — required for cookies sent in a third-party
  context. Plain \`SameSite=Lax\` cookies silently get dropped.
- HTTPS-only once TLS is on. \`Secure\` is mandatory with \`SameSite=None\`.

## Rule: auth flows can't full-page-redirect

OAuth/SSO providers that redirect via \`top.location\` (or refuse to load
in an iframe) break inside the workspace. When scaffolding auth, prefer:

1. Backend-handled OAuth — provider redirects to your backend, which sets
   the cookie and 302s to your app, all in the iframe.
2. Popup-based auth — open a new window for the redirect, post the token
   back to the iframe via \`postMessage\`.

Warn the user explicitly if a chosen auth provider refuses iframe
embedding (Google's OAuth screen does, Auth0's does too by default).

# Environment packs (installed skills)

This workspace has user-installed environment packs at \`~/.claude/skills/\`.
Each pack's \`SKILL.md\` documents tool / library / config choices the user
previously settled on. Packs are advisory **defaults** for cases where the
user hasn't specified — they do not override an explicit user instruction.

## Rule: when YOU are choosing, consult packs first

When the user's request is open-ended about tools — e.g. "give me a
database viewer" — and you would otherwise pick something on your own:

1. List \`~/.claude/skills/\` and read every relevant SKILL.md.
2. If a pack covers it, follow that pack verbatim.

If you think the pack's choice is wrong, tell the user before deviating:

> The <pack-name> pack specifies <X>, but I'd like to use <Y> here
> because <reason>. OK to deviate from the pack?

Then wait for their answer.

## Rule: when the USER chooses, defer to the user (no pushback)

If the user explicitly asks for a specific tool/library — e.g. "install
pgweb" — just do it. Don't say "the pack specifies X instead". The user
knows. This is often how they evolve their packs: try something off-pack,
decide it works, bake it into the next pack revision.

You may mention the conflict once, briefly, AFTER completing the task —
e.g. "Installed pgweb. Heads-up: the <pack> pack has Mathesar as the
default DB viewer; let me know if you'd like to update the pack."

## Rule: cross-session memory

When YOU are picking (not the user), packs are project-level decisions.
A new session asking "give me a database viewer" should still produce
whatever the pack says — re-list the packs.
MDEOF
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.claude/CLAUDE.md"

# ────────────────────────────────────────────────────────────────────
# Final summary
# ────────────────────────────────────────────────────────────────────

hdr "All done"

# Public IP is exported by user-data.sh.tftpl (which already queries IMDSv2
# during bootstrap). Fall back to a placeholder only if this script is run
# manually outside that context.
PUBLIC_IP="${PUBLIC_IP:-<EC2_PUBLIC_IP>}"

cat <<EOF

  ✓ AI-IDE Studio is up on this EC2 instance.

  Public endpoints (via the central edge proxy + per-user Traefik on :80):
    • Frontend:    ${PLATFORM_PROTOCOL:-http}://frontend-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/
    • Backend API: ${PLATFORM_PROTOCOL:-http}://api-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/
    • code-server: ${PLATFORM_PROTOCOL:-http}://ide-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/   (NO password!)

  Internal ports (bypass Traefik, useful only for SSH debugging):
    • Frontend → 127.0.0.1:${FRONTEND_PORT}
    • Backend  → 127.0.0.1:${BACKEND_PORT}
    • code-server → 127.0.0.1:${CODE_SERVER_PORT}
    • Direct EC2 IP: ${PUBLIC_IP}

  Service controls (run on the EC2 instance):
    sudo systemctl status  ai-ide-backend
    sudo systemctl restart ai-ide-frontend
    sudo journalctl -u ai-ide-backend -f
    sudo journalctl -u ai-ide-frontend -f
    sudo journalctl -u code-server@${TARGET_USER} -f

  Install log: ${LOG_FILE}

  ⚠ SECURITY WARNING
    code-server is publicly exposed on port ${CODE_SERVER_PORT} without
    authentication. Anyone reaching this IP has a root shell. Either:
      - Restrict EC2 Security Group inbound to your IP only, OR
      - Enable auth: edit ${TARGET_HOME}/.config/code-server/config.yaml
        and run 'sudo systemctl restart code-server@${TARGET_USER}'.

  Claude skills are NOT pre-installed. After SSH'ing in, either:
    - Copy your skills folder to ${TARGET_HOME}/.claude/skills/, OR
    - Tell Claude in chat: "Create a pack for <platform>" — the
      create-platform-pack meta-skill will scaffold it (if it exists).

EOF
