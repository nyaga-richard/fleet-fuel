#!/bin/sh
# ============================================================================
# Backend container entrypoint
#   1. Wait until PostgreSQL accepts connections
#   2. Apply pending migrations (node-pg-migrate, advisory-locked, idempotent)
#   3. Start the API server (CMD)
# Migrations never drop or reset data. A failed migration aborts startup
# loudly instead of booting against an unexpected schema.
# ============================================================================
set -e

echo "[entrypoint] waiting for database ..."
i=0
until node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.query("SELECT 1")).then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] ERROR: database not reachable after 120s" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] database is reachable"

echo "[entrypoint] applying pending migrations (if any) ..."
node src/db/migrate.js

echo "[entrypoint] starting API ..."
exec "$@"
