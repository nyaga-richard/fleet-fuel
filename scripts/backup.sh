#!/usr/bin/env bash
# ============================================================================
# PostgreSQL database backup — pg_dump | gzip, stored OUTSIDE the containers.
#
#   ./scripts/backup.sh              → take a backup, print its path (last line)
#   ./scripts/backup.sh --verify     → also verify every .gz in the backup dir
#   ./scripts/backup.sh --retention  → only apply retention cleanup
#
# Naming: fleetfuel_YYYY-MM-DD_HHMMSS.sql.gz
# Location: $BACKUP_DIR (default /opt/fleet-fuel/backups — bind-disk, not a
# container filesystem).
#
# Retention (configurable via .env):
#   BACKUP_RETENTION_DAILY=30     all backups from the last N days
#   BACKUP_RETENTION_WEEKLY=12    plus the newest backup of each ISO week (N weeks)
#   BACKUP_RETENTION_MONTHLY=12   plus the newest backup of each month (N months)
# Safety: cleanup NEVER deletes the newest backup or leaves zero backups.
#
# Recommended cron (installed by scripts/install.sh):
#   0 2 * * * /opt/fleet-fuel/app/scripts/backup.sh >> /opt/fleet-fuel/logs/backup.log 2>&1
# ============================================================================
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

resolve_env_file || die ".env not found"
# Docker is only needed for the actual dump; --verify/--retention work offline.

DB_NAME="$(env_value POSTGRES_DB fleetfuel)"
DB_USER="$(env_value POSTGRES_USER fleetfuel)"
BACKUP_DIR="$(env_value BACKUP_DIR /opt/fleet-fuel/backups)"
RET_DAILY="${BACKUP_RETENTION_DAILY:-30}"
RET_WEEKLY="${BACKUP_RETENTION_WEEKLY:-12}"
RET_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"
mkdir -p "$BACKUP_DIR"

dump_database() {
  local outfile
  outfile="$BACKUP_DIR/fleetfuel_$(date '+%Y-%m-%d_%H%M%S').sql.gz"
  info "Dumping database '$DB_NAME' → $outfile"
  compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges \
    | gzip -9 > "$outfile"

  # Verify the archive is readable and non-trivial.
  [ -s "$outfile" ] || { rm -f "$outfile"; die "backup file is empty — aborted"; }
  gzip -t "$outfile" || { rm -f "$outfile"; die "backup archive failed verification — removed"; }
  # A valid dump must contain the schema header.
  if ! gunzip -c "$outfile" | head -50 | grep -q "PostgreSQL database dump"; then
    rm -f "$outfile"; die "backup does not look like a pg_dump — removed"
  fi
  sha256sum "$outfile" > "$outfile.sha256"
  ln -sfn "$outfile" "$BACKUP_DIR/latest.sql.gz"
  local size
  size=$(du -h "$outfile" | cut -f1)
  ok "backup complete ($size, sha256 recorded)"

  apply_retention
  # Last line on stdout = path (consumed by deploy.sh).
  echo "$outfile"
}

# ── Retention ────────────────────────────────────────────────────────────────
apply_retention() {
  local total kept deleted=0
  # newest → oldest
  mapfile -t files < <(ls -1 "$BACKUP_DIR"/fleetfuel_*.sql.gz 2>/dev/null | sort -r)
  total=${#files[@]}
  [ "$total" -eq 0 ] && { info "retention: no backups yet"; return 0; }

  local now cutoff_daily
  now=$(date +%s)
  cutoff_daily=$(( now - RET_DAILY * 86400 ))

  local -A seen_week=() seen_month=()
  local -a keep=()
  local f base ts week month keepit
  for f in "${files[@]}"; do
    base="$(basename "$f")"                 # fleetfuel_2026-09-12_020000.sql.gz
    base="${base#fleetfuel_}"; base="${base%.sql.gz}"
    d="${base%_*}"; t="${base#*_}"          # 2026-09-12 | 020000
    t="${t:0:2}:${t:2:2}:${t:4:2}"          # 02:00:00
    ts=$(date -d "$d $t" +%s 2>/dev/null || echo 0)
    keepit=0
    if [ "$ts" -ge "$cutoff_daily" ]; then
      keepit=1                               # inside daily window
    else
      week=$(date -d "$d $t" '+%G-W%V' 2>/dev/null || echo "?")
      month=$(date -d "$d $t" '+%Y-%m' 2>/dev/null || echo "?")
      if [ $(( now - ts )) -le $(( RET_WEEKLY * 7 * 86400 )) ]; then
        if [ -z "${seen_week[$week]:-}" ]; then keepit=1; seen_week[$week]=1; fi
      elif [ $(( now - ts )) -le $(( RET_MONTHLY * 31 * 86400 )) ]; then
        if [ -z "${seen_month[$month]:-}" ]; then keepit=1; seen_month[$month]=1; fi
      fi
    fi
    [ "$keepit" = "1" ] && keep+=("$f")
  done

  # Safety: never delete the newest backup, never end with zero backups.
  if [ "${#keep[@]}" -eq 0 ]; then
    warn "retention: would delete everything — keeping newest backup only"
    keep=("${files[0]}")
  fi

  for f in "${files[@]}"; do
    if [[ " ${keep[*]} " != *" $f "* ]]; then
      rm -f "$f" "$f.sha256"
      deleted=$((deleted + 1))
    fi
  done
  kept=$(( total - deleted ))
  info "retention: kept $kept of $total backup(s), deleted $deleted (policy: ${RET_DAILY}d/${RET_WEEKLY}w/${RET_MONTHLY}m)"
}

verify_all() {
  local bad=0 n=0
  for f in "$BACKUP_DIR"/*.sql.gz; do
    [ -f "$f" ] || continue
    n=$((n+1))
    gzip -t "$f" 2>/dev/null || { fail "corrupt: $f"; bad=$((bad+1)); }
  done
  if [ "$bad" -eq 0 ]; then ok "verified $n backup archive(s) — all intact"; else die "$bad corrupt archive(s) found"; fi
}

case "${1:-}" in
  --verify)   verify_all ;;
  --retention) apply_retention ;;
  "")         dump_database ;;
  *) die "usage: backup.sh [--verify|--retention]" ;;
esac
