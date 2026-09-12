#!/usr/bin/env bash
# ============================================================================
# Shared helpers for Fleet Fuel deployment scripts. Sourced, not executed.
# ============================================================================

# ── Locate repo root (scripts live in <root>/scripts) ───────────────────────
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"

# ── Colors (disabled when not a TTY) ────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'
  C_BLUE='\033[0;34m'; C_CYAN='\033[0;36m'; C_BOLD='\033[1m'; C_OFF='\033[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''; C_BOLD=''; C_OFF=''
fi
info()  { printf "${C_BLUE}[i]${C_OFF} %s\n" "$*"; }
ok()    { printf "${C_GREEN}[✓]${C_OFF} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}[!]${C_OFF} %s\n" "$*"; }
fail()  { printf "${C_RED}[✗]${C_OFF} %s\n" "$*" >&2; }
die()   { fail "$*"; exit 1; }
banner() {
  printf "${C_BOLD}========================================\n %s\n========================================${C_OFF}\n" "$*"
}

# ── Environment file resolution ─────────────────────────────────────────────
# Priority: $FLEET_ENV_FILE → /opt/fleet-fuel/.env → repo .env
resolve_env_file() {
  if [ -n "${FLEET_ENV_FILE:-}" ] && [ -f "$FLEET_ENV_FILE" ]; then
    ENV_FILE="$FLEET_ENV_FILE"
  elif [ -f /opt/fleet-fuel/.env ]; then
    ENV_FILE=/opt/fleet-fuel/.env
  elif [ -f "$ROOT_DIR/.env" ]; then
    ENV_FILE="$ROOT_DIR/.env"
  else
    return 1
  fi
  # Apply TZ from env file for consistent log/backup timestamps.
  local tz
  tz=$(grep -E '^TZ=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)
  if [ -n "$tz" ]; then export TZ="$tz"; fi
  return 0
}

# Read a scalar value from the env file (does not export secrets).
env_value() { # env_value KEY [default]
  local v
  v=$(grep -E "^$1=" "${ENV_FILE:?}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  echo "${v:-${2:-}}"
}

# ── Docker Compose wrapper (fixed project name + env file + prod override) ──
COMPOSE_FILE_ARGS=(-f "$ROOT_DIR/docker-compose.yml")
if [ -f "$ROOT_DIR/docker-compose.prod.yml" ] && [ "${FLEET_SKIP_PROD_OVERRIDE:-0}" != "1" ]; then
  COMPOSE_FILE_ARGS+=(-f "$ROOT_DIR/docker-compose.prod.yml")
fi
compose() {
  docker compose -p fleet-fuel --env-file "${ENV_FILE:?env file required}" \
    "${COMPOSE_FILE_ARGS[@]}" "$@"
}

# ── Misc ────────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

require_docker() {
  have docker || die "Docker is not installed. Run ./scripts/install.sh first."
  docker info >/dev/null 2>&1 || die "Docker daemon is not running (try: sudo systemctl start docker)."
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is not installed. Run ./scripts/install.sh first."
}

now_stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }

# ── Host port conflict detection ────────────────────────────────────────────
# True if the port is currently published by a container of THIS stack
# (i.e. we put it there — normal during updates).
port_held_by_our_stack() {
  have docker || return 1
  docker ps --filter "label=com.docker.compose.project=fleet-fuel" \
    --format '{{.Ports}}' 2>/dev/null | grep -q ":${1}->"
}

# True if something accepts TCP connections on that port (localhost scan).
port_listening() {
  local p="$1"
  if have ss; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null
  fi
}

# Fails with clear guidance if a configured HOST port is occupied by another
# service. Runs BEFORE anything is built or stopped, so a conflict can never
# cause downtime. Only HOST ports are configurable — container-internal ports
# live in isolated network namespaces and never conflict.
check_stack_ports() {
  local entry name port var
  # name:host-port:env-var  (defaults match docker-compose.yml)
  for entry in \
    "PostgreSQL:$(env_value POSTGRES_PORT 5432):POSTGRES_PORT" \
    "Backend API:$(env_value API_PORT 4000):API_PORT" \
    "Web frontend:$(env_value WEB_PORT 3000):WEB_PORT"; do
    name="${entry%%:*}"
    var="${entry##*:}"
    port="${entry#*:}"; port="${port%%:*}"
    if port_held_by_our_stack "$port"; then
      ok "$name host port ${port}: in use by this stack (update run)"
      continue
    fi
    if port_listening "$port"; then
      die "Host port ${port} (${name}) is already used by ANOTHER service on this server.
        → Edit the env file:  set ${var}=<a free port>
        → Then re-run this script. Nothing was modified yet.
        Note: only the HOST port changes. Cloudflare Tunnel service URLs
        (http://web:3000, http://backend:4000) and the mobile app URL are
        unaffected. Find the occupying process:  sudo ss -ltnp | grep :${port}"
    fi
    ok "$name host port ${port}: free"
  done
}

# Sanity guard used by deploy/rollback: refuse to run against a broken state.
assert_not_destructive() {
  # This project NEVER allows these patterns in its scripts:
  for pattern in "down -v" "volume prune" "volume rm" "DROP DATABASE" "DROP SCHEMA"; do
    if grep -qs -- "$pattern" "$SCRIPTS_DIR/deploy.sh" "$SCRIPTS_DIR/rollback.sh" 2>/dev/null; then
      # (only fails if found — this line should never trigger)
      die "Safety violation detected in deployment scripts: '$pattern' found"
    fi
  done
}
