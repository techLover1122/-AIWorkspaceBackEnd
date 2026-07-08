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
# DB credentials are read INSIDE the containers at runtime — they are never
# printed and never leave the box.
#
# Usage:   eba-backup.sh [PROJECT_DIR]
# Config:  all values below are overridable via environment variables.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

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

TAR_EXCLUDES=(--exclude=node_modules --exclude=.git --exclude=dist --exclude=build
  --exclude=.next --exclude=.cache --exclude=venv --exclude=.venv
  --exclude=__pycache__ --exclude=target --exclude=.ai-ide)

log()  { echo "[eba-backup $(date -u +%H:%M:%S)] $*"; }
fail() { log "ERROR: $*"; exit 1; }

log "START backup $TS → s3://$S3_BUCKET/$KEY"
mkdir -p "$WORK" || fail "cannot create staging dir $WORK"

# ---- Step 1: project files ----
if [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR" ]; then
  log "Step 1: project snapshot ($PROJECT_DIR)"
  tar "${TAR_EXCLUDES[@]}" -czf "$WORK/project.tar.gz" -C "$PROJECT_DIR" . \
    || fail "project tar failed"
  log "  project.tar.gz = $(du -h "$WORK/project.tar.gz" | cut -f1)"
else
  log "Step 1: no valid PROJECT_DIR — skipping project files"
fi

# ---- Step 2: MSSQL databases (live-safe, compressed) ----
for DB in $MSSQL_DBS; do
  log "Step 2: MSSQL backup [$DB]"
  docker exec "$MSSQL_CONTAINER" mkdir -p /var/opt/mssql/backup || fail "mssql: mkdir backup dir"
  # Password is expanded INSIDE the container (escaped \$) — never exposed here.
  docker exec "$MSSQL_CONTAINER" bash -lc "S=\$(ls /opt/mssql-tools*/bin/sqlcmd | head -1); \"\$S\" -S localhost -U sa -P \"\${MSSQL_SA_PASSWORD:-\$SA_PASSWORD}\" -C -b -Q \"BACKUP DATABASE [$DB] TO DISK='/var/opt/mssql/backup/$DB.bak' WITH COMPRESSION, INIT, FORMAT\"" \
    || fail "mssql: BACKUP DATABASE [$DB] failed"
  docker cp "$MSSQL_CONTAINER:/var/opt/mssql/backup/$DB.bak" "$WORK/mssql_$DB.bak" \
    || fail "mssql: docker cp [$DB] failed"
  docker exec "$MSSQL_CONTAINER" rm -f "/var/opt/mssql/backup/$DB.bak"
  log "  mssql_$DB.bak = $(du -h "$WORK/mssql_$DB.bak" | cut -f1)"
done

# ---- Step 3: Postgres databases (custom/compressed dump) ----
if [ -z "$PG_DBS" ]; then
  PG_DBS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -Atc \
    "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres';" \
    2>/dev/null | tr '\n' ' ')"
fi
for DB in $PG_DBS; do
  [ -z "$DB" ] && continue
  log "Step 3: Postgres backup [$DB]"
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$DB" -Fc > "$WORK/pg_$DB.dump" \
    || fail "postgres: pg_dump [$DB] failed"
  log "  pg_$DB.dump = $(du -h "$WORK/pg_$DB.dump" | cut -f1)"
done

# ---- Step 4: bundle into one archive ----
log "Step 4: bundle → $(basename "$ARCHIVE")"
tar -cf "$ARCHIVE" -C "$WORK" . || fail "bundle tar failed"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
log "  archive = $SIZE"

# ---- Step 5: upload to S3 with retry ----
log "Step 5: upload → s3://$S3_BUCKET/$KEY (up to $MAX_RETRIES attempts)"
uploaded=0
for ((n=1; n<=MAX_RETRIES; n++)); do
  if aws s3 cp "$ARCHIVE" "s3://$S3_BUCKET/$KEY" --region "$AWS_REGION" --only-show-errors; then
    uploaded=1; log "  upload OK (attempt $n)"; break
  fi
  backoff=$(( 2 ** n ))
  log "  upload failed (attempt $n/$MAX_RETRIES) — retrying in ${backoff}s"
  sleep "$backoff"
done
if [ "$uploaded" -ne 1 ]; then
  fail "upload failed after $MAX_RETRIES attempts — KEEPING local $ARCHIVE for retry"
fi

# ---- Step 6: delete local staging (only after successful upload) ----
log "Step 6: delete local staging"
rm -rf "$WORK" "$ARCHIVE"

# ---- Step 7: prune S3 objects older than RETENTION_HOURS ----
log "Step 7: prune s3://$S3_BUCKET/$S3_PREFIX/ older than ${RETENTION_HOURS}h"
CUTOFF=$(( $(date -u +%s) - RETENTION_HOURS * 3600 ))
pruned=0
while read -r OKEY OLM; do
  [ -z "$OKEY" ] && continue
  OEPOCH="$(date -u -d "$OLM" +%s 2>/dev/null || echo 0)"
  if [ "$OEPOCH" -gt 0 ] && [ "$OEPOCH" -lt "$CUTOFF" ]; then
    if aws s3 rm "s3://$S3_BUCKET/$OKEY" --region "$AWS_REGION" --only-show-errors; then
      pruned=$(( pruned + 1 )); log "  pruned $OKEY"
    fi
  fi
done < <(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$S3_PREFIX/" \
  --region "$AWS_REGION" --query "Contents[].[Key,LastModified]" --output text 2>/dev/null)
log "  pruned $pruned old object(s)"

log "DONE ✓  s3://$S3_BUCKET/$KEY ($SIZE)"
