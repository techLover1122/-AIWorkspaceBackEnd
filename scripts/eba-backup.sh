#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# eba-backup.sh — one-shot AI-workspace backup → S3
#
# Runs every step, every time, in order:
#   1. Project files  → project.tar.gz (node_modules/.git/etc excluded)
#   2. MSSQL DBs      → live-safe BACKUP DATABASE ... WITH COMPRESSION (.bak)
#   3. Postgres DBs   → pg_dump custom/compressed (.dump)
#   4. Bundle         → eba-backup-<ts>.tar (one archive, staged locally)
#   5. Upload to S3   → with automatic retry + exponential backoff
#   6. Delete local   → only AFTER a successful upload (else keep it)
#   7. Prune S3       → delete objects older than RETENTION_HOURS (24h)
#
# Presentation: colored step output + an animated spinner on long steps, but
# ONLY when stdout is a real terminal. When piped (e.g. run by the /api/backup
# endpoint), it auto-degrades to plain lines so the SSE log stays clean — no
# escape codes, no spinner noise.
#
# DB credentials are read INSIDE the containers at runtime — never printed.
#
# Usage:   eba-backup.sh [PROJECT_DIR]
# Config:  all values below are overridable via environment variables.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
SECONDS=0

# ---- Config (env-overridable) ----
PROJECT_DIR="${PROJECT_DIR:-${1:-}}"
S3_BUCKET="${S3_BUCKET:-ai-workspace-eba-backups-666127453599-eu-north-1}"
S3_PREFIX="${S3_PREFIX:-backups}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
RETENTION_HOURS="${RETENTION_HOURS:-24}"
MAX_RETRIES="${MAX_RETRIES:-5}"

MSSQL_CONTAINER="${MSSQL_CONTAINER:-mssql2022}"
# MSSQL is OFF by default (the MAES_HS_CVBA_LIVE DB is large legacy data we skip).
# Opt in by setting MSSQL_DBS="DB1 DB2" in the environment.
MSSQL_DBS="${MSSQL_DBS:-}"                         # space-separated; empty = skip

PG_CONTAINER="${PG_CONTAINER:-ai-ide-odoo-db}"
PG_USER="${PG_USER:-odoo}"
PG_DBS="${PG_DBS:-}"                               # space-separated; auto-detect if empty

STAGING_ROOT="${STAGING_ROOT:-/home/ubuntu/.ai-ide/backup-staging}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$STAGING_ROOT/$TS"
ARCHIVE="$STAGING_ROOT/eba-backup-$TS.tar"
KEY="$S3_PREFIX/eba-backup-$TS.tar"
STEP_LOG="$WORK/.step.log"

TAR_EXCLUDES=(--exclude=node_modules --exclude=.git --exclude=dist --exclude=build
  --exclude=.next --exclude=.cache --exclude=venv --exclude=.venv
  --exclude=__pycache__ --exclude=target --exclude=.ai-ide)

# ---- AWS credentials fallback ----
# Creds live under the ubuntu user's home. If this script is run as another
# user (e.g. root via `sudo -i`) whose own ~/.aws is empty, fall back to
# ubuntu's so the S3 upload/prune still authenticate. An explicit
# AWS_SHARED_CREDENTIALS_FILE / instance role / env creds always win.
if [ -z "${AWS_SHARED_CREDENTIALS_FILE:-}" ] \
   && [ -z "${AWS_ACCESS_KEY_ID:-}" ] \
   && [ ! -f "${HOME:-/root}/.aws/credentials" ] \
   && [ -f /home/ubuntu/.aws/credentials ]; then
  export AWS_SHARED_CREDENTIALS_FILE=/home/ubuntu/.aws/credentials
  export AWS_CONFIG_FILE=/home/ubuntu/.aws/config
fi

# ─────────────────────────────────────────────────────────────────────────────
# Presentation — colors + spinner, auto-off when stdout is not a TTY
# ─────────────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RESET=$'\e[0m'; BOLD=$'\e[1m'; DIM=$'\e[2m'
  RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BLUE=$'\e[34m'; MAGENTA=$'\e[35m'; CYAN=$'\e[36m'
  TTY=1
