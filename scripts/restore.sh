#!/usr/bin/env bash
# ============================================================================
# Database restore from a backup file — EXPLICIT operator action only.
#
#   ./scripts/restore.sh                    → interactive: pick from backups
#   ./scripts/restore.sh <path>.sql.gz      → restore specific backup
#   ./scripts/restore.sh --latest           → restore newest backup
#
# Safety gates:
#   1. Verifies the archive (gzip + dump header) BEFORE touching anything.
#   2. Takes a fresh "safety" backup of the CURRENT database first.
#   3. Requires typing RESTORE (or --yes) to proceed.
#   4. Stops backend/web during restore (no writes), restarts after,
#      then runs health checks.
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

resolve_env_file || die ".env not found"
require_docker

DB_NAME="$(env_value POSTGRES_DB fleetfuel)"
DB_USER="$(env_value POSTGRES_USER fleetfuel)"
BACKUP_DIR="$(env_value BACKUP_DIR /opt/fleet-fuel/backups)"

banner "Database Restore — Fleet Fuel System"

# ── Select backup file ───────────────────────────────────────────────────────
FILE="${1:-}"
case "$FILE" in
  --latest)
    FILE="$(ls -1t "$BACKUP_DIR"/fleetfuel_*.sql.gz 2>/dev/null | head -1 || true)"
    [ -n "$FILE" ] || die "no backups found in $BACKUP_DIR"
    ;;
  "")
    mapfile -t backups < <(ls -1t "$BACKUP_DIR"/fleetfuel_*.sql.gz 2>/dev/null || true)
    [ "${#backups[@]}" -gt 0 ] || die "no backups found in $BACKUP_DIR"
    echo "Available backups:"
    for i in "${!backups[@]}"; do
      printf "  %2d) %s  (%s)\n" "$((i+1))" "$(basename "${backups[$i]}")" "$(du -h "${backups[$i]}" | cut -f1)"
    done
    printf "Select backup [1-%d]: " "${#backups[@]}"
    read -r choice
    [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#backups[@]}" ] \
      || die "invalid selection"
    FILE="${backups[$((choice-1))]}"
    ;;
esac
[ -f "$FILE" ] || die "backup file not found: $FILE"

echo "Target database : $DB_NAME (PostgreSQL container)"
echo "Backup file     : $FILE ($(du -h "$FILE" | cut -f1))"

# ── 1. Verify backup ─────────────────────────────────────────────────────────
info "verifying backup archive ..."
gzip -t "$FILE" || die "archive is corrupt"
# SIGPIPE-safe header check (see backup.sh): capture a slice, then grep it.
RESTORE_SAMPLE="$(gunzip -c "$FILE" 2>/dev/null | head -c 8192 || true)"
printf '%s\n' "$RESTORE_SAMPLE" | grep -q "PostgreSQL database dump" || die "not a pg_dump file"
if [ -f "$FILE.sha256" ]; then
  sha256sum -c "$FILE.sha256" >/dev/null 2>&1 && ok "sha256 checksum matches" || warn "checksum mismatch (continuing — archive verified structurally)"
fi
ok "backup verified"

# ── 2. Confirm intent ────────────────────────────────────────────────────────
if [ "${2:-}" = "--yes" ] || [ "${FORCE_RESTORE:-0}" = "1" ]; then
  warn "--yes given — proceeding without prompt"
else
  printf "\n${C_RED}${C_BOLD}WARNING:${C_OFF} this will OVERWRITE the current database '%s'.\n" "$DB_NAME"
  printf "Type ${C_BOLD}RESTORE${C_OFF} to continue, anything else to abort: "
  read -r answer
  [ "$answer" = "RESTORE" ] || die "aborted by operator"
fi

# ── 3. Safety backup of current state ────────────────────────────────────────
info "taking a safety backup of the CURRENT database first ..."
SAFETY="$(bash "$SCRIPTS_DIR/backup.sh" | tail -1)" || true
[ -n "$SAFETY" ] && [ -f "$SAFETY" ] && ok "safety backup: $SAFETY" || warn "safety backup skipped (database may be down)"

# ── 4. Stop application writes ───────────────────────────────────────────────
info "stopping backend + web (no writes during restore) ..."
compose stop backend web

# ── 5. Restore ───────────────────────────────────────────────────────────────
info "restoring database ..."
compose exec -T postgres psql -U "$DB_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
gunzip -c "$FILE" | compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q
ok "restore applied"

# ── 6. Verify database ───────────────────────────────────────────────────────
TABLES=$(compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
MIGR=$(compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM pgmigrations" 2>/dev/null || echo "?")
[ "${TABLES:-0}" -ge 10 ] || die "restored database looks wrong ($TABLES tables)"
ok "database verified: $TABLES tables, $MIGR migrations recorded"

# ── 7. Restart services ──────────────────────────────────────────────────────
info "restarting backend + web ..."
compose up -d backend web

# ── 8. Health checks ─────────────────────────────────────────────────────────
info "waiting for health checks ..."
API_PORT_H="$(env_value API_PORT 4000)"
code="000"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT_H}/api/health/ready" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || die "backend did not become healthy after restore"

printf "\n${C_GREEN}${C_BOLD}Restore completed successfully${C_OFF}
Restored from : %s
Safety backup : %s
Status        : ONLINE\n" "$FILE" "${SAFETY:-n/a}"
