# Clutch Viewership Tracker — User Manual

Welcome to the Clutch Viewership Tracker. This guide covers everything you need to manage tournaments, channels, and viewership data.

**Login:** Navigate to [tracker.clutch.game](https://tracker.clutch.game) and sign in with your credentials.

---

## Dashboard Overview

After logging in you'll see the main dashboard. The top bar shows the currently selected series and navigation. The left sidebar contains the tournament schedule and channel management tools. The main area displays live viewership panels.

### Dashboard Panels

- **Summary Bar** — Key metrics at a glance (peak CCV, total viewed hours, active channels)
- **Total CCV** — Combined concurrent viewers across all platforms
- **Platform Breakdown** — Viewer split by Twitch, YouTube, Kick, TikTok, Steam, Soop, Chzzk, and Trovo
- **Time Series Chart** — Viewership over time (zoomable). When viewing multiple broadcast days, vertical dashed lines mark each day's boundary with a label. Toggle between Total, By Platform, By Language, and By Category views. Interval options: 1m, 5m, 10m.
- **Channel Leaderboard** — Top channels ranked by peak/average CCV. Click the expand button to see detailed stats including tier, language, viewed hours, and live CCV.
- **Language Distribution** — Viewer breakdown by stream language
- **Region Distribution** — Viewer breakdown by region
- **Channel List** — All tracked channels with status and metadata. Click the expand button for more vertical space when managing 100+ channels. Defaults to showing active channels only — use the filter buttons to see all or inactive channels. Includes "Promote to Manual" button for auto-discovered channels.
- **Discovery Feed** — Auto-discovered channels awaiting review. Shows stream title, viewer count, and discovery time. Displays "+N new" and "+N updated" counts. The feed is automatically purged when a broadcast day goes live.
- **Export** — Download data as CSV, XLSX, JSON, or interactive HTML reports. Supports exclusion filters for categories, languages, and specific channels.

### View Groups

View groups let you filter the dashboard and reports to specific language/platform combinations (e.g., "West" = EN, RU, PT, DE, etc. on Twitch/YouTube/Kick). Configured in the series editor and applied via the dropdown in the dashboard header.

### Scope Selection

Use the scope selector to view data at three levels:
- **Series** — All data across all stages and days
- **Stage** — Data for one stage only
- **Day** — Data for a single broadcast session

---

## Supported Platforms

Channels can be tracked on **eight platforms**:

| Platform | Polling Method | Notes |
|----------|---------------|-------|
| **Twitch** | GQL API (30s interval) + Browser scraper for key channels | API returns stepped 3-5 min data; browser scraper gets real per-minute counts |
| **YouTube** | Scraping + Data API | Supports multi-stream channels (metadata.multi_stream) |
| **Kick** | API | Circuit breaker with 5-min cooldown on failure |
| **TikTok** | External relay (residential Mac) | Scrapes live pages, pushes to server via relay endpoint |
| **Steam** | Public getbroadcastmpd endpoint | No API key required |
| **Soop** | API | Korean streaming platform |
| **Chzzk** | API | Korean streaming platform (Naver) |
| **Trovo** | API | |

### Twitch Browser Scraper

For key channels (officials + top streamers), a persistent Chrome browser runs on a local Mac, opens Twitch tabs, and reads the real per-minute viewer count from the DOM every 60 seconds. This bypasses the Twitch API's 3-5 minute cached stepping. The server keeps whichever value is higher (API or browser scraper).

**Setup:**
1. Terminal 1: `npx tsx scripts/twitch-browser-server.ts` (starts Chrome on CDP port 9224)
2. Terminal 2: `npx tsx scripts/twitch-browser-scraper.ts --loop` (reads viewer counts every 60s)

The channel list is hardcoded in the scraper script (9 official + 9 top streamers by avg CCV).

### TikTok Relay

TikTok blocks data-center IPs, so a relay script runs on a residential Mac:
- `npx tsx scripts/tiktok-relay.ts --loop` (polls every 60s)
- Pushes to `POST /api/relay/tiktok` with Bearer token auth
- Server deduplicates per channel per minute (DB-level unique constraint)
- Skips 0-viewer results when channel had >50 viewers last cycle (likely scrape failure)

Can run on multiple machines for redundancy — the server keeps only one snapshot per channel per minute.

---

## Managing Series

### Creating a Series

1. Click **New Series** in the top navigation bar
2. Fill in the series details:
   - Series name and short name
   - Game title and partner name
   - Timezone (used for report time display and DST-aware abbreviations)
   - Start and end dates
   - Discovery keywords (word-boundary matched, comma-separated)
   - Discovery Game IDs (platform-specific game identifiers for Twitch, YouTube, Kick)
   - YouTube Categories (optional, defaults to Gaming + Entertainment)
   - Discovery default tier (assigned to approved channels)
3. Add stages and broadcast days
4. Click **Create** to save

### View Groups

Configure view groups in the series editor to create filtered views:
- Name (e.g., "West")
- Languages to include (e.g., en, ru, pt, de, tr, ua)
- Platforms to include (e.g., twitch, youtube, kick, tiktok, soop)

View groups are used for:
- Dashboard filtering (dropdown in header)
- Filtered report generation (separate HTML report per view group)
- Trend comparison in reports (% change vs previous day)

---

## Channel Management

### Channel Tiers

- **Official** — Primary tournament broadcast channels
- **Partner** — Officially partnered co-streamers
- **Player** — Player POV streams
- **Community** — Community co-streamers
- **Watch Party** — Watch party streams

### Day Assignments

Channels can be assigned to specific broadcast days ("Some Days") or left unassigned ("All Days"):
- **All Days** = no entries in channel_broadcast_days → tracked on every broadcast day
- **Some Days** = specific day assignments → only tracked on those days

The auto-pause system only affects channels with specific day assignments. "All Days" channels are immune to auto-pause.

### Auto-Pause & Re-Discovery

When a broadcast day completes:
1. Auto-discovered channels with specific day assignments are paused if no remaining scheduled/live days
2. A periodic sweep (every 10 minutes) catches orphaned channels that missed the transition
3. Paused channels can be re-discovered when they stream again — metadata (title, viewers, last_seen_at) is updated

### Promote to Manual

Auto-discovered channels can be promoted to "Manual" source via the "Promote" button in the channel list. This prevents them from being auto-paused when broadcast days complete.

---

## Discovery Feed

The Discovery Feed shows channels automatically found by the system based on discovery keywords and game IDs. Searches across all eight platforms.

### How Discovery Works

1. Searches platform APIs for live streams matching keywords/game IDs
2. Filters by minimum viewer threshold
3. Validates stream titles against keywords using **word boundary matching** (prevents partial matches like "rpg" matching "pubg")
4. For YouTube multi-stream channels: only stores metadata from the relevant stream (not unrelated concurrent streams)
5. Re-surfaces disabled channels when they stream again — updates title, viewers, and last_seen_at

### Discovery Feed Display

- Channels sorted by last_seen_at (most recently active first)
- Shows stream title, viewer count, and relative time ("X min ago")
- "+N new" and "+N updated" counts in the header
- WebSocket broadcasts trigger frontend refresh on both new and re-surfaced channels

---

## Reports

### Report Generation

Reports can be generated manually or auto-triggered when broadcast days complete.

**Formats:** HTML (interactive with Chart.js), CSV, XLSX

**Scopes:** Day, Stage, Multi-Stage, Series

**Features:**
- Trend comparison (% change vs previous day in same stage)
- View group filtering (separate reports per view group, e.g., "West")
- Exclusion filters (exclude tiers, languages, or specific channels)
- AI-generated narratives (via Claude API, optional)
- DST-aware timezone display (CET/CEST, EST/EDT, etc.)

### Report Colors

Platform colors in reports and dashboard are unified:
- Twitch: Purple (#9146FF)
- YouTube: Red (#FF0000)
- Kick: Green (#53FC18)
- TikTok: Pink (#EE1D52)
- Steam: Blue (#1B9FFC)
- Soop: Royal Blue (#0066FF)
- Chzzk: Mint (#00FFA3)
- Trovo: Green (#30C67C)
- Total line: Red (#FF154D)

### Public Reports

When a series is public, its HTML reports are accessible at:
`https://tracker.clutch.game/api/public/{short_name}/reports/{filename}`

---

## Polling

### Polling Configuration

- **Interval**: 30 seconds (configurable via POLLING_INTERVAL_MS)
- **Three-level dedup**: SUM multi-stream rows per poll cycle → MAX across poll cycles per minute per channel → SUM across channels
- This ensures YouTube multi-stream is counted correctly and 2x-per-minute polling shows the highest value

### Broadcast Day Lifecycle

```
SCHEDULED → LIVE (when broadcast_start time reached, or manual "Go Live")
  └─ Auto-purges unapproved discovery feed
  └─ Discovery starts (if configured)

LIVE → COMPLETED (when broadcast_end time reached, or manual "Complete")
  └─ Auto-pauses day-scoped auto-discovered channels
  └─ Triggers report generation (if configured)
  └─ Checks if stage/series completed
```

### Data Integrity

- Adapter failures don't insert zero-viewer snapshots (returns empty results instead)
- TikTok relay has DB-level unique constraint preventing duplicate snapshots per minute
- Twitch browser scraper data is additive — server keeps whichever value is higher (API or browser)

---

## Deployment

### Deploy Script

`bash /opt/clutch-viewership-tracker/deploy/update.sh`

Steps:
1. **Database backup** — pg_dump before any changes (retains last 10)
2. Pull latest code
3. Install dependencies
4. Build backend (TypeScript) and dashboard (Vite)
5. Run database migrations
6. Restart PM2

### Production Environment

- **Server**: DigitalOcean (165.232.126.195)
- **Domains**: tracker.clutch.game, stats.clutch.game
- **Process manager**: PM2 with log rotation (50MB max, 14 files, compressed)
- **Database**: PostgreSQL with indexed queries
- **WebSocket**: Port 3001 (64KB max payload, heartbeat every 30s)

### Security

- CORS restricted to allowed origins (tracker.clutch.game, stats.clutch.game)
- JWT secret validated on startup (throws in production if missing)
- helmet.js security headers
- Rate limiting on login (10 attempts/minute)
- Request body limit: 1MB
- Relay token: timing-safe comparison
- Cookie secure flag: auto-enabled in production
- Graceful shutdown: 15-second force-exit timeout

---

## Testing

Run the test suite:
```bash
npm test          # Run all tests
npm run test:watch  # Watch mode
```

35 tests covering:
- Aggregation queries (three-level dedup, peak CCV, multi-stream)
- Keyword matching (word boundary regex)
- Config validation (JWT secret, cookies)
- Relay auth (timing-safe comparison)

---

## Tips

- **Use discovery keywords wisely** — Word-boundary matching prevents partial matches, but more specific keywords produce cleaner results
- **Review discovery regularly** — New channels appear as streams go live; approve or block them promptly
- **Disable instead of delete** — Use Disable (or Block for discovery channels) to preserve historical data. Only use Delete to erase all records
- **Check platform colors** — Reports and dashboard use unified brand colors across all 8 platforms
- **Monitor TikTok relay** — Check the relay terminal output for scrape failures (0-viewer skipping)
- **Use view groups** — Configure language/platform filters for focused regional reports
- **Browser scraper for Twitch** — Gives real per-minute data for key channels, overcoming the API's 3-5 minute stepping
- **Post-broadcast CSV import** — Twitch official CSV data from the Creator Dashboard can replace API-stepped data for higher accuracy
