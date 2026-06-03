#!/usr/bin/env bash
# headless-coeditors.sh — tmux recipe replayed at boot by
# /usr/local/bin/ai-ide-restart-services.sh.
#
# Starts two long-running headless Playwright sessions inside the
# ai-ide-playwright container — one drives Document.docx, the other
# Employees.xlsx. Each session loads the ONLYOFFICE editor and lets
# its ai-agent-bridge plugin connect to docs-agent (4100) / sheets-agent
# (4101). With these holding the connection, MCP docs_*/sheets_* tools
# work even when the user has no browser tabs open on the documents.
#
# Playwright (the npm package) is installed at
# /work/playwright/docs-test/node_modules in the container, so the
# scripts are copied there and run from that cwd to resolve the import.
#
# The recipe stays in the foreground (a tail -F) so the tmux session
# stays alive — that's the contract ai-ide-restart-services.sh expects.
set -uo pipefail

PLAYWRIGHT_CONTAINER="${PLAYWRIGHT_CONTAINER:-ai-ide-playwright}"
HOST_SCRIPT_DIR="${HOST_SCRIPT_DIR:-/home/ubuntu/AI-IDE/backend/scripts/headless}"
# Cwd inside the container that has playwright in node_modules.
CONTAINER_WORKDIR="${CONTAINER_WORKDIR:-/work/playwright/docs-test}"

# Derive the per-workspace DOC URLs from /etc/workspace.env so the recipe
# isn't tied to one user-id. USER_ID + PLATFORM_DOMAIN are written there
# by the EC2 wrapper user-data. Override DOCS_URL / SHEETS_URL directly
# if you want to point the headless co-editors at a different file.
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi
USER_ID="${USER_ID:?USER_ID must be set (sourced from /etc/workspace.env)}"
PLATFORM_DOMAIN="${PLATFORM_DOMAIN:-platform.bytescripterz.com}"
PLATFORM_PROTOCOL="${PLATFORM_PROTOCOL:-https}"
EMPLOYEES_HOST="${PLATFORM_PROTOCOL}://employees-${USER_ID}.${PLATFORM_DOMAIN}"
DOCS_URL="${DOCS_URL:-${EMPLOYEES_HOST}/edit?fileId=default-doc&type=docx&name=Document.docx}"
SHEETS_URL="${SHEETS_URL:-${EMPLOYEES_HOST}/edit?fileId=employees&type=xlsx&name=Employees.xlsx}"

# Wait for the playwright container to be running (it's a separate
# docker / systemd unit and may come up after us).
for i in $(seq 1 60); do
  if sudo docker inspect -f '{{.State.Running}}' "$PLAYWRIGHT_CONTAINER" 2>/dev/null | grep -q true; then
    break
  fi
  echo "[headless-coeditors] waiting for ${PLAYWRIGHT_CONTAINER}…"
  sleep 5
done

# Wait for the employee-todo dev server — the headless browser
# navigates to its /edit page. The companion employee-todo.sh recipe
# brings it up; without it the editor iframe never loads.
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "${EMPLOYEES_HOST}/" 2>/dev/null; then
    break
  fi
  echo "[headless-coeditors] waiting for ${EMPLOYEES_HOST}…"
  sleep 5
done

# Copy the scripts into the container's playwright-enabled cwd. The
# host AI-IDE dir is already mounted at /work, but the scripts live at
# /work/backend/scripts/headless — running them from there can't find
# the playwright module, so we stage copies into docs-test/.
for name in keep-docs-open.mjs keep-sheets-open.mjs; do
  if [ -f "${HOST_SCRIPT_DIR}/${name}" ]; then
    sudo docker cp "${HOST_SCRIPT_DIR}/${name}" \
      "${PLAYWRIGHT_CONTAINER}:${CONTAINER_WORKDIR}/${name}"
  else
    echo "[headless-coeditors] WARN: ${HOST_SCRIPT_DIR}/${name} missing — skipping"
  fi
done

# Kill any stale sessions from a previous boot, then relaunch in the
# background (detached docker exec) so we can tail the logs.
sudo docker exec "$PLAYWRIGHT_CONTAINER" bash -lc \
  'pkill -f keep-docs-open.mjs || true; pkill -f keep-sheets-open.mjs || true'

sudo docker exec -d -w "$CONTAINER_WORKDIR" -e "DOC_URL=${DOCS_URL}" \
  "$PLAYWRIGHT_CONTAINER" \
  bash -lc "node keep-docs-open.mjs > /tmp/keep-docs-open.log 2>&1"
sudo docker exec -d -w "$CONTAINER_WORKDIR" -e "DOC_URL=${SHEETS_URL}" \
  "$PLAYWRIGHT_CONTAINER" \
  bash -lc "node keep-sheets-open.mjs > /tmp/keep-sheets-open.log 2>&1"

echo "[headless-coeditors] launched — tailing logs to keep tmux session open"
sudo docker exec "$PLAYWRIGHT_CONTAINER" bash -lc \
  'touch /tmp/keep-docs-open.log /tmp/keep-sheets-open.log; tail -F /tmp/keep-docs-open.log /tmp/keep-sheets-open.log'
