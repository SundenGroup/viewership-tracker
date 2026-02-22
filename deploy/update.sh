#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Pull & redeploy
# Run on server after pushing new code to GitHub
# Usage: bash /opt/clutch-viewership-tracker/deploy/update.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
cd "$APP_DIR"

echo "▸ Pulling latest code..."
git pull origin main

echo "▸ Installing dependencies..."
npm install --production=false
cd src/dashboard && npm install && cd ../..

echo "▸ Building backend..."
npx tsc

echo "▸ Building dashboard..."
cd src/dashboard && npx vite build && cd ../..

echo "▸ Restarting application..."
pm2 restart clutch-viewership

echo "✓ Deploy complete!"
pm2 status
