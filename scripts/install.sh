#!/usr/bin/env bash
# ============================================================================
# Fleet Fuel Management System — ONE-TIME SERVER INSTALLATION (Ubuntu)
#
#   sudo ./scripts/install.sh --repo https://github.com/ORGANIZATION/fleet-fuel.git
#
# What it does:
#   1. Verifies Ubuntu (Debian accepted with a warning)
#   2. Installs Docker Engine + Compose plugin if missing
#   3. Installs git if missing
#   4. Creates /opt/fleet-fuel/{app,backups,uploads,logs}
#   5. Clones the repository into /opt/fleet-fuel/app
#   6. Generates /opt/fleet-fuel/.env with STRONG RANDOM SECRETS
#   6b. Verifies the configured host ports are free (use the port flags below
#       if other services on this server already use 5432/4000/3000)
#   7. Installs a nightly 02:00 backup cron job
#   8. Runs scripts/deploy.sh (build → migrate → start → health check)
#   9. Offers to seed an administrator on the EMPTY database
#
# Port flags (host ports — see DEPLOY.md Part 5):
#   --web-port 8080  --api-port 8443  --postgres-port 15432
#
# Non-interactive example:
#   sudo ./scripts/install.sh \
#     --repo https://github.com/ORG/fleet-fuel.git \
#     --domain fuel.example.com --api-domain api.fuel.example.com \
#     --token <CLOUDFLARE_TUNNEL_TOKEN> \
#     --web-port 8080 --api-port 8443 --postgres-port 15432 \
#     --yes
# ============================================================================
set -Eeuo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="" ; APP_DIR=/opt/fleet-fuel/app ; BASE_DIR=/opt/fleet-fuel
WEB_DOMAIN="" ; API_DOMAIN="" ; TUNNEL_TOKEN="" ; TIMEZONE="Africa/Nairobi" ; ASSUME_YES=0
WEB_PORT=3000 ; API_PORT=4000 ; PG_PORT=5432
# Explicitly-provided flags override even an existing .env (re-runs).
WEB_PORT_SET=0 ; API_PORT_SET=0 ; PG_PORT_SET=0
WEB_DOMAIN_SET=0 ; API_DOMAIN_SET=0 ; TOKEN_SET=0 ; TIMEZONE_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; BASE_DIR="$(dirname "$2")"; shift 2 ;;
    --domain) WEB_DOMAIN="$2"; WEB_DOMAIN_SET=1; shift 2 ;;
    --api-domain) API_DOMAIN="$2"; API_DOMAIN_SET=1; shift 2 ;;
    --token) TUNNEL_TOKEN="$2"; TOKEN_SET=1; shift 2 ;;
    --timezone) TIMEZONE="$2"; TIMEZONE_SET=1; shift 2 ;;
    --web-port) WEB_PORT="$2"; WEB_PORT_SET=1; shift 2 ;;
    --api-port) API_PORT="$2"; API_PORT_SET=1; shift 2 ;;
    --postgres-port) PG_PORT="$2"; PG_PORT_SET=1; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# Reuse the shared helpers (port-conflict checks, etc.).
# shellcheck source=common.sh
source "$SCRIPTS_DIR/common.sh"

for p in "$WEB_PORT" "$API_PORT" "$PG_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "ports must be numeric (1-65535): got '$p'"
done

# apply_env_var KEY VALUE — set/replace a single line in an existing .env.
apply_env_var() {
  local key="$1" val="$2"
  val="${val//&/\\&}"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  info "${key}=${val} written to $ENV_FILE"
}

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'; C_BOLD='\033[1m'; C_OFF='\033[0m'
else C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_OFF=''; fi
info() { printf "${C_GREEN}[✓]${C_OFF} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[!]${C_OFF} %s\n" "$*"; }
die()  { printf "${C_RED}[✗]${C_OFF} %s\n" "$*" >&2; exit 1; }
step() { printf "\n${C_BOLD}── %s ──${C_OFF}\n" "$*"; }
ask()  { # ask VAR prompt default
  if [ "$ASSUME_YES" = "1" ]; then printf "%s: %s\n" "$2" "$3"; return 0; fi
  local v; read -r -p "$2 [$3]: " v || true; eval "$1=\"\${v:-$3}\"";
}

[ "$(id -u)" -eq 0 ] || die "run as root: sudo ./scripts/install.sh"

banner() { printf "${C_BOLD}========================================\n %s\n========================================${C_OFF}\n" "$*"; }
banner "Fleet Fuel Management System
 Initial Server Installation"

# ── 1. Verify OS ─────────────────────────────────────────────────────────────
step "1/9 Verify operating system"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    ubuntu) info "Ubuntu ${VERSION_ID:-?} detected" ;;
    debian) warn "Debian ${VERSION_ID:-?} detected — works, but Ubuntu is the supported target" ;;
    *) die "unsupported OS '${ID:-unknown}' — this installer targets Ubuntu" ;;
  esac
