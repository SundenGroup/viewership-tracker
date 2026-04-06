#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Pull & redeploy
# Run on server after pushing new code to GitHub
# Usage: bash /opt/clutch-viewership-tracker/deploy/update.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
BACKUP_DIR="$APP_DIR/backups"
cd "$APP_DIR"

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
git pull origin main

echo "▸ Installing dependencies..."
npm install --production=false
cd src/dashboard && npm install && cd ../..

echo "▸ Building backend..."
npx tsc

echo "▸ Building dashboard..."
cd src/dashboard && npx vite build && cd ../..

echo "▸ Running migrations..."
npx knex migrate:latest 2>/dev/null || echo "  (no pending migrations)"

echo "▸ Restarting application..."
pm2 restart clutch-viewership

echo "✓ Deploy complete!"
pm2 status