else
  RESET=; BOLD=; DIM=; RED=; GREEN=; YELLOW=; BLUE=; MAGENTA=; CYAN=
  TTY=0
fi

log()   { echo "${DIM}[$(date -u +%H:%M:%S)]${RESET} $*"; }
step()  { echo "${BOLD}${CYAN}▸ $*${RESET}"; }
ok()    { echo "  ${GREEN}✓${RESET} $*"; }
detail(){ echo "  ${DIM}$*${RESET}"; }
warnln(){ echo "  ${YELLOW}⚠ $*${RESET}"; }
fail()  { echo "${RED}✗ ERROR: $*${RESET}" >&2; exit 1; }

# Restore the cursor if we get interrupted mid-spin (TTY only).
[ "$TTY" = 1 ] && trap 'printf "\e[?25h" 2>/dev/null || true' EXIT

# spin_wait <pid> <message> — animate a braille spinner while pid runs (TTY
# only), then return that process's exit code. On a pipe it just waits quietly.
SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
spin_wait() {
  local pid=$1 msg=$2
  if [ "$TTY" = 1 ]; then
    local i=0
    printf "\e[?25l"                                    # hide cursor
    while kill -0 "$pid" 2>/dev/null; do
      i=$(( (i + 1) % ${#SPIN_FRAMES[@]} ))
      printf "\r  ${CYAN}%s${RESET} ${DIM}%s${RESET}" "${SPIN_FRAMES[$i]}" "$msg"
      sleep 0.1
    done
    printf "\r\e[K"                                     # clear the spinner line
    printf "\e[?25h"                                    # show cursor
  fi
  wait "$pid"
}

# finish_step <pid> <spinner msg> <fail msg> — spin, and on failure surface the
# captured step log then abort.
finish_step() {
  local pid=$1 spinmsg=$2 failmsg=$3
  if ! spin_wait "$pid" "$spinmsg"; then
    echo "${RED}✗ ERROR: $failmsg${RESET}" >&2
    [ -s "$STEP_LOG" ] && tail -20 "$STEP_LOG" | sed 's/^/    │ /' >&2
    exit 1
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
echo "${BOLD}${MAGENTA}╔═══ EBA workspace backup ═══╗${RESET}"
log "target → ${BOLD}s3://$S3_BUCKET/$KEY${RESET}"
mkdir -p "$WORK" || fail "cannot create staging dir $WORK"

# ---- Step 1: project files ----
if [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR" ]; then
  step "Step 1/7 · project snapshot ${DIM}($PROJECT_DIR)${RESET}"
  ( tar "${TAR_EXCLUDES[@]}" -czf "$WORK/project.tar.gz" -C "$PROJECT_DIR" . >"$STEP_LOG" 2>&1 ) &
  finish_step $! "compressing project files…" "project tar failed"
  ok "project.tar.gz = ${BOLD}$(du -h "$WORK/project.tar.gz" | cut -f1)${RESET}"
else
  step "Step 1/7 · project snapshot"
  detail "no valid PROJECT_DIR — skipping project files"
fi

# ---- Step 2: MSSQL databases (live-safe, compressed) ----
for DB in $MSSQL_DBS; do
  step "Step 2/7 · MSSQL backup ${BOLD}[$DB]${RESET}"
  docker exec "$MSSQL_CONTAINER" mkdir -p /var/opt/mssql/backup || fail "mssql: mkdir backup dir"
  # Password is expanded INSIDE the container (escaped \$) — never exposed here.
  ( docker exec "$MSSQL_CONTAINER" bash -lc "S=\$(ls /opt/mssql-tools*/bin/sqlcmd | head -1); \"\$S\" -S localhost -U sa -P \"\${MSSQL_SA_PASSWORD:-\$SA_PASSWORD}\" -C -b -Q \"BACKUP DATABASE [$DB] TO DISK='/var/opt/mssql/backup/$DB.bak' WITH COMPRESSION, INIT, FORMAT\"" >"$STEP_LOG" 2>&1 ) &
  finish_step $! "backing up MSSQL $DB…" "mssql: BACKUP DATABASE [$DB] failed"
  ( docker cp "$MSSQL_CONTAINER:/var/opt/mssql/backup/$DB.bak" "$WORK/mssql_$DB.bak" >"$STEP_LOG" 2>&1 ) &
  finish_step $! "copying $DB.bak out of container…" "mssql: docker cp [$DB] failed"
  docker exec "$MSSQL_CONTAINER" rm -f "/var/opt/mssql/backup/$DB.bak"
  ok "mssql_$DB.bak = ${BOLD}$(du -h "$WORK/mssql_$DB.bak" | cut -f1)${RESET}"
done

# ---- Step 3: Postgres databases (custom/compressed dump) ----
if [ -z "$PG_DBS" ]; then
  PG_DBS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -Atc \
    "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres';" \
    2>/dev/null | tr '\n' ' ')"
fi
for DB in $PG_DBS; do
  [ -z "$DB" ] && continue
  step "Step 3/7 · Postgres backup ${BOLD}[$DB]${RESET}"
  # stdout = dump data → the .dump file; stderr → the step log.
  ( docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$DB" -Fc >"$WORK/pg_$DB.dump" 2>"$STEP_LOG" ) &
  finish_step $! "dumping $DB…" "postgres: pg_dump [$DB] failed"
  ok "pg_$DB.dump = ${BOLD}$(du -h "$WORK/pg_$DB.dump" | cut -f1)${RESET}"
done

# ---- Step 4: bundle into one archive ----
step "Step 4/7 · bundle archive"
( tar -cf "$ARCHIVE" -C "$WORK" --exclude=.step.log . >"$STEP_LOG" 2>&1 ) &
finish_step $! "bundling…" "bundle tar failed"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
ok "archive = ${BOLD}$SIZE${RESET}"

# ---- Step 5: upload to S3 with retry ----
step "Step 5/7 · upload to S3 ${DIM}(up to $MAX_RETRIES attempts)${RESET}"
uploaded=0
for ((n=1; n<=MAX_RETRIES; n++)); do
  ( aws s3 cp "$ARCHIVE" "s3://$S3_BUCKET/$KEY" --region "$AWS_REGION" --only-show-errors >"$STEP_LOG" 2>&1 ) &
  if spin_wait $! "uploading $SIZE (attempt $n/$MAX_RETRIES)…"; then
    uploaded=1; ok "upload OK ${DIM}(attempt $n)${RESET}"; break
  fi
  backoff=$(( 2 ** n ))
  warnln "upload failed (attempt $n/$MAX_RETRIES) — retrying in ${backoff}s"
  [ -s "$STEP_LOG" ] && tail -5 "$STEP_LOG" | sed 's/^/    │ /' >&2
  sleep "$backoff"
done
if [ "$uploaded" -ne 1 ]; then
  fail "upload failed after $MAX_RETRIES attempts — KEEPING local $ARCHIVE for retry"
fi

# ---- Step 6: delete local staging (only after a successful upload) ----
step "Step 6/7 · delete local staging"
rm -rf "$WORK" "$ARCHIVE"
ok "local staging cleaned"

# ---- Step 7: prune S3 objects older than RETENTION_HOURS ----
step "Step 7/7 · prune S3 older than ${RETENTION_HOURS}h"
CUTOFF=$(( $(date -u +%s) - RETENTION_HOURS * 3600 ))
pruned=0
while read -r OKEY OLM; do
  [ -z "$OKEY" ] && continue
  OEPOCH="$(date -u -d "$OLM" +%s 2>/dev/null || echo 0)"
  if [ "$OEPOCH" -gt 0 ] && [ "$OEPOCH" -lt "$CUTOFF" ]; then
    if aws s3 rm "s3://$S3_BUCKET/$OKEY" --region "$AWS_REGION" --only-show-errors; then
      pruned=$(( pruned + 1 )); detail "pruned $OKEY"
    fi
  fi
done < <(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$S3_PREFIX/" \
  --region "$AWS_REGION" --query "Contents[].[Key,LastModified]" --output text 2>/dev/null)
ok "pruned $pruned old object(s)"

echo "${BOLD}${GREEN}╚═══ DONE ✓  ${SIZE}  in ${SECONDS}s  →  s3://$S3_BUCKET/$KEY ═══╝${RESET}"
