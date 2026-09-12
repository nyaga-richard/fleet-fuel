#!/usr/bin/env bash
# ============================================================================
# Fleet Fuel Management System — ONE-COMMAND PRODUCTION DEPLOY / UPDATE
#
#   ./scripts/deploy.sh
#
# Update flow (code from GitHub, data from persistent volumes — never lost):
#   checks → record current release → git pull → PRE-DEPLOY BACKUP →
#   build images → start PostgreSQL (wait healthy) → run pending migrations →
#   start backend (wait healthy) → start frontend → cloudflared →
#   health checks → status summary
#
# DATA SAFETY GUARANTEES (enforced by this script's design):
#   * Never runs `docker compose down -v` or any volume-deleting command.
#   * PostgreSQL data lives in the named volume fleetfuel_postgres_data.
#   * A verified database backup is taken BEFORE anything is touched.
#   * Migrations are forward-only and applied within transactions; a failed
#     migration aborts the deployment with old containers still running.
#   * Rollback path: ./scripts/rollback.sh
#
# Useful flags:
#   SKIP_GIT_PULL=1 ./scripts/deploy.sh   # deploy current working tree
#   SKIP_BACKUP=1  ./scripts/deploy.sh    # skip backup (NOT recommended)
#   FORCE=1        ./scripts/deploy.sh    # proceed even with placeholder secrets
# ============================================================================
set -Eeuo pipefail

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$ROOT_DIR"

# ── Step counter ─────────────────────────────────────────────────────────────
TOTAL_STEPS=10
STEP=0
step() { STEP=$((STEP + 1)); printf "\n${C_BOLD}[%d/%d]${C_OFF} %-28s" "$STEP" "$TOTAL_STEPS" "$1"; }
step_ok() { printf " ${C_GREEN}OK${C_OFF}\n"; }
step_fail() { printf " ${C_RED}FAILED${C_OFF}\n"; }

FAILED_STEP=""
TRAP_DONE=0
on_error() {
  local exit_code=$?
  [ $exit_code -eq 0 ] && return 0
  # Re-entry guard: ERR traps are inherited by command-substitution
  # subshells under `set -E`, which would print this banner twice.
  if [ "$TRAP_DONE" = "1" ]; then exit "$exit_code"; fi
  TRAP_DONE=1
  step_fail 2>/dev/null || true
  printf "\n${C_RED}========================================\n DEPLOYMENT FAILED (step %d: %s)\n========================================${C_OFF}\n" "$STEP" "${FAILED_STEP:-unknown}" >&2
  if [ -n "${PREV_BACKUP_FILE:-}" ] && [ -f "$PREV_BACKUP_FILE" ]; then
    printf "Database is INTACT. A pre-deployment backup exists at:\n  %s\nRestore with: ./scripts/restore.sh %s\n" "$PREV_BACKUP_FILE" "$PREV_BACKUP_FILE" >&2
  fi
  printf "Previous containers are still running the OLD release where possible.\nRetry after fixing: ./scripts/deploy.sh\nRollback code: ./scripts/rollback.sh\nLogs: docker compose logs --tail=50\n" >&2
  exit "$exit_code"
}
trap on_error ERR

banner "Fleet Fuel Management System
 Production Deployment"
echo "Started: $(now_stamp)"

# ── Resolve environment ──────────────────────────────────────────────────────
if resolve_env_file; then
  ok "Environment file: $ENV_FILE"
else
  die ".env not found. Copy .env.example to .env (or /opt/fleet-fuel/.env) and configure it."
fi

DEPLOY_DIR="$ROOT_DIR/.deploy"
mkdir -p "$DEPLOY_DIR" || die "cannot create $DEPLOY_DIR"
BACKUP_DIR="$(env_value BACKUP_DIR /opt/fleet-fuel/backups)"
mkdir -p "$BACKUP_DIR" 2>/dev/null || die "cannot create backup directory $BACKUP_DIR (check permissions — deploy must run as a user that can write it)"

# ══ 1/10 Preflight checks ════════════════════════════════════════════════════
FAILED_STEP="preflight checks"
step "Checking prerequisites"
require_docker
have git || die "git is not installed."
# Placeholder-secret guard (production misconfiguration protection).
if [ "$(env_value NODE_ENV production)" = "production" ] && [ "${FORCE:-0}" != "1" ]; then
  for key in JWT_SECRET POSTGRES_PASSWORD; do
    val="$(env_value "$key")"
    if [ -z "$val" ] || [[ "$val" == *CHANGE_THIS* ]]; then
      die "$key is empty or still a placeholder in $ENV_FILE — set a strong secret (openssl rand -hex 32) or FORCE=1"
    fi
  done
