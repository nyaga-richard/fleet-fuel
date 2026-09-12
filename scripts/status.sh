#!/usr/bin/env bash
# ============================================================================
# System status — one-glance operational summary.
#   ./scripts/status.sh
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

resolve_env_file || { echo "Fleet Fuel System — .env not found"; exit 1; }
if [ ! -r "$ENV_FILE" ]; then
  echo "status: $ENV_FILE is not readable by user '$(id -un)' — re-run with sudo: sudo ./scripts/status.sh"
  exit 2
fi

API_PORT_H="$(env_value API_PORT 4000)"
WEB_PORT_H="$(env_value WEB_PORT 3000)"
BACKUP_DIR="$(env_value BACKUP_DIR /opt/fleet-fuel/backups)"
DB_USER="$(env_value POSTGRES_USER fleetfuel)"
DB_NAME="$(env_value POSTGRES_DB fleetfuel)"

mark() { # mark <GOOD_TEXT> <BAD_TEXT> <condition>
  if [ "$3" = "1" ]; then printf "${C_GREEN}%s${C_OFF}" "$1"; else printf "${C_RED}%s${C_OFF}" "$2"; fi
}
svc_running() { compose ps --status running "$1" 2>/dev/null | grep -q "$1" && echo 1 || echo 0; }
svc_healthy() { [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(compose ps -q "$1" 2>/dev/null)" 2>/dev/null)" = "healthy" ] && echo 1 || echo 0; }

echo
printf "${C_BOLD}Fleet Fuel System Status${C_OFF}\n"
printf '%s\n' "------------------------"

# ── Services ─────────────────────────────────────────────────────────────────
printf "%-18s" "PostgreSQL:"
if [ "$(svc_running postgres)" = "1" ]; then
  if [ "$(svc_healthy postgres)" = "1" ]; then mark "HEALTHY" "UNHEALTHY" 1; else mark "RUNNING" "UNHEALTHY" 0; fi
else mark "STOPPED" "STOPPED" 0; fi
echo

printf "%-18s" "Backend:"
if [ "$(svc_running backend)" = "1" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT_H}/api/health/ready" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then mark "HEALTHY" "UNHEALTHY" 1; else mark "RUNNING (http $code)" "BAD" 0; fi
else mark "STOPPED" "STOPPED" 0; fi
echo

printf "%-18s" "Frontend:"
if [ "$(svc_running web)" = "1" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT_H}/api/health" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then mark "HEALTHY" "UNHEALTHY" 1; else mark "RUNNING (http $code)" "BAD" 0; fi
else mark "STOPPED" "STOPPED" 0; fi
echo

printf "%-18s" "Cloudflare Tunnel:"
# Check via docker directly — compose ps can't see profile-managed services
# when the profile isn't part of the invocation.
if docker ps --format '{{.Names}}' | grep -q '^fleetfuel-cloudflared$'; then
  if docker logs fleetfuel-cloudflared 2>&1 | tail -50 | grep -q "Registered tunnel connection"; then
    mark "CONNECTED" "CONNECTING" 1
  else
    mark "RUNNING (no registration yet)" "RUNNING" 0
  fi
else
  mark "NOT RUNNING" "NOT RUNNING" 0
  T=$(env_value CLOUDFLARE_TUNNEL_TOKEN)
  [[ "$T" == *CHANGE_THIS* || -z "$T" ]] && printf "  ${C_YELLOW}(token not configured — see README 'Cloudflare Tunnel')${C_OFF}"
fi
echo

# ── Volumes ──────────────────────────────────────────────────────────────────
printf "%-18s" "Database Volume:"
docker volume inspect fleetfuel_postgres_data >/dev/null 2>&1 \
  && printf "${C_GREEN}PRESENT${C_OFF} (%s)\n" "$(docker volume inspect fleetfuel_postgres_data --format '{{.Mountpoint}}' | xargs du -sh 2>/dev/null | cut -f1)" \
  || printf "${C_RED}MISSING${C_OFF}\n"

printf "%-18s" "Upload Volume:"
docker volume inspect fleetfuel_uploads >/dev/null 2>&1 \
  && printf "${C_GREEN}PRESENT${C_OFF}\n" || printf "${C_RED}MISSING${C_OFF}\n"

printf "%-18s" "Backup Dir:"
[ -d "$BACKUP_DIR" ] && printf "PRESENT (%s)\n" "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)" || printf "${C_RED}MISSING${C_OFF}\n"

# ── Backups & deploys ────────────────────────────────────────────────────────
printf "%-18s" "Last Backup:"
LAST_BAK="$(ls -1t "$BACKUP_DIR"/fleetfuel_*.sql.gz 2>/dev/null | head -1 || true)"
if [ -n "$LAST_BAK" ]; then
  ts=$(basename "$LAST_BAK"); ts="${ts#fleetfuel_}"; ts="${ts%.sql.gz}"
  d="${ts%_*}"; t="${ts#*_}"; t="${t:0:2}:${t:2:2}:${t:4:2}"   # 090000 → 09:00:00
  age=$(( ($(date +%s) - $(date -d "$d $t" +%s)) / 3600 ))
  if [ "$age" -le 26 ]; then printf "${C_GREEN}%s${C_OFF} (%dh ago)\n" "$ts" "$age"
  else printf "${C_YELLOW}%s${C_OFF} (${age}h ago — STALE, check cron)\n" "$ts"; fi
else printf "${C_RED}none${C_OFF}\n"; fi

printf "%-18s" "Last Deployment:"
if [ -f "$ROOT_DIR/.deploy/last-deploy.json" ]; then
  python3 -c 'import json;d=json.load(open("'"$ROOT_DIR/.deploy/last-deploy.json"'"));print(f"{d[\"short\"]} v{d[\"version\"]} at {d[\"deployed_at\"]}")' 2>/dev/null || echo "unknown"
else echo "never (this install predates .deploy tracking)"; fi

# ── Sync (mobile offline queue outcomes) ─────────────────────────────────────
printf "%-18s" "Sync (7 days):"
if [ "$(svc_running postgres)" = "1" ]; then
  SYNC_JSON=$(compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT COALESCE(sum((status='applied')::int),0)||','||COALESCE(sum((status='duplicate')::int),0)||','||COALESCE(sum((status='failed')::int),0) FROM sync_log WHERE created_at > now() - interval '7 days';" 2>/dev/null | tr -d ' ')
  IFS=',' read -r APPLIED DUPES FAILED <<< "${SYNC_JSON:-0,0,0}"
  printf "applied: %s, duplicates: %s, " "${APPLIED:-0}" "${DUPES:-0}"
  if [ "${FAILED:-0}" = "0" ]; then printf "${C_GREEN}failed: 0${C_OFF}\n"; else printf "${C_RED}failed: %s${C_OFF}\n" "$FAILED"; fi
else echo "n/a (postgres down)"; fi

# ── Version info ─────────────────────────────────────────────────────────────
if [ "$(svc_running backend)" = "1" ]; then
  curl -s "http://127.0.0.1:${API_PORT_H}/api/system/version" 2>/dev/null | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  print(f"\nVersion: {d[\"version\"]}  Commit: {d[\"commit\"]}  Env: {d[\"environment\"]}  Uptime: {d[\"runtime\"][\"uptime_s\"]}s")
except Exception: pass' || true
fi
echo