else
  die "/etc/os-release not found — not a modern Linux distribution"
fi

# ── 2. Docker ────────────────────────────────────────────────────────────────
step "2/9 Docker Engine + Compose plugin"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  info "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') already installed"
else
  info "installing Docker (official repository) ..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --quiet docker
  systemctl start docker
  info "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') installed and enabled"
fi
docker info >/dev/null 2>&1 || die "docker daemon not running"

# ── 3. Git ───────────────────────────────────────────────────────────────────
step "3/9 Git"
command -v git >/dev/null 2>&1 && info "git $(git --version | cut -d' ' -f3) already installed" || {
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  info "git installed"
}

# ── 4. Directories ───────────────────────────────────────────────────────────
step "4/9 Production directories"
mkdir -p "$BASE_DIR/backups" "$BASE_DIR/uploads" "$BASE_DIR/logs" "$(dirname "$APP_DIR")"
chmod 700 "$BASE_DIR/backups"
info "$BASE_DIR/{backups,uploads,logs} ready"

# ── 5. Clone repository ──────────────────────────────────────────────────────
step "5/9 Application source (GitHub)"
if [ -d "$APP_DIR/.git" ]; then
  info "repository already present at $APP_DIR — updating to latest"
  git -C "$APP_DIR" fetch --quiet origin 2>/dev/null || warn "could not reach origin"
  git -C "$APP_DIR" pull --ff-only --quiet 2>/dev/null || warn "git pull failed — using existing checkout"
else
  [ -n "$REPO_URL" ] || ask REPO_URL "GitHub repository URL" "https://github.com/ORGANIZATION/fleet-fuel.git"
  [ -n "$REPO_URL" ] || die "repository URL required"
  info "cloning $REPO_URL → $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR" || die "git clone failed"
fi
# Some transfer methods lose the executable bit — self-heal on every run so
# script invocations below can never hit "Permission denied".
chmod +x "$APP_DIR/scripts/"*.sh "$APP_DIR/backend/docker/entrypoint.sh" 2>/dev/null || true
cd "$APP_DIR"

# ── 6. Environment file ──────────────────────────────────────────────────────
step "6/9 Environment + secrets (/opt/fleet-fuel/.env)"
ENV_FILE="$BASE_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE already exists — keeping it (secrets are never overwritten)"
  # Explicit CLI flags WIN over an existing env file on re-runs — otherwise
  # re-running with new --x-port/--domain/--token values would silently
  # do nothing. Secret values (passwords, JWT) are never touched.
  if [ "$PG_PORT_SET" = "1" ]; then apply_env_var POSTGRES_PORT "$PG_PORT"; fi
  if [ "$API_PORT_SET" = "1" ]; then apply_env_var API_PORT "$API_PORT"; fi
  if [ "$WEB_PORT_SET" = "1" ]; then apply_env_var WEB_PORT "$WEB_PORT"; fi
  if [ "$TIMEZONE_SET" = "1" ]; then apply_env_var TZ "$TIMEZONE"; fi
  if [ "$WEB_DOMAIN_SET" = "1" ]; then
    apply_env_var WEB_DOMAIN "$WEB_DOMAIN"
    apply_env_var CORS_ORIGIN "https://${WEB_DOMAIN}"
  fi
  if [ "$API_DOMAIN_SET" = "1" ]; then
    apply_env_var API_DOMAIN "$API_DOMAIN"
    apply_env_var NEXT_PUBLIC_API_URL "https://${API_DOMAIN}"
  fi
  if [ "$TOKEN_SET" = "1" ] && [ -n "$TUNNEL_TOKEN" ]; then
    apply_env_var CLOUDFLARE_TUNNEL_TOKEN "$TUNNEL_TOKEN"
  fi
else
  [ -n "$WEB_DOMAIN" ] && [ -n "$API_DOMAIN" ] || {
    ask WEB_DOMAIN "Public web domain (Cloudflare)" "fuel.example.com"
    ask API_DOMAIN "Public API domain (Cloudflare)" "api.$WEB_DOMAIN"
    ask TUNNEL_TOKEN "Cloudflare Tunnel token (may be empty now)" ""
  }
  [ -n "$API_DOMAIN" ] || API_DOMAIN="api.$WEB_DOMAIN"
  PG_PASS="$(openssl rand -hex 24)"
  JWT="$(openssl rand -hex 32)"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
  cat > "$ENV_FILE" <<EOF
