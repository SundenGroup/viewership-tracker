#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Clutch Viewership Tracker — DigitalOcean Droplet Setup
# Run as root on a fresh Ubuntu 24.04 LTS droplet
# Usage: bash setup-server.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/clutch-viewership-tracker"
DB_NAME="clutch_viewership"
DB_USER="clutch"
LOG_DIR="/var/log/clutch"

echo "══════════════════════════════════════════════════════"
echo "  Clutch Viewership Tracker — Server Setup"
echo "══════════════════════════════════════════════════════"

# ── 1. System updates ────────────────────────────────────────────────
echo ""
echo "▸ Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Install Node.js 20 LTS ───────────────────────────────────────
echo "▸ Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node $(node -v) / npm $(npm -v)"

# ── 3. Install PostgreSQL 16 ────────────────────────────────────────
echo "▸ Installing PostgreSQL 16..."
if ! command -v psql &>/dev/null; then
  apt-get install -y postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql

# Create database and user
echo "▸ Setting up database..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
echo "  Database '${DB_NAME}' ready"

# ── 4. Install Nginx ────────────────────────────────────────────────
echo "▸ Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# ── 5. Install PM2 ──────────────────────────────────────────────────
echo "▸ Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# ── 6. Install Playwright dependencies ──────────────────────────────
echo "▸ Installing Playwright browser dependencies..."
npx playwright install-deps chromium 2>/dev/null || \
  apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2t64

# ── 7. Install Certbot (SSL) ────────────────────────────────────────
echo "▸ Installing Certbot for SSL..."
apt-get install -y certbot python3-certbot-nginx

# ── 8. Clone repository ─────────────────────────────────────────────
echo "▸ Cloning repository..."
if [ -d "$APP_DIR" ]; then
  echo "  Directory exists, pulling latest..."
  cd "$APP_DIR" && git pull origin main
else
  git clone https://github.com/SundenGroup/viewership-tracker.git "$APP_DIR"
  cd "$APP_DIR"
fi

# ── 9. Install dependencies ─────────────────────────────────────────
echo "▸ Installing backend dependencies..."
cd "$APP_DIR"
npm install --production=false

echo "▸ Installing dashboard dependencies..."
cd "$APP_DIR/src/dashboard"
npm install

# ── 10. Install Playwright browsers ─────────────────────────────────
echo "▸ Installing Playwright Chromium..."
cd "$APP_DIR"
npx playwright install chromium

# ── 11. Build ────────────────────────────────────────────────────────
echo "▸ Building TypeScript backend..."
cd "$APP_DIR"
npx tsc

echo "▸ Building dashboard..."
cd "$APP_DIR/src/dashboard"
npx vite build

# ── 12. Create .env file ────────────────────────────────────────────
echo "▸ Creating .env file..."
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << 'ENVEOF'
# ── Database ──────────────────────────────────────────────
DATABASE_URL=postgresql://clutch:CHANGE_ME_STRONG_PASSWORD@localhost:5432/clutch_viewership

# ── Platform API Keys ────────────────────────────────────
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
YOUTUBE_API_KEY=your_youtube_api_key
KICK_CLIENT_ID=
KICK_CLIENT_SECRET=

# ── Server ───────────────────────────────────────────────
PORT=3000
WS_PORT=3001
NODE_ENV=production

# ── Polling ──────────────────────────────────────────────
POLLING_INTERVAL_MS=60000
DISCOVERY_INTERVAL_MS=120000

# ── Logging ──────────────────────────────────────────────
LOG_LEVEL=info
ENVEOF
  echo "  ⚠  IMPORTANT: Edit $APP_DIR/.env with your actual API keys and DB password!"
else
  echo "  .env already exists, skipping"
fi

# ── 13. Create log directory ─────────────────────────────────────────
echo "▸ Creating log directory..."
mkdir -p "$LOG_DIR"

# ── 14. Configure Nginx ─────────────────────────────────────────────
echo "▸ Configuring Nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/clutch-viewership
ln -sf /etc/nginx/sites-available/clutch-viewership /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 15. Configure firewall ──────────────────────────────────────────
echo "▸ Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 16. Start application ───────────────────────────────────────────
echo "▸ Starting application with PM2..."
cd "$APP_DIR"
pm2 start ecosystem.config.js --env production
pm2 save

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✓ Setup complete!"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  NEXT STEPS:"
echo "  1. Edit /opt/clutch-viewership-tracker/.env"
echo "     - Set your DB password (match the one above)"
echo "     - Add your Twitch/YouTube API keys"
echo ""
echo "  2. Edit /etc/nginx/sites-available/clutch-viewership"
echo "     - Replace YOUR_DOMAIN with your actual domain"
echo ""
echo "  3. Set up SSL (after DNS is pointed):"
echo "     sudo certbot --nginx -d YOUR_DOMAIN"
echo ""
echo "  4. Restart the app after editing .env:"
echo "     pm2 restart clutch-viewership"
echo ""
echo "  USEFUL COMMANDS:"
echo "     pm2 status              — check if app is running"
echo "     pm2 logs clutch         — view live logs"
echo "     pm2 restart clutch      — restart app"
echo "     tail -f /var/log/clutch/out.log"
echo ""
