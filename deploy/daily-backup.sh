#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Daily off-droplet-ready backup.
#
# Run via cron (suggested 03:00 UTC, after PAS broadcasts end). Produces
# a compressed pg_dump in $APP_DIR/backups/daily/ with rotation:
#   - 7 most recent daily snapshots
#   - 4 most recent SUNDAY snapshots (weekly retention)
#
# To pull a snapshot down to your laptop:
#   scp root@165.232.126.195:/opt/clutch-viewership-tracker/backups/daily/<file>.sql.gz ./
#
# Code is in git so we don't include it in the daily bundle. For a
# code+config snapshot, use deploy/phase0-backup.sh (one-off, runs
# rarely).
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
DAILY_DIR="$APP_DIR/backups/daily"
WEEKLY_DIR="$APP_DIR/backups/weekly"
LOG_FILE="$APP_DIR/backups/daily-backup.log"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

# Load DATABASE_URL
source "$APP_DIR/.env"

TS=$(date -u +%Y%m%d-%H%M%S)
DAY_OF_WEEK=$(date -u +%u)  # 1=Mon, 7=Sun
DAILY_FILE="$DAILY_DIR/daily-$TS.sql.gz"

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily backup start"
  pg_dump "$DATABASE_URL" | gzip > "$DAILY_FILE"
  SIZE=$(du -h "$DAILY_FILE" | cut -f1)
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wrote $DAILY_FILE ($SIZE)"

  # Sunday → also copy to weekly dir
  if [[ "$DAY_OF_WEEK" == "7" ]]; then
    WEEKLY_FILE="$WEEKLY_DIR/weekly-$TS.sql.gz"
    cp "$DAILY_FILE" "$WEEKLY_FILE"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] copied to $WEEKLY_FILE"
  fi

  # Retention: keep last 7 daily, last 4 weekly. find + sort handles empty
  # dirs gracefully (the previous `ls -t glob | tail | xargs` pattern
  # tripped pipefail when a glob matched nothing).
  find "$DAILY_DIR" -maxdepth 1 -name 'daily-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +8 | awk '{print $2}' | xargs -r rm --
  find "$WEEKLY_DIR" -maxdepth 1 -name 'weekly-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +5 | awk '{print $2}' | xargs -r rm --
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] rotation done. daily=$(find "$DAILY_DIR" -maxdepth 1 -name '*.sql.gz' | wc -l), weekly=$(find "$WEEKLY_DIR" -maxdepth 1 -name '*.sql.gz' | wc -l)"
} >> "$LOG_FILE" 2>&1