# Fleet Fuel Management System — generated $(date '+%Y-%m-%d %H:%M %Z')
# Secrets were generated randomly. Keep this file OUT of git (it already is).
NODE_ENV=production
APP_VERSION=1.0.0
TZ=${TIMEZONE}

POSTGRES_DB=fleetfuel
POSTGRES_USER=fleetfuel
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_BIND=127.0.0.1
POSTGRES_PORT=5432
DATABASE_URL=postgresql://fleetfuel:${PG_PASS}@postgres:5432/fleetfuel

API_PORT=4000
API_BIND=127.0.0.1
JWT_SECRET=${JWT}
JWT_EXPIRES_IN=12h
CORS_ORIGIN=https://${WEB_DOMAIN}
SEED_ADMIN_EMAIL=admin@fleetfuel.local
SEED_ADMIN_NAME=Administrator
SEED_ADMIN_PASSWORD=${ADMIN_PASS}

WEB_PORT=3000
WEB_BIND=127.0.0.1
NEXT_PUBLIC_API_URL=https://${API_DOMAIN}

WEB_DOMAIN=${WEB_DOMAIN}
API_DOMAIN=${API_DOMAIN}

CLOUDFLARE_TUNNEL_TOKEN=${TUNNEL_TOKEN}

BACKUP_DIR=${BASE_DIR}/backups
BACKUP_RETENTION_DAILY=30
BACKUP_RETENTION_WEEKLY=12
BACKUP_RETENTION_MONTHLY=12
EOF
  chmod 600 "$ENV_FILE"
  info "$ENV_FILE generated (chmod 600)"
  info "generated admin password: ${C_BOLD}${ADMIN_PASS}${C_OFF}  (store it now — shown once; change after first login)"
fi

# ── 6b. Host port conflict check ─────────────────────────────────────────────
step "6b/9 Host port availability"
check_stack_ports

# ── 7. Nightly backup cron ───────────────────────────────────────────────────
step "7/9 Nightly backup schedule (02:00)"
cat > /etc/cron.d/fleet-fuel-backup <<EOF
# Fleet Fuel nightly PostgreSQL backup (+retention policy from .env)
0 2 * * * root cd ${APP_DIR} && ${APP_DIR}/scripts/backup.sh >> ${BASE_DIR}/logs/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/fleet-fuel-backup
info "cron installed: /etc/cron.d/fleet-fuel-backup"

# ── 8. Deploy ────────────────────────────────────────────────────────────────
step "8/9 First deployment (backup → build → migrate → start → health)"
SKIP_GIT_PULL=1 FLEET_ENV_FILE="$ENV_FILE" bash "$APP_DIR/scripts/deploy.sh"

# ── 9. Optional seed on empty database ───────────────────────────────────────
step "9/9 Initial administrator"
PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2)"
PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2)"
USER_COUNT="$(docker compose -p fleet-fuel --env-file "$ENV_FILE" \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T postgres psql -U "${PG_USER:-fleetfuel}" -d "${PG_DB:-fleetfuel}" -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo 0)"
if [ "${USER_COUNT:-0}" = "0" ]; then
  info "database is empty — running idempotent seed (admin + fuel types)"
  docker compose -p fleet-fuel --env-file "$ENV_FILE" \
    -f docker-compose.yml -f docker-compose.prod.yml \
    run --rm --no-deps backend npm run seed
else
  info "users already exist (${USER_COUNT}) — seeding skipped (production data protected)"
fi

WEB_DOMAIN_F=$(grep -E '^WEB_DOMAIN=' "$ENV_FILE" | cut -d= -f2)
API_DOMAIN_F=$(grep -E '^API_DOMAIN=' "$ENV_FILE" | cut -d= -f2)
printf "\n${C_BOLD}========================================${C_OFF}
${C_GREEN}${C_BOLD} Installation complete — system ONLINE${C_OFF}
${C_BOLD}========================================${C_OFF}

Web:       https://%s
API:       https://%s
Data:      persistent volumes (survive all updates)
Backups:   %s/backups (nightly 02:00 + before every deploy)
.env:      %s

Next steps:
  1. Configure the Cloudflare Tunnel routes:
       %s → http://web:3000
       %s → http://backend:4000
  2. Sign in to the web app with the generated admin password.
  3. Change the admin password.
  4. Future updates are ONE command:  cd %s && ./scripts/deploy.sh
  5. Check status any time:           ./scripts/status.sh
" "$WEB_DOMAIN_F" "$API_DOMAIN_F" "$BASE_DIR" "$ENV_FILE" "$WEB_DOMAIN_F" "$API_DOMAIN_F" "$APP_DIR"
