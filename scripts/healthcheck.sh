#!/usr/bin/env bash
# ============================================================================
# Full health check — exits non-zero if anything important is broken.
#   ./scripts/healthcheck.sh
# Used by deploy.sh (final gate), CI, and operators.
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

FAILURES=0
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf "  %-28s ${C_GREEN}OK${C_OFF}\n" "$label"
  else
    printf "  %-28s ${C_RED}FAILED${C_OFF}\n" "$label"
    FAILURES=$((FAILURES + 1))
  fi
}

resolve_env_file || { echo "healthcheck: .env not found"; exit 1; }
# The env file is chmod 600 root-owned by design. Without sudo, ports/creds
# would silently fall back to defaults (and docker compose couldn't read the
# file), producing results about the WRONG services. Refuse to guess.
if [ ! -r "$ENV_FILE" ]; then
  echo "healthcheck: $ENV_FILE is not readable by user '$(id -un)' — re-run with sudo:"
  echo "  sudo ./scripts/healthcheck.sh"
  exit 2
fi
API_PORT_H="$(env_value API_PORT 4000)"
WEB_PORT_H="$(env_value WEB_PORT 3000)"

echo "Fleet Fuel System — Health Check ($(now_stamp))"

check "docker daemon"          docker info
# Container checks use docker NAMES directly (no compose/env dependency).
check "postgres container"     bash -c "[ \"\$(docker inspect --format '{{.State.Health.Status}}' fleetfuel-postgres 2>/dev/null)\" = 'healthy' ]"
check "postgres accepts conns" docker exec fleetfuel-postgres pg_isready -U "$(env_value POSTGRES_USER fleetfuel)" -d "$(env_value POSTGRES_DB fleetfuel)"
check "backend container"      docker inspect fleetfuel-backend
check "backend /api/health"    curl -sf "http://127.0.0.1:${API_PORT_H}/api/health"
check "backend db connected"   bash -c "curl -sf http://127.0.0.1:${API_PORT_H}/api/health | grep -q '\"database\":\"connected\"'"
check "web container"          docker inspect fleetfuel-web
check "web health endpoint"    curl -sf "http://127.0.0.1:${WEB_PORT_H}/api/health"

if docker ps --format '{{.Names}}' | grep -q '^fleetfuel-cloudflared$'; then
  check "cloudflared registered" bash -c "docker logs fleetfuel-cloudflared 2>&1 | tail -50 | grep -q 'Registered tunnel connection'"
else
  printf "  %-28s ${C_YELLOW}SKIPPED (tunnel not configured)${C_OFF}\n" "cloudflared"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf "${C_GREEN}ALL CHECKS PASSED${C_OFF}\n"
  exit 0
else
  printf "${C_RED}%s CHECK(S) FAILED${C_OFF}\n" "$FAILURES"
  exit 1
fi
