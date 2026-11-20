#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Daily off-droplet-ready backup.
#
# Run via cron (suggested 03:00 UTC, after PAS broadcasts end). Produces
# a compressed pg_dump in $APP_DIR/backups/daily/ with rotation:
#   - 2 most recent daily snapshots
#   - 1 most recent SUNDAY snapshot (weekly retention)
#
# Why so few: a dump is 12 GB and grows every day, the droplet disk is
# 154 GB with the 54 GB database on it, and on 2026-09-27 the old
# retention (7 daily + 4 weekly) filled the disk at 03:14 UTC. Postgres
# stopped accepting connections until space was freed by hand. The script
# now checks free space before it writes, drops the oldest daily first
# when short, and never leaves a half-written file behind. Retention went
# from 3 + 2 to 2 + 1 on 2026-11-20 when the GTA VI tracker started
# writing 5 million raw rows a day. Backups off the box are the real fix.
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
KEEP_DAILY=2
KEEP_WEEKLY=1

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

# Load DATABASE_URL
source "$APP_DIR/.env"

TS=$(date -u +%Y%m%d-%H%M%S)
DAY_OF_WEEK=$(date -u +%u)  # 1=Mon, 7=Sun
DAILY_FILE="$DAILY_DIR/daily-$TS.sql.gz"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
free_gb() { df --output=avail -BG "$APP_DIR" | tail -1 | tr -dc '0-9'; }

# Keep the newest $2 files matching $1/$3, delete the rest. find + sort
# handles empty dirs gracefully (the previous `ls -t glob | tail | xargs`
# pattern tripped pipefail when a glob matched nothing).
rotate() {
  find "$1" -maxdepth 1 -name "$3" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +"$(( $2 + 1 ))" | awk '{print $2}' | xargs -r rm --
}

{
  echo "[$(now)] daily backup start ($(free_gb) GB free)"

  # Room for the new dump: the size of the newest one plus a margin. When
  # short, the oldest daily goes first; when still short, no dump at all
  # (a dump that hits a full disk takes the database down with it).
  NEWEST=$(find "$DAILY_DIR" -maxdepth 1 -name 'daily-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
  NEED_GB=$(( ${NEWEST:+$(du -BG "$NEWEST" | cut -f1 | tr -dc '0-9')} + 3 ))
  if (( $(free_gb) < NEED_GB )); then
    OLDEST=$(find "$DAILY_DIR" -maxdepth 1 -name 'daily-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | head -1 | awk '{print $2}')
    if [[ -n "$OLDEST" ]]; then
      rm -f -- "$OLDEST"
      echo "[$(now)] only $(free_gb) GB free, need $NEED_GB: removed the oldest daily $OLDEST first"
    fi
  fi
  if (( $(free_gb) < NEED_GB )); then
    echo "[$(now)] still only $(free_gb) GB free, need $NEED_GB: NO backup written tonight"
    exit 1
  fi

  pg_dump "$DATABASE_URL" | gzip > "$DAILY_FILE"
  SIZE=$(du -h "$DAILY_FILE" | cut -f1)
  echo "[$(now)] wrote $DAILY_FILE ($SIZE)"
  rotate "$DAILY_DIR" "$KEEP_DAILY" 'daily-*.sql.gz'

  # Sunday → also copy to weekly dir, but only with room for the copy;
  # a copy that fails halfway would leave a useless file the size of the gap.
  if [[ "$DAY_OF_WEEK" == "7" ]]; then
    WEEKLY_FILE="$WEEKLY_DIR/weekly-$TS.sql.gz"
    if (( $(free_gb) >= NEED_GB )); then
      cp "$DAILY_FILE" "$WEEKLY_FILE"
      echo "[$(now)] copied to $WEEKLY_FILE"
    else
      echo "[$(now)] only $(free_gb) GB free, need $NEED_GB: weekly copy skipped"
    fi
    rotate "$WEEKLY_DIR" "$KEEP_WEEKLY" 'weekly-*.sql.gz'
  fi

  echo "[$(now)] rotation done. daily=$(find "$DAILY_DIR" -maxdepth 1 -name '*.sql.gz' | wc -l), weekly=$(find "$WEEKLY_DIR" -maxdepth 1 -name '*.sql.gz' | wc -l), $(free_gb) GB free"
} >> "$LOG_FILE" 2>&1
