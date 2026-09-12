#!/usr/bin/env bash
# ============================================================================
# Application rollback — return to the previous application release.
#
#   ./scripts/rollback.sh                → roll back to previous release
#   ./scripts/rollback.sh <commit|tag>   → roll back to a specific revision
#
# POLICY (important):
#   * DATABASE IS NOT DOWNGRADED. Migrations are forward-only; blindly
#     reversing them risks data loss. The pre-deployment backup taken by
#     deploy.sh is the recovery path for data issues:
#         ./scripts/restore.sh <backup-from-.deploy/last-predeploy-backup>
#   * Preferred practice: keep migrations forward-compatible with the
#     previous release (add columns/tables; remove later).
#   * Rollback = checkout previous code + rebuild containers + health check.
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$ROOT_DIR"
resolve_env_file || die ".env not found"
require_docker
have git || die "git is not installed"
[ -d .git ] || die "not a git repository"

DEPLOY_DIR="$ROOT_DIR/.deploy"
CURRENT="$(git rev-parse HEAD)"
CURRENT_SHORT="$(git rev-parse --short HEAD)"

# ── Determine target revision ────────────────────────────────────────────────
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  if [ -f "$DEPLOY_DIR/previous-release.json" ]; then
    TARGET="$(python3 -c 'import json;print(json.load(open("'"$DEPLOY_DIR/previous-release.json"'"))["previous_commit"])' 2>/dev/null || true)"
  fi
  if [ -z "$TARGET" ] || [ "$TARGET" = "none" ]; then
    TARGET="$(git rev-parse HEAD~1 2>/dev/null || true)"
  fi
  [ -n "$TARGET" ] || die "no previous release recorded and no parent commit — cannot roll back"
fi

TARGET_SHORT="$(git rev-parse --short "$TARGET" 2>/dev/null)" || die "unknown revision: $TARGET"
[ "$TARGET_SHORT" = "$CURRENT_SHORT" ] && die "current release IS $CURRENT_SHORT — nothing to roll back"

banner "Rollback — Fleet Fuel System"
echo "Current release : $CURRENT_SHORT"
echo "Target release  : $TARGET_SHORT"

# If a migration ran since the target release, make sure the operator knows.
DEPLOYED_MIGR="$(docker compose -p fleet-fuel --env-file "${ENV_FILE}" exec -T postgres psql -U "$(env_value POSTGRES_USER fleetfuel)" -d "$(env_value POSTGRES_DB fleetfuel)" -tAc "SELECT max(name) FROM pgmigrations" 2>/dev/null | tr -d ' ' || echo '?')"
info "latest applied migration: ${DEPLOYED_MIGR:-?} (database will NOT be downgraded)"

printf "\nProceed with application rollback to %s? [y/N]: " "$TARGET_SHORT"
read -r answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"

# ── Safety backup (data is untouched, but be paranoid) ───────────────────────
if docker compose -p fleet-fuel --env-file "$ENV_FILE" "${COMPOSE_FILE_ARGS[@]}" ps --status running postgres 2>/dev/null | grep -q postgres; then
  info "taking safety database backup ..."
  bash "$SCRIPTS_DIR/backup.sh" >/dev/null || warn "safety backup failed (continuing)"
fi

# ── Stop app services (keep PostgreSQL running) ──────────────────────────────
info "stopping backend + web ..."
compose stop backend web || true

# ── Checkout target revision ─────────────────────────────────────────────────
if [ -n "$(git status --porcelain 2>/dev/null | head -1)" ]; then
  warn "working tree has uncommitted changes — stashing them"
  git stash push --include-untracked --quiet
fi
info "checking out $TARGET_SHORT ..."
git checkout --quiet "$TARGET"

# ── Rebuild + start (migrations run only if target has pending ones) ─────────
export GIT_COMMIT="$TARGET_SHORT"
export GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
export BUILD_DATE="$(date '+%Y-%m-%d %H:%M %Z')"
export APP_VERSION="$(env_value APP_VERSION 1.0.0)"

info "building target release ..."
compose build --quiet backend web

info "starting services ..."
compose up -d --no-deps postgres
compose run --rm --no-deps --entrypoint node backend src/db/migrate.js || warn "migration runner reported an issue — check logs"
compose up -d backend web

# ── Health check ─────────────────────────────────────────────────────────────
info "waiting for health checks ..."
API_PORT_H="$(env_value API_PORT 4000)"
code="000"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT_H}/api/health/ready" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || die "backend failed health check after rollback — inspect: docker compose logs backend"

printf '
{"rollback_from":"%s","rollback_to":"%s","at":"%s"}\n' "$CURRENT_SHORT" "$TARGET_SHORT" "$(date -u +%FT%TZ)" > "$DEPLOY_DIR/last-rollback.json"

printf "\n${C_GREEN}${C_BOLD}Rollback complete${C_OFF}
Running release : %s
Database        : NOT downgraded (forward-only policy)
Pre-deploy data backup (if needed):
  %s
Return to newer release: git checkout <branch> && ./scripts/deploy.sh\n" \
  "$TARGET_SHORT" "$(cat "$DEPLOY_DIR/last-predeploy-backup" 2>/dev/null || echo 'n/a')"