fi
# Host port conflict check — fails BEFORE any build/stop, so a busy port
# (another service on this server) can never cause downtime.
check_stack_ports
step_ok

# ══ 2/10 Record current release ══════════════════════════════════════════════
FAILED_STEP="record release"
step "Recording current release"
PREV_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo none)"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$PREV_COMMIT" != "none" ]; then
  printf '{"previous_commit":"%s","previous_branch":"%s","recorded_at":"%s"}\n' \
    "$PREV_COMMIT" "$PREV_BRANCH" "$(date -u +%FT%TZ)" > "$DEPLOY_DIR/previous-release.json"
  ok "$PREV_COMMIT"
else
  warn "not a git repository — skipping"
fi
step_ok

# ══ 3/10 Pull latest code ════════════════════════════════════════════════════
FAILED_STEP="git pull"
step "Pulling latest code"
if [ "${SKIP_GIT_PULL:-0}" = "1" ]; then
  warn "SKIP_GIT_PULL=1 — using working tree as-is"
else
  if [ "$PREV_COMMIT" = "none" ]; then
    warn "not a git repo — skipping"
  else
    git fetch --quiet origin 2>/dev/null || warn "could not reach origin (deploying local HEAD)"
    if git rev-parse --verify --quiet '@{u}' >/dev/null; then
      git pull --ff-only --quiet
    else
      warn "no upstream configured — using local HEAD"
    fi
  fi
fi
NEW_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
NEW_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "        $PREV_COMMIT → $NEW_COMMIT"
step_ok

# ══ 4/10 Pre-deployment backup ═══════════════════════════════════════════════
FAILED_STEP="database backup"
step "Pre-deployment database backup"
PREV_BACKUP_FILE=""
if [ "${SKIP_BACKUP:-0}" = "1" ]; then
  warn "SKIP_BACKUP=1 — backup skipped (NOT recommended)"
else
  if docker compose -p fleet-fuel --env-file "$ENV_FILE" "${COMPOSE_FILE_ARGS[@]}" ps --status running postgres 2>/dev/null | grep -q postgres; then
    # Invoke via `bash` so a lost executable bit on the script can never
    # break a deployment. Stderr stays visible for diagnosis; the explicit
    # file check below reports failures clearly (|| true avoids the ERR
    # trap firing inside the capture).
    PREV_BACKUP_FILE="$(bash "$SCRIPTS_DIR/backup.sh" | tail -1)" || true
    if [ -n "$PREV_BACKUP_FILE" ] && [ -f "$PREV_BACKUP_FILE" ]; then
      echo "        $PREV_BACKUP_FILE"
      printf '%s' "$PREV_BACKUP_FILE" > "$DEPLOY_DIR/last-predeploy-backup"
    else
      die "pre-deployment backup failed — refusing to continue (see the backup error above)"
    fi
  else
    warn "PostgreSQL not running yet (fresh install) — nothing to back up"
  fi
fi
step_ok

# ══ 5/10 Build images ════════════════════════════════════════════════════════
FAILED_STEP="docker build"
step "Building containers"
export GIT_COMMIT="$NEW_SHORT"
export GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
export BUILD_DATE="$(date '+%Y-%m-%d %H:%M %Z')"
export APP_VERSION="$(env_value APP_VERSION "$(git describe --tags --always 2>/dev/null || echo 1.0.0)")"
compose build --quiet
step_ok

# ══ 6/10 Start PostgreSQL ════════════════════════════════════════════════════
FAILED_STEP="start postgres"
step "Starting PostgreSQL (persistent volume)"
compose up -d --no-deps postgres
for i in $(seq 1 30); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q postgres)" 2>/dev/null || echo starting)"
  [ "$health" = "healthy" ] && break
  sleep 2
done
[ "$health" = "healthy" ] || die "PostgreSQL did not become healthy"
step_ok

