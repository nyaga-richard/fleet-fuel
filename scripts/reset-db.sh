#!/usr/bin/env bash
# ============================================================================
# reset-db.sh — OPERATOR-ONLY tool: wipe ALL data and start clean with a
# single admin user. Manual by design; deploy/startup/CI never call this.
#
# ⚠  DESTRUCTIVE: deletes every user, vehicle, tank, pump, request,
#    transaction, LEDGER entry and AUDIT record. The only way back is the
#    pre-reset backup written to $BACKUP_DIR (default /opt/fleet-fuel/backups).
#
# Two modes (auto-detected):
#   docker  — production install. Backup via the postgres container (same
#             mechanism as backup.sh), SQL via psql in that container,
#             migrations + seed inside the backend container.
#   native  — local/dev machine. Uses local pg_dump/psql/npm against
#             DATABASE_URL.
#
# Usage:
#   sudo bash scripts/reset-db.sh                  # interactive (types RESET)
#   sudo bash scripts/reset-db.sh --yes            # non-interactive
#   sudo bash scripts/reset-db.sh --yes --bare     # admin ONLY: also removes
#                                                  # the Diesel/Petrol reference
#                                                  # fuel types
#   --no-backup  skip the safety backup (strongly discouraged)
#
# Dev example (repo checkout, native postgres):
#   FLEET_ENV_FILE=/path/to/.env.dev-test bash scripts/reset-db.sh --yes --bare
#
# AFTER A RESET: log in as the seeded admin, change the password, create
# master data, and CLEAR APP DATA / reinstall the mobile app on every device.
# ============================================================================
set -eu
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ASSUME_YES=0; BARE=0; NO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --bare) BARE=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    *) die "Unknown flag: $arg (supported: --yes --bare --no-backup)" ;;
  esac
done

resolve_env_file || die ".env not found (set FLEET_ENV_FILE or create $ROOT_DIR/.env)"
DB_NAME="$(env_value POSTGRES_DB fleetfuel)"
DB_USER="$(env_value POSTGRES_USER fleetfuel)"
BACKUP_DIR="$(env_value BACKUP_DIR /opt/fleet-fuel/backups)"

# ── Mode detection ───────────────────────────────────────────────────────────
MODE=native
if have docker && docker info >/dev/null 2>&1 \
   && compose ps postgres 2>/dev/null | grep -q running; then
  MODE=docker
fi

# Native mode needs a connection string.
if [ "$MODE" = native ] && [ -z "${DATABASE_URL:-}" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
if [ "$MODE" = native ]; then
  : "${DATABASE_URL:?DATABASE_URL must be set (env file or environment)}"
  have psql     || die "psql not found — install postgresql-client"
  have pg_dump  || die "pg_dump not found — install postgresql-client"
fi

# psql channel: postgres container (docker) or local socket (native).
psql_db() {
  if [ "$MODE" = docker ]; then
    compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" "$@"
  else
    psql "$DATABASE_URL" "$@"
  fi
}

banner "Fleet Fuel — DATABASE RESET"
info "mode    : $MODE"
if [ "$MODE" = docker ]; then
  info "target  : container 'fleetfuel-postgres' db '$DB_NAME'"
else
  MASKED="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:@/]+:)[^@]*@#\1***@#')"
  info "target  : $MASKED"
fi
info "scope   : $([ "$BARE" -eq 1 ] && echo 'bare — admin user ONLY' || echo 'admin + Diesel/Petrol reference fuel types')"

if [ "$ASSUME_YES" -ne 1 ]; then
  warn "This permanently deletes ALL data — ledger, transactions, requests,"
  warn "audit history and every user account."
  printf 'Type RESET to continue (anything else aborts): '
  read -r reply
  [ "$reply" = "RESET" ] || die "Aborted — nothing was changed."
fi

# ── 1. Safety backup (kept OUTSIDE containers, like backup.sh) ───────────────
STAMP="$(date '+%Y-%m-%d_%H%M%S')"
if [ "$NO_BACKUP" -eq 1 ]; then
  warn "--no-backup given — continuing WITHOUT a safety backup"
elif [ "$MODE" = docker ]; then
  mkdir -p "$BACKUP_DIR"
  OUT="$BACKUP_DIR/pre-reset-$STAMP.sql.gz"
  compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges \
    | gzip > "$OUT"
  [ -s "$OUT" ] || die "Backup file is empty — aborting, database NOT modified."
  ok "pre-reset backup: $OUT"
else
  mkdir -p "$ROOT_DIR/backups"
  OUT="$ROOT_DIR/backups/pre-reset-$STAMP.dump"
  pg_dump "$DATABASE_URL" -Fc -f "$OUT"
  [ -s "$OUT" ] || die "Backup file is empty — aborting, database NOT modified."
  ok "pre-reset backup: $OUT"
fi

# ── 2. Drop all objects, recreate empty schema ───────────────────────────────
# Safe: migrations use the built-in gen_random_uuid(); no extensions live in
# the public schema, so nothing else needs preserving.
psql_db -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
ok "schema dropped and recreated"

# ── 3. Re-apply all migrations (forward only — never a blind reverse) ────────
if [ "$MODE" = docker ]; then
  compose exec -T backend npm run --silent migrate
else
  (cd "$ROOT_DIR/backend" && npm run --silent migrate)
fi
ok "migrations applied"

# ── 4. Seed the single admin (demo tank/pump/vehicle skipped) ────────────────
# Production refuses a default SEED_ADMIN_PASSWORD — set a real one in the
# env file BEFORE resetting a production database.
if [ "$MODE" = docker ]; then
  compose exec -T -e SEED_DEMO_DATA=false backend npm run --silent seed
else
  (cd "$ROOT_DIR/backend" && SEED_DEMO_DATA=false npm run --silent seed)
fi

# ── 5. --bare: also drop the Diesel/Petrol reference rows ────────────────────
if [ "$BARE" -eq 1 ]; then
  psql_db -v ON_ERROR_STOP=1 -c 'DELETE FROM fuel_types;' >/dev/null
  ok "reference fuel types removed (--bare)"
fi

# ── 6. Verification summary ──────────────────────────────────────────────────
banner "Result — row counts after reset"
psql_db -t -c "
  SELECT rpad('users', 14) || ': ' || count(*) FROM users
  UNION ALL SELECT rpad('fuel_types', 14) || ': ' || count(*) FROM fuel_types
  UNION ALL SELECT rpad('vehicles', 14) || ': ' || count(*) FROM vehicles
  UNION ALL SELECT rpad('tanks', 14) || ': ' || count(*) FROM tanks
  UNION ALL SELECT rpad('pumps', 14) || ': ' || count(*) FROM pumps
  UNION ALL SELECT rpad('requests', 14) || ': ' || count(*) FROM fuel_requests
  UNION ALL SELECT rpad('transactions', 14) || ': ' || count(*) FROM fuel_transactions
  UNION ALL SELECT rpad('ledger', 14) || ': ' || count(*) FROM inventory_transactions
  UNION ALL SELECT rpad('readings', 14) || ': ' || count(*) FROM pump_readings
  UNION ALL SELECT rpad('audit', 14) || ': ' || count(*) FROM audit_logs
  UNION ALL SELECT rpad('sync_log', 14) || ': ' || count(*) FROM sync_log;"
info "Backup (only way back): $OUT"
info "Next: log in as the seeded admin, change the password, set up master"
info "data, then clear app data / reinstall the app on all devices."
