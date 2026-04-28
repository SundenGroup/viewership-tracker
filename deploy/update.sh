#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Backend deploy.
# Run on the server after pushing backend code to GitHub:
#   bash /opt/clutch-viewership-tracker/deploy/update.sh
#
# IMPORTANT — this script is BACKEND-ONLY post-2026-04-27 redesign cutover.
# Since the migration, the active dashboard at tracker.clutch.game/ is the
# redesign, which lives in a SEPARATE repo (clutch-viewership-tracker-redesign)
# and gets rsync'd into /opt/clutch-viewership-tracker/src/dashboard/dist/.
#
# Running `vite build` from THIS repo's src/dashboard/ would build the
# LEGACY dashboard and overwrite the redesign — that has bitten us at
# least once. So this script:
#   1. Pulls + builds the backend (TypeScript → dist/index.js)
#   2. Runs migrations
#   3. Restarts pm2
#   4. Builds the LEGACY dashboard ONLY into legacy-dist/ (the /legacy/
#      mount point) — not into src/dashboard/dist/
#
# To deploy the REDESIGN, build locally and rsync:
#   cd /Users/silverfox/clutch-viewership-tracker-redesign/src/dashboard
#   npx vite build
#   rsync -av --delete dist/ root@165.232.126.195:/opt/clutch-viewership-tracker/src/dashboard/dist/
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
BACKUP_DIR="$APP_DIR/backups"
LEGACY_DIST="$APP_DIR/legacy-dist"
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

echo "▸ Installing backend dependencies..."
npm install --production=false

echo "▸ Building backend (TypeScript → dist/)..."
npx tsc

echo "▸ Running migrations..."
npx knex migrate:latest 2>/dev/null || echo "  (no pending migrations)"

# ── Legacy dashboard rebuild (writes to legacy-dist/, NOT src/dashboard/dist/)
# The legacy dashboard is served at tracker.clutch.game/legacy/ as a
# fallback. Skip this section if the legacy build deps haven't changed
# — it's slow and rarely needed. Set BUILD_LEGACY=1 to force rebuild.
if [[ "${BUILD_LEGACY:-0}" == "1" ]]; then
  echo "▸ Building legacy dashboard with --base=/legacy/ → $LEGACY_DIST/"
  cd src/dashboard
  npm install
  npx vite build --base=/legacy/ --outDir "$LEGACY_DIST" --emptyOutDir
  cd ../..
else
  echo "▸ Skipping legacy dashboard rebuild (set BUILD_LEGACY=1 to force)."
fi

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
