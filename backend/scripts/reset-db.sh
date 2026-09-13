#!/usr/bin/env bash
# ============================================================================
# reset-db.sh — OPERATOR-ONLY manual tool: wipe ALL data and start clean.
#
# ⚠  DESTRUCTIVE: deletes every user, vehicle, tank, pump, request,
#    transaction, LEDGER entry and AUDIT record. The only way back is the
#    timestamped pg_dump backup this script writes first (backups/*.dump).
#
# Policy guarantees (project constraints):
#   - NEVER invoked by deploy, startup, containers or CI. An operator must
#     run it by hand, deliberately.
#   - Always creates a pre-reset backup first (unless --no-backup).
#   - Migrations are re-applied FORWARD only — never `--down`, never a blind
#     reverse.
#   - The admin account comes from ENV_FILE (SEED_ADMIN_EMAIL /
#     SEED_ADMIN_PASSWORD); in production the seed refuses a default
#     password, so set a real SEED_ADMIN_PASSWORD before resetting prod.
#
# Usage (from backend/):
#   ENV_FILE=.env npm run db:reset                 # interactive confirmation
#   ENV_FILE=.env npm run db:reset -- --yes        # non-interactive
#   ENV_FILE=.env npm run db:reset -- --bare --yes # admin ONLY — also removes
#                                                  # the seeded Diesel/Petrol
#                                                  # reference fuel types
#   --no-backup  skip the pg_dump safety backup (strongly discouraged)
#
# After a reset: log in as the seeded admin, create fuel types / tanks /
# pumps / vehicles / staff users in the web console, and CLEAR APP DATA or
# reinstall the mobile app on every device (their local caches and outbox
# still reference the old data otherwise).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
ASSUME_YES=0; BARE=0; NO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --bare) BARE=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    *) echo "✘ Unknown flag: $arg (supported: --yes --bare --no-backup)"; exit 1 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "✘ ENV_FILE not found: $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL must be set in $ENV_FILE}"

MASKED="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:@/]+:)[^@]*@#\1***@#')"
echo "── Fleet Fuel — DATABASE RESET ──────────────────────────────"
echo "  target : $MASKED"
echo "  mode   : $([ "$BARE" -eq 1 ] && echo 'bare (admin user ONLY)' || echo 'admin + Diesel/Petrol reference fuel types')"

if [ "$ASSUME_YES" -ne 1 ]; then
  echo "  ⚠  This permanently deletes ALL data — ledger, transactions,"
  echo "     requests, audit history and every user account."
  printf '  Type RESET to continue (anything else aborts): '
  read -r reply
  [ "$reply" = "RESET" ] || { echo "Aborted — nothing was changed."; exit 1; }
fi

# ── 1. Safety backup ─────────────────────────────────────────────────────────
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="backups/pre-reset-$STAMP.dump"
if [ "$NO_BACKUP" -eq 1 ]; then
  echo "⚠  --no-backup given — continuing WITHOUT a safety backup"
elif command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" -Fc -f "$BACKUP"
  echo "✔ pre-reset backup: $BACKUP"
else
  echo "✘ pg_dump not found — install postgresql-client (recommended), or"
  echo "  re-run with --no-backup if you truly want no backup."
  exit 1
fi

# ── 2. Drop all objects, recreate empty schema ───────────────────────────────
# Safe: migrations use the built-in gen_random_uuid(); no extensions live in
# the public schema, so nothing else needs preserving.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
echo "✔ schema dropped and recreated"

# ── 3. Re-apply all migrations (forward only) ────────────────────────────────
npm run --silent migrate

# ── 4. Seed the single admin (demo tank/pump/vehicle skipped) ────────────────
SEED_DEMO_DATA=false npm run --silent seed

# ── 5. --bare: also drop the Diesel/Petrol reference rows ────────────────────
if [ "$BARE" -eq 1 ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DELETE FROM fuel_types;'
  echo "✔ reference fuel types removed (--bare)"
fi

# ── 6. Verification summary ──────────────────────────────────────────────────
echo "── Result ───────────────────────────────────────────────────"
psql "$DATABASE_URL" -t -c "
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
echo "Next: log in as the seeded admin (change the password), set up master"
echo "data, and clear app data / reinstall the app on all devices."