# ══ 7/10 Run migrations ══════════════════════════════════════════════════════
FAILED_STEP="database migrations"
step "Running pending database migrations"
# --entrypoint skips the container entrypoint so migrations aren't applied
# twice (the entrypoint already runs them on backend startup).
if ! compose run --rm --no-deps --entrypoint node backend src/db/migrate.js; then
  die "migrations failed.
        Most common cause: password authentication failed — the POSTGRES_PASSWORD /
        DATABASE_URL in $ENV_FILE do not match the password the database volume was
        FIRST initialized with (PostgreSQL applies POSTGRES_PASSWORD only on first boot).
        Fix WITHOUT touching data:
          ENV_PASS=\"\$(grep -E '^POSTGRES_PASSWORD=' $ENV_FILE | head -1 | cut -d= -f2- | tr -d '\"')\"
          sudo docker exec fleetfuel-postgres psql -U fleetfuel -d fleetfuel -c \"ALTER USER fleetfuel WITH PASSWORD '\$ENV_PASS';\"
          (if that errors about role/database, run it as: psql -U postgres -d postgres)
        Also confirm the password inside DATABASE_URL equals POSTGRES_PASSWORD,
        then re-run: ./scripts/deploy.sh"
fi
step_ok

# ══ 8/10 Start backend ═══════════════════════════════════════════════════════
FAILED_STEP="start backend"
step "Starting backend API"
compose up -d --no-deps backend
API_PORT_H="$(env_value API_PORT 4000)"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT_H}/api/health/ready" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { docker compose -p fleet-fuel logs --tail 30 backend >&2 || true; die "backend failed its readiness check"; }
step_ok

# ══ 9/10 Start frontend ══════════════════════════════════════════════════════
FAILED_STEP="start frontend"
step "Starting web frontend"
compose up -d --no-deps web
WEB_PORT_H="$(env_value WEB_PORT 3000)"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT_H}/api/health" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { docker compose -p fleet-fuel logs --tail 30 web >&2 || true; die "frontend failed its health check"; }
step_ok

# ══ 10/10 Cloudflare Tunnel ═══════════════════════════════════════════════════
FAILED_STEP="cloudflare tunnel"
step "Cloudflare Tunnel"
TUNNEL_TOKEN="$(env_value CLOUDFLARE_TUNNEL_TOKEN)"
if [ -n "$TUNNEL_TOKEN" ] && [[ "$TUNNEL_TOKEN" != *CHANGE_THIS* ]] && [ "$TUNNEL_TOKEN" != "MISSING" ]; then
  # --profile must come BEFORE the subcommand: `docker compose up --profile`
  # is rejected ("unknown flag") on several Compose versions, while the
  # top-level form `docker compose --profile X up` works everywhere.
  docker compose -p fleet-fuel --env-file "$ENV_FILE" "${COMPOSE_FILE_ARGS[@]}" \
    --profile tunnel up -d --no-deps cloudflared
  sleep 3
  if docker logs fleetfuel-cloudflared 2>&1 | tail -20 | grep -q "Registered tunnel connection"; then
    step_ok
  else
    warn "started, but no 'Registered tunnel connection' yet (check: docker logs fleetfuel-cloudflared)"
  fi
else
  warn "CLOUDFLARE_TUNNEL_TOKEN not set — tunnel not started (web/API reachable on localhost only)"
fi

# ── Record deployment state ──────────────────────────────────────────────────
printf '{"commit":"%s","short":"%s","branch":"%s","version":"%s","deployed_at":"%s","build_date":"%s","previous_commit":"%s","backup":"%s"}\n' \
  "$NEW_COMMIT" "$NEW_SHORT" "${GIT_BRANCH:-?}" "${APP_VERSION:-?}" "$(date -u +%FT%TZ)" "${BUILD_DATE:-?}" "$PREV_COMMIT" "${PREV_BACKUP_FILE:-none}" \
  > "$DEPLOY_DIR/last-deploy.json"

# Best-effort final health summary — SHOW the checks in deploy output so a
# DEGRADED verdict is never a mystery.
HEALTH="ONLINE"
if ! bash "$SCRIPTS_DIR/healthcheck.sh"; then
  HEALTH="DEGRADED — see failed checks above (or run: sudo bash scripts/healthcheck.sh)"
fi

WEB_DOMAIN="$(env_value WEB_DOMAIN fuel.example.com)"
API_DOMAIN="$(env_value API_DOMAIN api.fuel.example.com)"

printf "\n${C_BOLD}========================================${C_OFF}
${C_GREEN}${C_BOLD} Deployment completed successfully${C_OFF}
${C_BOLD}========================================${C_OFF}

Web:        https://%s
API:        https://%s
Version:    %s (%s)
Commit:     %s
Database:   persistent Docker volume (untouched)
Backup:     %s
Status:     %s
Finished:   %s
" "$WEB_DOMAIN" "$API_DOMAIN" "${APP_VERSION:-?}" "${GIT_BRANCH:-?}" "$NEW_SHORT" "${PREV_BACKUP_FILE:-n/a}" "$HEALTH" "$(now_stamp)"
