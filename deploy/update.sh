#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Backend deploy.
# Run on the server after pushing backend code to GitHub:
#   bash /opt/clutch-viewership-tracker/deploy/update.sh
#
# This script is BACKEND-ONLY. The active dashboard at tracker.clutch.game/
# lives in a SEPARATE repo (clutch-viewership-tracker-redesign) and gets
# rsync'd into /opt/clutch-viewership-tracker/src/dashboard/dist/.
#
# Steps:
#   1. Pull + build the backend (TypeScript → dist/index.js)
#   2. Run migrations
#   3. Restart pm2
#
# To deploy the dashboard, build locally and rsync:
#   cd /Users/silverfox/clutch-viewership-tracker-redesign/src/dashboard
#   npx vite build
#   rsync -av --delete dist/ root@165.232.126.195:/opt/clutch-viewership-tracker/src/dashboard/dist/
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
BACKUP_DIR="$APP_DIR/backups"
cd "$APP_DIR"

# Everything below is also appended to a log on the server, so a deploy that
# loses its SSH session (GitHub runner, laptop asleep) still leaves a trace.
mkdir -p /var/log/clutch
exec > >(tee -a /var/log/clutch/update.log) 2>&1
echo "[$(date -u +%FT%TZ)] update.sh start (pid $$)"

# ── Pre-deploy: Database backup ──────────────────────────────────────
echo "▸ Backing up database..."
mkdir -p "$BACKUP_DIR"
source "$APP_DIR/.env"
BACKUP_FILE="$BACKUP_DIR/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"
echo "  Backup saved: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Keep only last 10 pre-deploy backups
ls -t "$BACKUP_DIR"/pre-deploy-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --
echo "  Retained last 10 backups"

echo "▸ Pulling latest code..."
# The server cannot fetch from GitHub (HTTPS remote, no credentials). The deploy
# workflow (or a developer) pushes the release into refs/heads/deploy-inbox over
# SSH first; fast-forward to it. Falls back to a plain pull if no inbox exists.
if git rev-parse --verify -q deploy-inbox > /dev/null; then
  git merge --ff-only deploy-inbox
else
  git pull origin main
fi

echo "▸ Installing backend dependencies..."
npm install --production=false

echo "▸ Building backend (TypeScript → dist/)..."
npx tsc

echo "▸ Running migrations..."
npx knex migrate:latest 2>/dev/null || echo "  (no pending migrations)"

echo "▸ Restarting application..."
pm2 restart clutch-viewership

echo "✓ Backend deploy complete!"
echo
echo "ℹ Reminder: the REDESIGN at tracker.clutch.game/ is rsync'd from"
echo "  the laptop. Run from local machine:"
echo "    cd ~/clutch-viewership-tracker-redesign/src/dashboard && npx vite build"
echo "    rsync -av --delete dist/ root@165.232.126.195:$APP_DIR/src/dashboard/dist/"
echo
pm2 status
