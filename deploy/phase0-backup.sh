#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — Phase 0 / one-off full snapshot.
#
# Generates a complete bundle of: pg_dump + code + dashboard build +
# nginx config + .env + system info. Bundled into a single tar.gz under
# /tmp for ad-hoc download via scp.
#
# Run when: before any major architectural change, before any
# operation that could affect the entire DB / codebase.
#
# Recurring daily backups are a separate, lighter-weight cron job; see
# deploy/daily-backup.sh.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
TS=$(date -u +%Y%m%d-%H%M%S)
BUNDLE_DIR="/tmp/clutch-phase0-$TS"
mkdir -p "$BUNDLE_DIR"

cd "$APP_DIR"
source .env

echo "▸ pg_dump..."
pg_dump "$DATABASE_URL" | gzip > "$BUNDLE_DIR/database.sql.gz"

echo "▸ code tarball (excludes node_modules + dist)..."
tar --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='backups' \
    --exclude='.youtube-quota.json' \
    --exclude='.youtube-pool-quota.json' \
    -czf "$BUNDLE_DIR/code.tar.gz" -C "$APP_DIR" .

echo "▸ dashboard build artifact..."
tar -czf "$BUNDLE_DIR/dashboard-dist.tar.gz" -C "$APP_DIR/src/dashboard" dist 2>/dev/null \
  || echo "  (no dashboard dist on disk yet)"

echo "▸ env file (sensitive — keep this private)..."
cp "$APP_DIR/.env" "$BUNDLE_DIR/dotenv.txt"

echo "▸ nginx config..."
cp /etc/nginx/sites-available/clutch-viewership "$BUNDLE_DIR/nginx-clutch-viewership.conf" 2>/dev/null \
  || cp /etc/nginx/sites-enabled/* "$BUNDLE_DIR/" 2>/dev/null \
  || echo "  (nginx config not found in standard paths)"
nginx -T 2>/dev/null > "$BUNDLE_DIR/nginx-full-dump.conf"

echo "▸ pm2 process list snapshot..."
pm2 list --no-color > "$BUNDLE_DIR/pm2-list.txt" 2>&1

echo "▸ system info..."
{
  echo "=== uname ==="
  uname -a
  echo
  echo "=== node version ==="
  node --version
  echo
  echo "=== postgres version ==="
  PGPASSWORD="$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')" \
    psql -h localhost -U clutch -d clutch_viewership -c "SELECT version();"
  echo
  echo "=== top-level dependencies ==="
  cd "$APP_DIR" && npm list --depth=0 2>/dev/null | head -50
} > "$BUNDLE_DIR/system-info.txt"

echo "▸ writing manifest..."
cd "$BUNDLE_DIR"
{
  echo "Clutch Viewership Tracker — Phase 0 backup bundle"
  echo "Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host: $(hostname)"
  echo
  echo "Contents:"
  ls -lh
  echo
  echo "Total size:"
  du -sh "$BUNDLE_DIR"
} > MANIFEST.txt

echo "▸ creating final bundle..."
cd /tmp
tar -czf "clutch-phase0-$TS.tar.gz" "clutch-phase0-$TS/"
ls -lh "clutch-phase0-$TS.tar.gz"

echo
echo "✓ Bundle ready at: /tmp/clutch-phase0-$TS.tar.gz"
echo
echo "  Pull from your laptop with:"
echo "    scp root@165.232.126.195:/tmp/clutch-phase0-$TS.tar.gz ./"
