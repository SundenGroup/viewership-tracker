# Clutch Viewership Tracker — Technical Specification

**Version:** 1.0.0
**Last Updated:** 2026-04-06
**Stack:** TypeScript, Express 5, PostgreSQL, Knex, React 19, Vite, Chart.js, WebSocket

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Database Schema](#3-database-schema)
4. [API Reference](#4-api-reference)
5. [WebSocket Protocol](#5-websocket-protocol)
6. [Platform Adapters](#6-platform-adapters)
7. [Polling & Data Pipeline](#7-polling--data-pipeline)
8. [Discovery System](#8-discovery-system)
9. [Report Generation](#9-report-generation)
10. [Relay System](#10-relay-system)
11. [Browser Scraper](#11-browser-scraper)
12. [Security](#12-security)
13. [Configuration](#13-configuration)
14. [Testing](#14-testing)
15. [Deployment](#15-deployment)
16. [Frontend Dashboard](#16-frontend-dashboard)
17. [File Structure](#17-file-structure)

---

## 1. Overview

The Clutch Viewership Tracker is an esports tournament viewership tracking system that polls 8 streaming platforms in real-time, aggregates viewer counts, auto-discovers new channels, and generates reports with AI-powered narratives.

### Key Capabilities

- **Multi-platform polling** — Twitch, YouTube, Kick, TikTok, Steam, Soop, Chzzk, Trovo
- **Real-time dashboard** — WebSocket-powered live updates with platform/language/category breakdowns
- **Auto-discovery** — Keyword-based channel discovery across all platforms
- **Report generation** — HTML, PDF, DOCX, CSV, XLSX with Chart.js/matplotlib charts and Claude AI narratives
- **View groups** — Filtered views for regional/language-specific reporting (e.g., "West")
- **Multi-source data enhancement** — Browser scraper for real per-minute Twitch data, TikTok relay from residential IPs, server takes highest value

### Data Flow

```
Platform APIs ─┐
               ├─→ Adapters ─→ Polling Orchestrator ─→ PostgreSQL ─→ API ─→ Dashboard
Relay Scripts ─┘                     │                                 │
                              WebSocket broadcast               Report Generator
```

---

## 2. Architecture

### Backend

- **Runtime:** Node.js 20+ with TypeScript
- **HTTP Server:** Express 5 on port 3000
- **WebSocket:** ws library on port 3001
- **Database:** PostgreSQL with Knex query builder + migrations
- **Process Manager:** PM2 (single instance, fork mode)
- **Logging:** Winston (console transport, PM2 log rotation)

### Frontend

- **Framework:** React 19 with TypeScript
- **Build:** Vite
- **Styling:** Tailwind CSS with custom design tokens
- **Charts:** Recharts (dashboard), Chart.js (reports)
- **State:** React Context (auth), custom hooks (polling, WebSocket)
- **Routing:** React Router 7

### External Dependencies

| Service | Purpose | Auth |
|---------|---------|------|
| Twitch Helix + GQL | Viewer counts, stream search | OAuth2 client credentials |
| YouTube Data API v3 | Video details, quota-managed | API key |
| Kick API | Viewer counts, stream search | OAuth2 client credentials |
| Steam API | Broadcast viewer counts | Public endpoint (no key) |
| Soop API | Korean streaming data | API |
| Chzzk API | Korean streaming (Naver) | API |
| Trovo API | Viewer counts | OAuth2 |
| Anthropic Claude API | Report narrative generation | API key (optional) |

---

## 3. Database Schema

PostgreSQL with 19 migrations. All primary keys are UUID (gen_random_uuid). Timestamps use `timestamptz`.

### Tables

#### tournament_series
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| name | VARCHAR | NOT NULL |
| short_name | VARCHAR | |
| game | VARCHAR | |
| partner | VARCHAR | |
| status | ENUM('draft','active','completed') | DEFAULT 'draft' |
| start_date | DATE | |
| end_date | DATE | |
| timezone | VARCHAR(64) | DEFAULT 'UTC' |
| auto_start_polling | BOOLEAN | DEFAULT TRUE |
| is_public | BOOLEAN | DEFAULT FALSE |
| min_role | user_role | DEFAULT 'viewer' |
| discovery_keywords | JSONB | DEFAULT '[]' |
| discovery_game_ids | JSONB | DEFAULT '{}' |
| discovery_default_tier | VARCHAR(32) | DEFAULT 'watch_party' |
| metadata | JSONB | DEFAULT '{}' |
| created_at, updated_at | TIMESTAMPTZ | |

**metadata** stores: `viewGroups`, `blocklist`, `autoReportConfig`, `youtube_categories`

#### stages
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| series_id | UUID | FK→tournament_series (CASCADE) |
| name | VARCHAR | NOT NULL |
| order | INTEGER | NOT NULL |
| start_date, end_date | DATE | |
| status | ENUM('draft','active','completed') | DEFAULT 'draft' |
| metadata | JSONB | DEFAULT '{}' |

#### broadcast_days
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| stage_id | UUID | FK→stages (CASCADE) |
| series_id | UUID | FK→tournament_series (CASCADE) |
| label | VARCHAR | NOT NULL |
| date | DATE | NOT NULL |
| broadcast_start | TIMESTAMPTZ | |
| broadcast_end | TIMESTAMPTZ | |
| status | ENUM('scheduled','live','completed') | DEFAULT 'scheduled' |
| metadata | JSONB | DEFAULT '{}' |

**Indexes:** `(status, series_id)`, `(date)`, `(stage_id)`, `(series_id)`

#### channels
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| series_id | UUID | FK→tournament_series (CASCADE) |
| platform | platform_type ENUM | NOT NULL |
| channel_identifier | VARCHAR | NOT NULL |
| display_name | VARCHAR | NOT NULL |
| language | VARCHAR(5) | |
| region | VARCHAR | |
| tier | channel_tier ENUM | DEFAULT 'community' |
| source | channel_source ENUM | DEFAULT 'manual' |
| is_active | BOOLEAN | DEFAULT FALSE |
| added_at | TIMESTAMPTZ | DEFAULT NOW() |
| metadata | JSONB | DEFAULT '{}' |

**Unique:** `(series_id, platform, channel_identifier)`
**Indexes:** `(series_id, is_active, source)`, `(series_id)`, `(platform)`, `(is_active)`

**Enums:**
- `platform_type`: twitch, youtube, kick, tiktok, steam, trovo, chzzk, soop
- `channel_tier`: official, partner, community, player, watch_party
- `channel_source`: manual, auto_discovered

**metadata** stores: `auto_paused`, `auto_paused_at`, `last_seen_at`, `stream_title`, `discovered_ccv`, `multi_stream`, `blocklist_reason`

#### channel_broadcast_days
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| channel_id | UUID | FK→channels (CASCADE) |
| broadcast_day_id | UUID | FK→broadcast_days (CASCADE) |

**Unique:** `(channel_id, broadcast_day_id)`

Channels with no entries = "All Days" (tracked on every broadcast day). Channels with entries = "Some Days" (tracked only on assigned days).

#### viewership_snapshots
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| channel_id | UUID | FK→channels (CASCADE) |
| broadcast_day_id | UUID | FK→broadcast_days (SET NULL) |
| stage_id | UUID | FK→stages (SET NULL) |
| series_id | UUID | FK→tournament_series (SET NULL) |
| timestamp | TIMESTAMPTZ | NOT NULL |
| concurrent_viewers | INTEGER | DEFAULT 0 |
| platform | VARCHAR | |
| language | VARCHAR | |
| region | VARCHAR | |
| stream_id | VARCHAR | |
| stream_title | VARCHAR | |

**Indexes:** `(series_id, timestamp)`, `(broadcast_day_id, timestamp)`, `(channel_id, timestamp)`, `(stage_id)`, `(platform)`, `(language)`, `(region)`, `(channel_id, stream_id, timestamp)`
**Unique partial index:** `(channel_id, trunc_minute_immutable(timestamp)) WHERE platform = 'tiktok'`

#### users
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| email | VARCHAR | NOT NULL, UNIQUE |
| password_hash | VARCHAR | NOT NULL |
| display_name | VARCHAR | NOT NULL |
| role | user_role ENUM | DEFAULT 'viewer' |
| is_active | BOOLEAN | DEFAULT TRUE |
| last_login_at | TIMESTAMPTZ | |

**Enums:** `user_role`: admin, editor, viewer

#### post_event_metrics
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| channel_id | UUID | FK→channels (CASCADE) |
| broadcast_day_id | UUID | FK→broadcast_days (SET NULL) |
| series_id | UUID | FK→tournament_series (CASCADE) |
| metric_type | ENUM('vod_views','clip_views','total_video_views') | NOT NULL |
| value | BIGINT | |
| collected_at | TIMESTAMPTZ | DEFAULT NOW() |
| metadata | JSONB | DEFAULT '{}' |

### Aggregation Strategy (Three-Level Dedup)

All viewership queries use a three-level deduplication pattern to handle multi-stream YouTube channels and 2x-per-minute polling:

```sql
-- Level 1: SUM multi-stream rows per poll cycle per channel
SELECT minute_bucket, poll_ts, channel_id, SUM(concurrent_viewers) AS cycle_ccv
GROUP BY minute_bucket, poll_ts, channel_id

-- Level 2: MAX across poll cycles per minute per channel
SELECT minute_bucket, channel_id, MAX(cycle_ccv) AS channel_ccv
GROUP BY minute_bucket, channel_id

-- Level 3: SUM across channels for total
SELECT minute_bucket, SUM(channel_ccv) AS total_ccv
GROUP BY minute_bucket
```

---

## 4. API Reference

### Authentication

JWT-based with httpOnly cookies. Cookie name: `cvt_token`.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | Public | Health check |
| `/api/auth/login` | POST | Public (rate-limited 10/min) | Login, returns cookie |
| `/api/auth/logout` | POST | Public | Clear cookie |
| `/api/auth/me` | GET | Authenticated | Current user |
| `/api/auth/users` | GET | Admin | List users |
| `/api/auth/users` | POST | Admin | Create user |
| `/api/auth/users/:id` | PUT | Admin | Update user |
| `/api/auth/users/:id` | DELETE | Admin | Delete user |

### Series

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/series` | GET | Viewer+ | List series (filtered by min_role) |
| `/api/series` | POST | Admin | Create series |
| `/api/series/:id` | GET | Viewer+ | Get series with stages/days |
| `/api/series/:id` | PUT | Editor+ | Update series |
| `/api/series/:id` | DELETE | Admin | Delete series |
| `/api/series/:id/status` | PUT | Admin | Change status |
| `/api/series/games/lookup` | GET | Editor+ | Lookup game IDs |

### Stages & Broadcast Days

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/series/:seriesId/stages` | GET/POST | Viewer+/Editor+ | List/create stages |
| `/api/stages/:id` | PUT/DELETE | Editor+ | Update/delete stage |
| `/api/stages/:stageId/days` | GET/POST | Viewer+/Editor+ | List/create days |
| `/api/days/:id` | PUT/DELETE | Editor+ | Update/delete day |
| `/api/days/:id/status` | PUT | Admin | Change day status |

### Channels

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/series/:seriesId/channels` | GET | Viewer+ | List channels (filterable) |
| `/api/series/:seriesId/channels` | POST | Editor+ | Add channel |
| `/api/series/:seriesId/channels/bulk` | POST | Editor+ | Bulk add |
| `/api/channels/:id` | PUT | Editor+ | Update channel |
| `/api/channels/:id` | DELETE | Admin | Delete channel + data |
| `/api/channels/:id/active` | PUT | Editor+ | Enable/disable |
| `/api/channels/:id/days` | PUT | Editor+ | Set day assignments |
| `/api/channels/:id/promote` | PATCH | Editor+ | Promote to manual |

### Viewership Data

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/viewership/live/:seriesId` | GET | Viewer+ | Live CCV snapshot |
| `/api/viewership/metrics` | GET | Viewer+ | Aggregated metrics (peak, avg, hours) |
| `/api/viewership/timeseries` | GET | Viewer+ | Time-bucketed data (1m/5m/10m) |
| `/api/viewership/leaderboard/:seriesId` | GET | Viewer+ | Channel leaderboard |
| `/api/viewership/snapshots` | GET | Viewer+ | Raw paginated snapshots |

Query params for filtering: `scope`, `id`, `interval`, `groupBy`, `languages`, `platforms`

### Export & Reports

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/export/csv` | GET | Editor+ | CSV download |
| `/api/export/json` | GET | Editor+ | JSON download |
| `/api/reports/generate` | POST | Editor+ | Generate report |
| `/api/reports` | GET | Editor+ | List generated reports |
| `/api/reports/:folder/:filename` | GET | Editor+ | Download report |

### Polling & Discovery (Admin)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/polling/status` | GET | Admin | Orchestrator status |
| `/api/polling/trigger` | POST | Admin | Manual poll cycle |
| `/api/polling/start` | POST | Admin | Start polling |
| `/api/polling/stop` | POST | Admin | Stop polling |
| `/api/polling/discovery/status` | GET | Admin | Discovery status |
| `/api/polling/discovery/trigger/:seriesId` | POST | Admin | Manual discovery |
| `/api/polling/discovery/start/:seriesId` | POST | Admin | Start discovery |
| `/api/polling/discovery/stop/:seriesId` | POST | Admin | Stop discovery |
| `/api/polling/discovery/block` | POST | Editor+ | Block channel |
| `/api/polling/discovery/clear` | POST | Editor+ | Clear feed |
| `/api/polling/discovery/promote` | POST | Editor+ | Approve channel |

### Public API (No Auth)

All at `/api/public/:shortName` — requires series `is_public = true`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/public/:shortName` | GET | Series info |
| `/api/public/:shortName/live-ccv` | GET | Live CCV |
| `/api/public/:shortName/metrics` | GET | Metrics |
| `/api/public/:shortName/timeseries` | GET | Time series |
| `/api/public/:shortName/leaderboard` | GET | Leaderboard |
| `/api/public/:shortName/reports/:filename` | GET | HTML reports |

### Relay (Bearer Token)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/relay/tiktok` | POST | Push TikTok viewer data (1 per channel per minute) |
| `/api/relay/twitch` | POST | Push Twitch data (UPDATE only if higher) |
| `/api/relay/twitch/channels` | GET | Active Twitch channel list |

---

## 5. WebSocket Protocol

**Port:** 3001 (configurable via WS_PORT)
**Max Payload:** 64KB
**Heartbeat:** ping every 30s, terminate unresponsive clients
**Auth:** JWT from httpOnly cookie (anonymous allowed for public series)

### Client → Server

```typescript
{ type: 'subscribe', seriesId: string }    // Subscribe to series updates
{ type: 'unsubscribe', seriesId: string }  // Unsubscribe
{ type: 'ping' }                           // Keepalive
```

### Server → Client

```typescript
{ type: 'welcome', data: { activeSeries, liveBroadcastDays } }
{ type: 'snapshot_update', data: { seriesId, pollResult, latestSnapshots } }
{ type: 'discovery_update', data: { seriesId, discoveryResult } }  // Non-public only
{ type: 'status_update', data: { seriesId, broadcastDayId, previousStatus, newStatus } }
{ type: 'pong' }
{ type: 'error', data: { message } }
```

---

## 6. Platform Adapters

All adapters implement the `PlatformAdapter` interface:

```typescript
interface PlatformAdapter {
  readonly platform: string;
  getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]>;
  searchLiveStreams(gameId?, keywords?, categoryIds?): Promise<DiscoveredStream[]>;
}
```

| Platform | API | Polling | Discovery | Special Features |
|----------|-----|---------|-----------|-----------------|
| **Twitch** | Helix + GQL | 30s, batches of 100 | GQL search | GQL exponential backoff, game ID LRU cache (500 max) |
| **YouTube** | Data API v3 + scraping | 30s, scraping + API fallback | Search API (100 quota/call) | Multi-stream detection, 10K daily quota, video ID caching |
| **Kick** | Official API | 30s, parallel 5, 200ms delay | API search | OAuth2, circuit breaker (5min cooldown) |
| **TikTok** | None (relay only) | Via relay script | Not supported | Data from residential Mac relay |
| **Steam** | Public getbroadcastmpd | 30s, batches of 100 | Not supported | No API key needed, vanity name resolution |
| **Soop** | Soop API | 30s | Keyword search | Korean streaming platform |
| **Chzzk** | Chzzk API (Naver) | 30s | Keyword search | Korean streaming platform |
| **Trovo** | Trovo API | 30s | Keyword search | OAuth2 |

### AdapterRegistry

- Lazy factory pattern (adapters created on first use)
- Parallel multi-platform fetching via `getViewerCountsMultiPlatform()`
- **Adapter failures return empty results** (no 0-viewer snapshots inserted)
- Health check endpoint tests connectivity

---

## 7. Polling & Data Pipeline

### Poll Cycle (every 30 seconds)

```
1. transitionBroadcastDayStatuses()
   ├─ SCHEDULED → LIVE (if NOW >= broadcast_start)
   ├─ LIVE → COMPLETED (if NOW >= broadcast_end)
   ├─ Auto-pause day-scoped channels on completion
   ├─ Trigger reports on completion
   └─ Periodic orphan sweep (every 10 minutes)

2. Query active broadcast days (status = 'live')

3. Load channels per series (is_active = true)
   └─ Load channel_broadcast_days assignments

4. Fetch viewer counts from all platforms (parallel)
   └─ AdapterRegistry.getViewerCountsMultiPlatform()

5. Insert snapshots (transaction, 500-row batches)

6. Broadcast via WebSocket to subscribed clients
```

### Data Integrity

- Three-level dedup prevents double-counting multi-stream and multi-poll data
- TikTok: DB-level unique index (1 row per channel per minute)
- Twitch relay: UPDATE only if higher (never INSERT)
- Adapter failures: empty results (no false zeros)
- YouTube multi-stream: each stream gets separate snapshot row with stream_id

---

## 8. Discovery System

### Flow

1. Searches platform APIs for live streams matching `discovery_keywords` and `discovery_game_ids`
2. Filters: minimum viewer threshold, blocklist, already-tracked
3. Keyword validation: **word-boundary regex** (`\bpubg\b` — prevents "rpg" matching "pubg")
4. YouTube: validates stream title against keywords (prevents wrong multi-stream metadata)
5. New channels inserted as `is_active=false, source='auto_discovered'`
6. Disabled channels re-surfaced when streaming again (updates `last_seen_at`, `stream_title`, `discovered_ccv`)
7. WebSocket broadcast on new or resurfaced channels

### Channel Lifecycle

```
DISCOVERED (is_active=false) → APPROVE → ACTIVE (is_active=true)
                              → BLOCK → Blocklisted (preserved)
ACTIVE → AUTO-PAUSE (day completed) → RE-SURFACE (streaming again)
       → PROMOTE TO MANUAL (immune to auto-pause)
```

---

## 9. Report Generation

### Scopes & Formats

| Scope | Trigger |
|-------|---------|
| Day | Manual or auto on broadcast day completion |
| Stage | Manual or auto on stage completion |
| Series | Manual or auto on series completion |
| Multi-stage | Manual only |

| Format | Engine |
|--------|--------|
| HTML | Chart.js inline, server-side rendering |
| PDF | Python subprocess + matplotlib |
| DOCX | Python subprocess |
| CSV | Direct DB export |
| XLSX | Python subprocess |

### Features

- **View group filtering** — language/platform combinations (e.g., "West")
- **Exclusion filters** — exclude tiers, languages, specific channels
- **Trend comparison** — % change vs previous day in same stage
- **AI narratives** — Claude API (claude-sonnet-4-20250514) generates executive summary, optional
- **DST-aware timezone** — CET/CEST, EST/EDT displayed correctly
- **Auto-generated** — Reports with view groups produce separate files (e.g., `day_2026-04-05_west.html`)

### Platform Colors (unified dashboard + reports)

| Platform | Color |
|----------|-------|
| Twitch | #9146FF (purple) |
| YouTube | #FF0000 (red) |
| Kick | #53FC18 (green) |
| TikTok | #EE1D52 (pink) |
| Steam | #1B9FFC (blue) |
| Soop | #0066FF (royal blue) |
| Chzzk | #00FFA3 (mint) |
| Trovo | #30C67C (green) |
| Total line | #FF154D (red) |

---

## 10. Relay System

### TikTok Relay

**Script:** `scripts/tiktok-relay.ts`
**Runs on:** Residential Mac (avoids data-center IP blocks)
**Interval:** 60 seconds
**Auth:** Bearer token (RELAY_SECRET)

- Scrapes TikTok live pages for viewer count, title, display name
- Pushes to `POST /api/relay/tiktok`
- Server snaps to nearest bulk poll timestamp
- DB-level unique constraint prevents duplicates per minute
- Skips 0-viewer results when channel had >50 viewers last cycle (scrape failure detection)
- Can run on multiple machines for redundancy

### Twitch Relay

**Script:** `scripts/twitch-relay.ts`
**Runs on:** Remote server (e.g., US VPS for regional cache testing)
**Interval:** 30 seconds
**Auth:** Bearer token (RELAY_SECRET)

- Polls Twitch GQL for specific channels
- Pushes to `POST /api/relay/twitch`
- Server UPDATE only (never INSERT) — keeps higher value
- Auto-fetches channel list from server, or uses hardcoded fallback

---

## 11. Browser Scraper

**Scripts:** `scripts/twitch-browser-server.ts` + `scripts/twitch-browser-scraper.ts`
**Runs on:** Local Mac
**Purpose:** Real per-minute Twitch viewer counts (bypasses 3-5 minute API cache stepping)

### Architecture

1. **Browser Server** — Launches persistent Chrome with CDP on port 9224
   - Persistent user profile (avoids detection)
   - `--disable-blink-features=AutomationControlled`
2. **Scraper** — Connects via CDP, manages tabs
   - Opens one tab per channel (18 channels: 9 official + 9 top streamers)
   - Every 60 seconds: reads viewer count from DOM
   - Validates channel is live before reading (prevents stale page numbers)
   - Auto-reloads tabs that navigated away from channel page
   - Refreshes offline tabs every 5 minutes
   - YouTube ownership verification prevents recommended video contamination
3. **Server Integration** — Pushes to relay endpoint, server keeps highest value

### Channel List

9 official channels + 9 top streamers by series average CCV. Hardcoded in scraper script.

---

## 12. Security

| Layer | Implementation |
|-------|---------------|
| **CORS** | Whitelisted origins (tracker.clutch.game, stats.clutch.game) |
| **Headers** | helmet.js (X-Frame-Options, HSTS, CSP, etc.) |
| **Auth** | JWT in httpOnly secure cookies, bcrypt passwords |
| **Rate limiting** | Login: 10 attempts/minute |
| **Body size** | 1MB max JSON payload |
| **JWT validation** | Throws on startup if JWT_SECRET missing in production |
| **Cookie secure** | Auto-enabled in production (NODE_ENV check) |
| **Relay auth** | Bearer token with timing-safe comparison (crypto.timingSafeEqual) |
| **WebSocket** | JWT verification, 64KB max payload, anonymous fallback for public |
| **Shutdown** | 15-second force-exit timeout |
| **Rejections** | Shutdown after 5 unhandled promise rejections |

---

## 13. Configuration

### Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| DATABASE_URL | postgresql://localhost:5432/clutch_viewership | Yes | PostgreSQL connection |
| JWT_SECRET | (dev fallback) | Prod: Yes | JWT signing secret |
| PORT | 3000 | No | HTTP server port |
| WS_PORT | 3001 | No | WebSocket port |
| POLLING_INTERVAL_MS | 60000 | No | Poll interval (ms) |
| DISCOVERY_INTERVAL_MS | 120000 | No | Discovery interval (ms) |
| LOG_LEVEL | info | No | Winston log level |
| CORS_ORIGINS | tracker.clutch.game,stats.clutch.game | No | Allowed CORS origins |
| TWITCH_CLIENT_ID | | No | Twitch OAuth |
| TWITCH_CLIENT_SECRET | | No | Twitch OAuth |
| YOUTUBE_API_KEY | | No | YouTube Data API |
| KICK_CLIENT_ID | | No | Kick OAuth |
| KICK_CLIENT_SECRET | | No | Kick OAuth |
| STEAM_API_KEY | | No | Steam API (optional) |
| TROVO_CLIENT_ID | | No | Trovo OAuth |
| TROVO_CLIENT_SECRET | | No | Trovo OAuth |
| RELAY_SECRET | | No | Relay bearer token |
| ANTHROPIC_API_KEY | | No | Claude AI for narratives |
| DB_POOL_MIN | 2 | No | Knex pool minimum |
| DB_POOL_MAX | 10 | No | Knex pool maximum |
| NODE_ENV | | No | 'production' enables security defaults |
| COOKIE_SECURE | (auto) | No | Force cookie secure flag |
| JWT_EXPIRES_IN | 7d | No | JWT expiration |
| BCRYPT_ROUNDS | 12 | No | Password hash rounds |

---

## 14. Testing

**Framework:** Jest + ts-jest
**Config:** `jest.config.ts`
**Run:** `npm test` or `npm run test:watch`

### Test Suite (35 tests)

**Unit Tests:**
- Keyword matching (14 tests) — word boundary regex, partial match prevention, edge cases
- Config validation (6 tests) — JWT secret enforcement, cookie security, env detection
- Relay auth (6 tests) — timing-safe comparison, edge cases

**Integration Tests:**
- Aggregation queries (9 tests) — three-level dedup, multi-stream, multi-poll MAX, peak CCV, TikTok dedup constraint

Test database: `clutch_viewership_test` (from DATABASE_URL containing "test")

---

## 15. Deployment

### Production Server

- **Host:** DigitalOcean (165.232.126.195)
- **Domains:** tracker.clutch.game, stats.clutch.game
- **Web server:** nginx reverse proxy → Node.js
- **Process manager:** PM2 with pm2-logrotate
- **Log rotation:** 50MB max, 14 files retained, gzip compressed, daily

### Deploy Script (`deploy/update.sh`)

```bash
1. Database backup (pg_dump, gzipped, retains last 10)
2. git pull origin main
3. npm install
4. npx tsc (build backend)
5. npx vite build (build dashboard)
6. npx knex migrate:latest (run migrations)
7. pm2 restart clutch-viewership
```

### PM2 Configuration

```javascript
{
  name: 'clutch-viewership',
  script: 'dist/index.js',
  instances: 1,
  exec_mode: 'fork',
  max_memory_restart: '1G',
  kill_timeout: 10000,
  error_file: '/var/log/clutch/error.log',
  out_file: '/var/log/clutch/out.log',
}
```

---

## 16. Frontend Dashboard

### Pages

| Page | Route | Description |
|------|-------|-------------|
| Login | `/` (unauthenticated) | Email/password login |
| Dashboard | `/:seriesId` | Main viewership dashboard |
| Series Setup | `/new` | Create new series wizard |
| Series Edit | `/:seriesId/edit` | Edit series/stages/days |
| User Management | `/users` | Admin user CRUD |
| Public Dashboard | `/public/:shortName` | Read-only public view |
| 404 | `*` | Page not found |

### Dashboard Panels

- Summary Bar (peak CCV, avg CCV, total viewed hours, active channels)
- Total CCV (animated counter with live pulse)
- Platform Breakdown (donut chart, metric toggle)
- Time Series (line chart, interval/group options, day boundaries)
- Channel Leaderboard (sortable table, expandable detail)
- Language Distribution (bar chart)
- Region Distribution (bar chart)
- Channel List (filterable, sortable, inline edit, promote button)
- Discovery Feed (approve/block, "+N new/updated", auto-refresh)
- Export Panel (CSV/XLSX/HTML/JSON with exclusion filters)

### State Management

- **Auth:** React Context via `useAuth` hook
- **Real-time data:** `usePollingData` hook combines REST polling (30s) + WebSocket
- **API calls:** `useApi` / `usePollingApi` / `useMutation` custom hooks
- **Persistence:** `useLocalStorage` for scope, collapsed panels, view group selection
- **Error handling:** `ErrorBoundary` component catches panel crashes

---

## 17. File Structure

```
clutch-viewership-tracker/
├── deploy/
│   └── update.sh                    # Deploy script with DB backup
├── docs/
│   ├── permissions.md               # Role-based access guide
│   └── editor-manual.md             # User manual
├── migrations/                      # 19 Knex migrations
├── reports/                         # Generated reports (per series folder)
├── backups/                         # Pre-deploy DB backups
├── scripts/
│   ├── tiktok-relay.ts              # TikTok data relay (residential Mac)
│   ├── twitch-relay.ts              # Twitch data relay (multi-region)
│   ├── twitch-browser-server.ts     # Persistent Chrome for Twitch scraping
│   └── twitch-browser-scraper.ts    # DOM viewer count reader
├── src/
│   ├── index.ts                     # Entry point (Express + WS + orchestrator)
│   ├── adapters/                    # 8 platform adapters + registry
│   ├── agent/                       # Report generation + AI narratives
│   ├── api/
│   │   ├── server.ts                # Express app (CORS, helmet, rate limit)
│   │   ├── websocket.ts             # WebSocket server
│   │   ├── middleware/auth.ts        # JWT + RBAC
│   │   └── routes/                  # 12 route files
│   ├── models/                      # 8 database models
│   ├── services/
│   │   ├── polling-orchestrator.ts  # Main polling coordinator
│   │   └── discovery-service.ts     # Auto-discovery engine
│   ├── utils/
│   │   ├── config.ts                # Environment config (validated)
│   │   ├── db.ts                    # Knex client (configurable pool)
│   │   └── logger.ts                # Winston logger
│   └── dashboard/                   # React frontend (Vite)
│       ├── src/
│       │   ├── App.tsx              # Router + auth gate
│       │   ├── pages/               # 6 pages
│       │   ├── components/          # Panels, layout, common
│       │   ├── hooks/               # useApi, usePollingData, useAuth, useWebSocket
│       │   ├── services/api.ts      # API client
│       │   ├── types/api.ts         # TypeScript interfaces
│       │   └── utils/               # Formatters, timezones
│       └── vite.config.ts
├── tests/
│   ├── setup.ts                     # Test DB helpers
│   ├── unit/                        # 3 unit test files
│   └── integration/                 # 1 integration test file
├── package.json
├── tsconfig.json
├── knexfile.ts
├── jest.config.ts
└── SPEC.md                          # This file
```
