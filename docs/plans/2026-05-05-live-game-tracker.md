# Live Game Tracker — design doc

> Status: **draft, awaiting approval to start Phase 0**.
> History: parked 2026-05-02 (lost to plan-file overwrite); reconstructed 2026-05-05 morning; revised 2026-05-05 afternoon after operator feedback (drop YouTube from v1, separate "Discover" surface, separate snapshot table, full backup before implementation).

## 1. Context

Today the system tracks streams scoped to **tournament series** (PEC, PAS1, etc.). A series has stages, broadcast days with start / end timestamps, and a hand-curated channel list (with auto-discovery layered on top).

We want a **second mode**: continuously track all streams of a given game on Twitch and Kick (starting with PUBG: Battlegrounds), entirely outside any tournament window. Goals:

- **Catch-all coverage**: every PUBG stream above a viewer threshold gets snapshotted, regardless of whether anyone added it to a series. Useful for measuring overall game health on each platform.
- **Trends**: total CCV per game over time (hourly / daily / weekly), breakdown by platform / language / region, top streams by minute, drag-to-select "what was happening at 8:43 PM last Tuesday" exploration.
- **Operator workflow**: define a "game tracker" once via an admin UI (search the platform's game catalog, pick the right entry, get the right `game_id` automatically — same shape as Series setup). Then it runs forever until paused.
- **Surface**: a new top-level **Discover** tab, parallel to the existing Dashboard. Different design language than tournament dashboard (publisher-friendly, mirrors the exported reports' aesthetic), full dark/light parity, per-game custom layout.

This is **purely additive**. No existing tournament code path changes behaviour. The only shared resource is the DB connection pool — addressed in §8.

## 2. Goals / non-goals

**In scope (v1)**
- Continuous polling of Twitch + Kick streams in a configured game category, with per-stream snapshots flowing into a dedicated `game_tracker_snapshots` table.
- Auto-drop a stream from the polled set when it switches game / title for ≥ 3 cycles (the Jahrein-style PUBG → CS2 → Just Chatting transition).
- Admin UI for creating game trackers — searches Twitch's `/helix/games` and Kick's `/categories` to resolve the right IDs, mirroring the Series setup workflow.
- Discover tab with three surfaces per game: Live (current top streams + total CCV), Trends (timeseries + breakdowns + drag-to-select scrub), Channels (active set with manual seed/drop).
- Same retention as tournament data (30 d raw, then summarized).

**Out of scope (v1, deferred to follow-ups)**
- **YouTube** — pulled from v1. The curated-channel approach works in principle but adds quota pressure on the existing pool, complicates the rollout, and YouTube's quirks (live-redirect attribution, topic-category fidelity) deserve focused attention later. Picked back up in §10.
- TikTok, Steam, Soop, Chzzk, Trovo, Nimotv — only the two largest open-category platforms in v1. None of these have meaningful PUBG audience anyway.
- Promoting game-tracker streams into tournaments (operator does this manually if useful).
- Automatic discovery of *new* games to track. Operator picks the games via the admin UI.
- Public reports for game trackers (the existing public-reports infra is series-scoped and we leave it alone).

## 3. Decisions, with rationale

### 3.1 Approach: Twitch + Kick discovery only (v1)

Both platforms expose unauthenticated category-filtered listings:
- Twitch: [`/helix/streams?game_id=…`](src/adapters/twitch.ts:317) — Helix points budget is comfortable at our scale.
- Kick: [`/public/v1/livestreams?category_id=…`](src/adapters/kick.ts:430) — no quota at all, hard 100-result cap (PUBG fits well within).

Discovery cadence 60 s, polling cadence 60 s offset. No quota cost on either platform.

YouTube punted to follow-up (§10) — re-introducing it requires either curated seeds with admin-managed crossover, or a quota model that doesn't compete with tournament discovery.

### 3.2 Architecture: dedicated `game_tracker_snapshots` table (DB option B)

**Decision: keep snapshots in the existing PostgreSQL DB but in a new table.** Rejected:
- Same `viewership_snapshots` table (option A): tournament queries get tangled in game-tracker volume — index pressure, slower planner stats, retention pass slowdown. Two trackers and the table doubles.
- Separate Postgres instance (option E): operational tax of two backups, two pools, two migration dirs, FDW for joins. Not worth it for v1.
- Partitioned single table (option C): clean but non-trivial migration, and we lose the ability to drop the feature cleanly.
- TimescaleDB (option D): future-proof for trends queries; reserved as a follow-up layer once the new table proves it needs better aggregation perf.

Option B: tournament queries are physically immune to the game-tracker volume. One backup, one pool, one set of credentials. Easy to drop the table if we change our minds. If trends queries get slow at scale, we layer TimescaleDB on the same DB without a re-architecture.

### 3.3 Category-mismatch drop rule: 3 consecutive cycles

A stream's `game_id` doesn't match the tracker's target → increment a per-channel counter. Counter hits 3 → mark `dropped_at` and exclude from the next cycle's poll list. Counter resets on first match. Tracker-level config (`mismatch_threshold_cycles`, default 3).

3 cycles at 60 s = 3 minutes of grace. Long enough to cover a brief Just Chatting break, short enough that wrong-game data doesn't pollute trend totals.

### 3.4 Retention: same as tournament data

30 days of raw per-minute snapshots, then summarized. The retention pass becomes responsible for two tables instead of one — minor change in the summarizer; same algorithmic shape.

## 4. Schema changes

One migration. Three new tables.

### 4.1 `game_trackers`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar | Display name, e.g. "PUBG: Battlegrounds" |
| `slug` | varchar UNIQUE | URL-safe, e.g. `pubg-battlegrounds`. Drives `/discover/pubg-battlegrounds`. |
| `status` | enum(`active`, `paused`) | Operator can pause without delete |
| `twitch_game_id` | varchar nullable | e.g. `493057`. Null = don't track on Twitch |
| `twitch_game_name` | varchar nullable | Resolved at create-time, displayed in admin UI |
| `kick_category_id` | integer nullable | e.g. `53`. Null = don't track on Kick |
| `kick_category_slug` | varchar nullable | Resolved at create-time, displayed in admin UI |
| `min_ccv_threshold` | integer default 10 | Drop streams below this from polling |
| `mismatch_threshold_cycles` | integer default 3 | Cycles before drop |
| `discovery_interval_seconds` | integer default 60 | Discovery cadence |
| `polling_interval_seconds` | integer default 60 | Poll cadence |
| `max_active_channels` | integer default 500 | Hard cap; protects against runaway growth |
| `metadata` | jsonb default `{}` | Future-proofing |
| `created_at`, `updated_at` | timestamptz | |

### 4.2 `game_tracker_channels`

Lookup table linking a tracker to channels currently in its polled set. A channel can belong to multiple trackers (a streamer who plays both PUBG and Apex appears in both).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `game_tracker_id` | uuid FK → game_trackers (CASCADE) | |
| `channel_id` | uuid FK → channels (CASCADE) | |
| `source` | enum(`auto_discovered`, `manual`) | |
| `joined_at` | timestamptz | First match for this tracker |
| `last_match_at` | timestamptz | Last successful category match |
| `consecutive_mismatch_cycles` | integer default 0 | Drop counter |
| `dropped_at` | timestamptz nullable | Soft-delete; row preserved for audit |
| `dropped_reason` | varchar nullable | `mismatch` / `offline` / `manual` / `below_threshold` |
| `metadata` | jsonb default `{}` | |
| UNIQUE (`game_tracker_id`, `channel_id`) | | |

### 4.3 `game_tracker_snapshots`

Mirrors `viewership_snapshots` shape so the trends UI can reuse aggregation patterns, plus the new fields needed for ramp / duration analytics.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `game_tracker_id` | uuid FK → game_trackers (CASCADE) | NOT NULL |
| `channel_id` | uuid FK → channels (CASCADE) | NOT NULL |
| `timestamp` | timestamptz | NOT NULL |
| `concurrent_viewers` | integer | NOT NULL, default 0 |
| `platform` | varchar | NOT NULL — `twitch` or `kick` in v1 |
| `language` | varchar nullable | |
| `region` | varchar nullable | |
| `stream_id` | varchar nullable | Platform stream / session id |
| `stream_title` | varchar nullable | |
| `game_name` | varchar nullable | What category the stream was actually tagged with at this snapshot — useful for audit + cross-tracker analytics |
| `started_at` | timestamptz nullable | When the broadcast session began (per platform). Enables ramp / duration metrics. |
| INDEX `(game_tracker_id, timestamp)` | | Trends range queries |
| INDEX `(channel_id, stream_id, timestamp)` | | Per-channel session timeline |

Tournament `viewership_snapshots` is **untouched**. No new column there.

## 5. Code surfaces

### 5.1 New service: `src/services/game-tracker-service.ts`

Singleton, started from [src/index.ts](src/index.ts) bootstrap. Public surface:

- `start()` / `stop()`
- `runDiscoveryCycle(trackerId)` — refresh `game_tracker_channels` set on Twitch + Kick. Adapter calls already paginate; no quota cost.
- `runPollCycle(trackerId)` — poll all currently-active channels, write snapshots, update mismatch counters, drop stale entries.
- `verifyChannel(trackerId, channelId, snapshot)` — per-snapshot category match.

Cadence: per-tracker timers, defaults from `game_trackers` row. Independent loop — does **not** join the existing [PollingOrchestrator](src/services/polling-orchestrator.ts). Reason: the orchestrator's mental model is series → broadcast_days → channels; bolting a game-tracker codepath onto it would mean either branching that model or fighting it.

### 5.2 Adapter changes

Minimal — both adapters already expose category metadata per snapshot.

- **Twitch** ([twitch.ts:317-365](src/adapters/twitch.ts:317)): no new method; the existing `searchLiveStreams(gameId="493057")` paginates correctly. Add a thin `getStreamsByGame(gameId)` wrapper if it makes the call site read better.
- **Kick** ([kick.ts:404-508](src/adapters/kick.ts:404)): same — existing `searchLiveStreams(gameId, keywords)` is the right shape. The 100-result hard cap is the practical ceiling for v1.

Snapshot shape from each adapter already includes `gameName`, `title`, `started_at` ([twitch.ts:294](src/adapters/twitch.ts:294), [kick.ts:271](src/adapters/kick.ts:271)) — we just need to persist them.

### 5.3 API routes: `src/api/routes/game-trackers.ts`

| Method | Route | Purpose | Auth |
|---|---|---|---|
| GET | `/api/game-trackers` | List all | viewer+ |
| POST | `/api/game-trackers` | Create | admin |
| GET | `/api/game-trackers/:slug` | Detail | viewer+ |
| PUT | `/api/game-trackers/:slug` | Edit / pause / resume | admin |
| DELETE | `/api/game-trackers/:slug` | Delete (CASCADE drops snapshots) | admin |
| GET | `/api/game-trackers/:slug/channels` | Currently-active channels | viewer+ |
| POST | `/api/game-trackers/:slug/channels` | Manual seed (later, if YouTube returns) | editor |
| DELETE | `/api/game-trackers/:slug/channels/:channelId` | Manual drop | editor |
| GET | `/api/game-trackers/:slug/snapshots/range?from=…&to=…&interval=…` | Trends timeseries | viewer+ |
| GET | `/api/game-trackers/:slug/leaderboard?at=…` | Top streams at a timestamp (or live now if omitted) | viewer+ |
| GET | `/api/game-trackers/:slug/breakdown?from=…&to=…&dim=platform\|language\|region` | Distribution over a window | viewer+ |
| GET | `/api/game-trackers/lookup/twitch?q=…` | Search Twitch's `/helix/games` for the admin UI | admin |
| GET | `/api/game-trackers/lookup/kick?q=…` | Search Kick's `/categories` | admin |

Auth + validation reuse the patterns from [src/api/routes/series.ts](src/api/routes/series.ts).

### 5.4 Frontend: new "Discover" top-level surface

Sibling to Dashboard / Edit / Users in the redesign top-nav ([Header.tsx:40-59](redesign/src/dashboard/src/components/layout/Header.tsx:40)).

```
/discover                              → list of game trackers (cards with current CCV, top streams, status pill)
/discover/:slug                        → per-game live view (default tab)
/discover/:slug?tab=trends             → trends + drag-to-select timescrub
/discover/:slug?tab=channels           → active channel set (table, manual operations)
/discover/admin/new                    → admin create form (game search → pick → preview → save)
/discover/admin/:slug/edit             → admin edit form
```

**Design language different from the tournament dashboard:**
- Publisher-friendly aesthetic — borrow from the exported HTML reports (large numbers, light cards, clear hierarchy). Not the dense ops-heavy live dashboard.
- Full dark/light theme parity (uses the existing CSS-variable tokens — already in place).
- Per-game custom layout: a tracker can configure which panels are shown / pinned (defaults sensible; advanced operators can rearrange).

**Trends tab uses the Explore page's drag-to-select timeseries**:
- Click a point → "what was live at this timestamp" panel populates (top streams, total CCV, breakdowns).
- Drag a range → aggregate metrics for that range, plus a leaderboard of streams that crossed N viewers within it.
- Reuses the [TimeSeriesPanel](redesign/src/dashboard/src/components/panels/TimeSeriesPanel.tsx) and the range-leaderboard API endpoint already proven on Explore.

**Live tab**:
- Total CCV (animated, live-pulsed).
- Top 20 streams by current CCV (sortable, expandable, click-through to platform).
- Platform breakdown donut.
- Language + region breakdown bars.
- Channel count, currently-streaming-since-tracker-start counters.
- All in the publisher-friendly layout — bigger cards, more whitespace than the tournament view.

**Channels tab**:
- Table of active channels: streamer, platform, current CCV, joined-at, last match, drop counter.
- Operator actions: manual drop, view in platform, copy stream url.
- Filters: platform, viewer threshold, status.

### 5.5 Polling orchestrator: untouched

[`PollingOrchestrator`](src/services/polling-orchestrator.ts) keeps running on tournament series with **zero behavioural change**. Game-tracker poll cycles run independently in `GameTrackerService`. The two share only the adapter layer and the DB connection pool. See §8 for connection-pool isolation.

### 5.6 Admin game-search workflow

Mirrors the existing Series setup flow. New admin form:

1. Operator types game name ("PUBG", "Apex") into a search input.
2. Frontend hits `GET /api/game-trackers/lookup/twitch?q=PUBG` and `GET /api/game-trackers/lookup/kick?q=PUBG` in parallel.
3. Backend calls Twitch [`/helix/games?name=…`](https://dev.twitch.tv/docs/api/reference/#get-games) and Kick `/categories` (or whichever endpoint is supported), returns matched ID + canonical name + box-art for each platform.
4. Operator picks the right one per platform (or none for a platform we don't track on yet).
5. Save → creates `game_trackers` row + immediately starts the discovery + poll loops.

## 6. Cost / quota

Twitch: free at our scale (Helix points cap is generous; pagination across ~5 pages per discovery cycle is well below the budget).

Kick: free, no quota.

YouTube: not used in v1.

So the only cost-shaped concern is DB write volume — covered in §8.

## 7. Rollout

**Phase 0 — full backup before any code lands** *(operator-blocking; you flagged this explicitly)*
- DB pg_dump → off-droplet (S3 / Spaces / Hetzner storage box, your call). This is the perfect excuse to also set up the daily off-droplet backup we deferred earlier.
- Code + reports tarball snapshot, stored alongside the DB dump.
- nginx config snapshot.
- Verify the dump restores cleanly on a fresh Postgres instance before proceeding.

**Phase 1 — schema + Twitch only (~3 days)**
1. Migration: `game_trackers`, `game_tracker_channels`, `game_tracker_snapshots`. Indexes per §4.3.
2. `GameTrackerService` skeleton — Twitch discovery + poll only, no Kick yet.
3. API routes (CRUD + lookup; trends endpoints stubbed).
4. Read-only `/discover/:slug` page showing the live leaderboard + a 24 h timeseries.
5. Admin "create tracker" form using the Twitch lookup endpoint.
6. Manually create the PUBG: BG tracker. Soak for **at least one week**. Verify: totals match an independent Twitchtracker / SullyGnome reading within ~5 %; the existing tournament dashboards show no perf regression; the retention summarizer still finishes within its window.

**Phase 2 — add Kick (~1 day)**
7. Wire Kick discovery + poll. Same lifecycle code path, +1 platform branch.
8. Add Kick to the admin lookup form.
9. Verify Kick totals separately, then combined with Twitch.

**Phase 3 — full Discover UI (~3 days)**
10. Trends tab with drag-to-select timescrub.
11. Channels tab with manual operations.
12. Per-game custom layout (panel show/hide).
13. Tracker-list landing page at `/discover`.

**Phase 4 — second tracker (~0 dev days)**
14. Operator creates a second game tracker via admin (e.g., Mixmasters or Apex). Validates the multi-tracker code path with no code changes.

**Phase 5 — YouTube reintroduction (deferred, separate planning effort)**
15. Out of scope for this design doc. See §10.

Total dev: **~7 days** before Phase 4. Phase 0 (backup setup) is operator-time, not dev-time.

## 8. Impact on the existing system + mitigations

I underplayed this in the first draft. Honest accounting now that YouTube is out:

### Real risks

1. **`game_tracker_snapshots` row volume.** PUBG: BG on Twitch is ~50–150 active streams; Kick adds ~5–20. At 60 s polling that's ~10–25 K rows / hour, ~250–600 K rows / day per tracker. After 30 days: ~7–18 M rows per tracker. Not catastrophic — `viewership_snapshots` already has comparable order-of-magnitude data — but it's net new inserts on the same Postgres.

2. **Shared DB connection pool.** A buggy game-tracker poll cycle holding connections too long could starve tournament polls. Same Node process, same Knex pool.

3. **Memory + CPU.** Active-channel set can grow to several hundred entries × N trackers. Modest cost but worth bounding.

4. **Retention summarizer pass time.** The summarizer now has two tables to process. Pass duration grows roughly linearly.

5. **Operational complexity.** A new always-on poll loop is a new always-on thing to monitor.

### Mitigations baked into the design

- **Separate snapshot table** (the chosen architecture): tournament queries and indexes are physically untouched by game-tracker volume. This kills risk #1 for the existing system.
- **Reserved connection slots**: the Knex pool is configured with separate min/max for tournament vs game-tracker callers. Tournament gets priority. New env vars: `DB_POOL_TOURNAMENT_RESERVED` (default 5), `DB_POOL_GAME_TRACKER_MAX` (default 10).
- **Circuit breaker**: if the `PollingOrchestrator` reports cycle duration > X seconds for Y consecutive cycles, `GameTrackerService` auto-pauses all trackers until tournament catches up. Surfaced in the operator dashboard as a warning.
- **Hard cap on active channels per tracker** (`max_active_channels`, default 500) — protects against runaway memory.
- **Independent process supervision**: the game-tracker service can be killed / restarted independently of the rest. We could even split it into its own pm2 process if we ever want stronger isolation.
- **Logging discipline**: game-tracker logs prefixed `[GameTracker:slug]` so they don't drown the tournament logs.

### What stays "purely additive"

- No changes to the polling orchestrator's code path.
- No changes to `viewership_snapshots`, `tournament_series`, `stages`, `broadcast_days`, or any tournament-side schema.
- No changes to the existing dashboard's queries (they don't touch the new table).
- No changes to existing API routes.

The only files in the existing system that get touched at all are `src/index.ts` (bootstrap call) and the dashboard's top-level nav (one new entry).

## 9. Edge cases

- **Streamer in two trackers at once**: a streamer plays PUBG, switches to Apex mid-stream. PUBG tracker drops them after 3 cycles. If an Apex tracker exists, it picks them up on its next discovery cycle. Per-tracker state, no cross-tracker coupling.
- **Massive influx**: Dr. Disrespect goes live on PUBG, draws 100K viewers, brings 500 other streamers into the category. `min_ccv_threshold` (default 10) caps the long tail. `max_active_channels` (default 500) is a hard ceiling.
- **Brief category mistag**: streamer accidentally lists wrong category for one cycle. 3-cycle threshold rides it out. If they correct within 3 cycles, no drop.
- **Stream titled "PUBG" but actually playing CS2** (not gated by category check on Twitch / Kick): not v1's problem — Twitch / Kick category gating is reliable. Only YouTube would face this when it returns.
- **Twitch / Kick API outage**: discovery fails for a cycle. Existing channel set keeps polling (poll path is independent of discovery refresh). After 3 consecutive failed discoveries, log warn (surfaces in operator alerts).
- **Storage growth**: as in §8.1.

## 10. Open follow-ups (not blocking v1)

- **YouTube reintroduction.** Curated channel set with `videos.list` + `topicDetails` + title-substring AND-gating. Quota model needs to coexist with tournament discovery — likely a per-tracker daily budget that game-tracker yields if the tournament pool tightens. Separate planning effort once Phase 1–4 prove the architecture.
- **TimescaleDB layer.** If trends queries get slow (continuous aggregates would help), enable the extension on the existing DB and migrate `game_tracker_snapshots` to a hypertable. Doesn't conflict with anything in this plan.
- **Cross-platform stream linking.** Same streamer on Twitch + Kick + YouTube counted as one entity. Manual admin flag in v2.
- **Public read-only Discover view.** External link sharing for partners.
- **Webhooks / push notifications.** Alert when a tracked stream crosses a viewer threshold. Reuses the existing push-notifier infra.
- **Daily off-droplet DB backup.** The Phase 0 backup setup naturally evolves into this.

## 11. Critical files

Files this plan touches if implemented:

- `migrations/<TBD>_create_game_trackers.ts` *(new)*
- `src/services/game-tracker-service.ts` *(new, ~600 LOC est.)*
- `src/api/routes/game-trackers.ts` *(new, ~300 LOC est.)*
- `src/api/index.ts` — wire route + service start/stop
- `src/index.ts` — bootstrap the new service
- `src/adapters/twitch.ts` — minor: optional `getStreamsByGame` wrapper
- `src/adapters/kick.ts` — minor: same pattern
- `src/models/game-tracker.ts` *(new)*, `src/models/game-tracker-channel.ts` *(new)*, `src/models/game-tracker-snapshot.ts` *(new)*
- `src/utils/db.ts` — extend pool config to support reserved slots
- *Redesign repo*: new top-level `pages/discover/`, new top-nav entry, admin form, panel components reused from existing trees
- Tests: integration tests for the discovery + drop loop using mock adapters

## 12. Verification

After Phase 0:
- `pg_restore` on a fresh Postgres instance reproduces production state.

After Phase 1:
- DB: `SELECT COUNT(*) FROM game_tracker_channels WHERE dropped_at IS NULL` matches Twitch's PUBG live-stream count within polling delay.
- DB: `SELECT MIN(concurrent_viewers) FROM game_tracker_snapshots WHERE game_tracker_id = …` ≥ `min_ccv_threshold`.
- Tournament dashboards show no measurable query slowdown vs. the pre-deploy baseline.
- Logs: a manually-induced game switch (test channel changing category in the Twitch dashboard) drops within 3 minutes.
- Connection-pool reservation works — under load, tournament polls never wait > Y ms for a connection.

After Phase 3:
- Trends totals over 24 h match independent estimates (TwitchTracker, SullyGnome) within 5 %.
- Drag-to-select on a 7-day range loads in < 2 s.
- Light/dark theme parity validated on every panel.

## 13. Decisions captured

For traceability, the questions explicitly settled by the operator:

| Question | Answer |
|---|---|
| Approach | Twitch + Kick (option A discovery), no YouTube in v1 |
| Architecture | Dedicated `game_trackers` table |
| Storage | Same Postgres DB, **new `game_tracker_snapshots` table** (option B) |
| Mismatch threshold | 3 consecutive cycles (default; per-tracker override) |
| YouTube category gating | n/a in v1 (deferred) |
| Retention | Same as tournaments (30 d raw → summarized) |
| Started_at | Captured per snapshot |
| Pre-implementation backup | Required (Phase 0) |
| Surface | Top-level **Discover** tab, separate design language from Dashboard |
