# Live Game Tracker — design doc

> Status: **draft, awaiting review**. Author: Claude (with Simon).
> Plan history: previous iteration parked 2026-05-02 (lost to plan-file overwrite); reconstructed and expanded 2026-05-05.

## 1. Context

Today the system tracks streams scoped to **tournament series** (PEC, PAS1, etc.). A series has stages, broadcast days with start/end timestamps, and a hand-curated channel list (with auto-discovery layered on top).

We want a **second mode**: continuously track all streams of a given game on Twitch / Kick / YouTube (starting with PUBG: Battlegrounds) outside any tournament window. Goals:

- **Catch-all coverage**: every PUBG stream above a viewer threshold gets snapshotted, regardless of whether anyone added it to a series. Useful for measuring overall game health on each platform.
- **Trends**: total CCV per game over time (hourly / daily / weekly), breakdown by platform / language / region, top streams by minute.
- **Operator workflow**: define a "game tracker" once (game id, keywords, optional curated YouTube seeds), then it runs forever until paused. The dashboard surfaces it as a new top-level view alongside tournaments.

This is **purely additive**. No existing tournament code path changes behaviour. The only shared resource is the YouTube API key pool — which we'll budget for explicitly.

## 2. Goals / non-goals

**In scope**
- Continuous polling of Twitch + Kick streams in a configured game category, with per-stream snapshots flowing into `viewership_snapshots`.
- Continuous polling of an admin-curated YouTube channel set for the same game, with title + `topicCategories` gating.
- Auto-drop a stream from the polled set when it switches game / title for ≥ 3 cycles.
- Trends view: per-game timeseries of total CCV, top streams, platform / language / region breakdowns. Same visual language as the existing dashboards.
- Same retention as tournament data (30 d raw, then summarized).

**Out of scope (initially)**
- TikTok, Steam, Soop, Chzzk, Trovo, Nimotv, GeoGuessr — only the three big platforms in v1.
- Promoting game-tracker streams into tournaments (operator does this manually if useful).
- Automatic discovery of *new* games to track. Operator picks the games.
- Public reports for game trackers (the existing public-reports infra is series-scoped and we leave it alone).

## 3. Decisions, with rationale

The five open questions from the parked plan, each answered:

### 3.1 Approach: B for YouTube, A for Twitch + Kick

**Twitch + Kick = A (search-based discovery)**. Both platforms expose unauthenticated category-filtered listings ([twitch.ts:317-365](src/adapters/twitch.ts:317), [kick.ts:404-508](src/adapters/kick.ts:404)). Cost is essentially free — Helix has plenty of headroom; Kick has no quota. Run discovery every 60 s and we get every stream above ~10 viewers without any operator curation.

**YouTube = B (curated channel set, no search)**. YouTube's `search.list?eventType=live` costs 100 quota units per page and the result quality is poor (it's full of recommendations, not the channel's own broadcasts — same problem we just spent two weeks fighting in the multi-stream API path). Curated channels with [`videos.list`](src/adapters/youtube.ts:927) at 1 unit/batch is dramatically cheaper and more reliable.

**Why not C (curated + daily seeding search)?** The seeding search is the exact failure mode that wastes quota during tournaments. If we want to surface new YouTube channels we discover them via Twitch/Kick crossover (a streamer simulcasting PUBG on Twitch *and* YouTube — we already know their YT handle from the channel directory or future cross-platform identity work). For v1, manual seeds via admin UI.

### 3.2 Architecture: new `game_trackers` table (option A)

**Decision: dedicated `game_trackers` table.** Pseudo-series on `tournament_series` (option B) was tempting because it ships faster, but it pollutes the schema with fake stages and a perpetually-`live` broadcast_day, and it forces every existing series query (`/api/series`, `/api/viewership/range?series_id=…`) to either filter out the pseudo rows or return mixed results. The polling orchestrator's `transitionBroadcastDayStatuses()` would also need a special-case to skip the auto-pause sweep for pseudo-series channels ([polling-orchestrator.ts:334-357](src/services/polling-orchestrator.ts:334)).

A clean table is ~300 more LOC up front but removes a class of "did the ORM filter handle the tracker rows correctly?" bugs forever. Worth it.

### 3.3 Category-mismatch drop rule: 3 consecutive cycles

**Decision: drop after 3 consecutive cycles.** A stream's `game_id` doesn't match the tracker's target → increment a per-channel counter. Counter hits 3 → mark `dropped_at` and exclude from the next cycle's poll list. Counter resets on first match.

3 cycles at 60 s = 3 minutes of grace. Long enough to cover a brief Just Chatting break, short enough that data on the wrong game doesn't pollute trend totals for long. Exposed as a tracker-level config (`mismatch_threshold_cycles` defaulting to 3) so we can tune per game.

### 3.4 YouTube category gating: title + topicCategories

**Decision: AND of title-substring (cheap) and `topicDetails.topicCategories` (Wikipedia topic match).** Either-OR is too leaky in both directions: streamers leave "PUBG" in their title while playing something else; `topicCategories` sometimes misses obvious matches. Requiring both is conservative.

`topicDetails` adds zero quota (it's a `part` parameter on the existing `videos.list` call we're already making). The Wikipedia URL we look for is `https://en.wikipedia.org/wiki/PlayerUnknown's_Battlegrounds` — stored in the tracker config so we can update it without redeploying.

### 3.5 Retention: same as tournament data

**Decision: 30 days of raw per-minute snapshots, then summarized.** Reuses the existing retention machinery — no new code. Game-tracker rows in `viewership_snapshots` are indistinguishable from tournament rows for retention purposes.

## 4. Schema changes

One migration. Three new tables + one optional column.

### 4.1 `game_trackers`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar | Display name, e.g. "PUBG: Battlegrounds" |
| `slug` | varchar UNIQUE | URL-safe, e.g. "pubg-battlegrounds" |
| `status` | enum(`active`, `paused`) | Operator can pause without delete |
| `twitch_game_id` | varchar nullable | e.g. "493057". Null = don't track on Twitch |
| `kick_category_id` | integer nullable | e.g. 53. Null = don't track on Kick |
| `youtube_topic_url` | text nullable | e.g. `https://en.wikipedia.org/wiki/PlayerUnknown's_Battlegrounds`. Null = no YT topic gating |
| `youtube_title_keywords` | jsonb default `[]` | e.g. `["pubg","battlegrounds"]`. Empty = no title gating |
| `min_ccv_threshold` | integer default 10 | Drop streams below this from polling |
| `mismatch_threshold_cycles` | integer default 3 | Cycles before drop |
| `discovery_interval_seconds` | integer default 60 | Twitch/Kick discovery cadence |
| `metadata` | jsonb default `{}` | Future-proofing |
| `created_at`, `updated_at` | timestamptz | |

### 4.2 `game_tracker_channels`

Lookup table linking a tracker to the channels currently in its polled set. A channel can belong to multiple trackers (a streamer who plays both PUBG and Apex would appear in both). Distinct from `channels` because the lifecycle is independent: a stream can be in the poll set for tracker A and dropped from tracker B.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `game_tracker_id` | uuid FK → game_trackers (CASCADE) | |
| `channel_id` | uuid FK → channels (CASCADE) | |
| `source` | enum(`auto`, `manual`) | Manual seeds (YT) vs auto-discovered (Twitch/Kick) |
| `joined_at` | timestamptz | When this stream first matched this tracker |
| `last_match_at` | timestamptz | Last successful category/title match |
| `consecutive_mismatch_cycles` | integer default 0 | Counter for drop logic |
| `dropped_at` | timestamptz nullable | Soft-delete; row preserved for audit |
| `dropped_reason` | varchar nullable | `'mismatch'`, `'offline'`, `'manual'`, `'below_threshold'` |
| `metadata` | jsonb default `{}` | |
| UNIQUE (`game_tracker_id`, `channel_id`) | | |

### 4.3 `viewership_snapshots`: add `game_tracker_id` (nullable FK)

Snapshots from game-tracker polls reference `game_tracker_id` instead of `series_id` / `stage_id` / `broadcast_day_id`. The latter three remain nullable per the existing migration ([20260210100004](migrations/20260210100004_create_viewership_snapshots.ts)). Add an index on `(game_tracker_id, timestamp)` for the trends queries.

### 4.4 Optional: `game_name` column on `viewership_snapshots`

Useful for the future case where a tournament happens to be played on multiple games (e.g., a Mixmasters event). For game-tracker rows, it's the tracker's `name`. For tournament rows, it's whatever the adapter reported (Twitch/Kick already expose `game_name` per snapshot — we're just discarding it today).

Cheap to add, opens up "what game did people watch" cross-cuts. Mark optional in v1; ship if there's no migration risk on a multi-million-row table (use `ALTER TABLE … ADD COLUMN game_name varchar` — idempotent and non-locking on Postgres 11+).

## 5. Code surfaces

### 5.1 New service: `src/services/game-tracker-service.ts`

Lifecycle owner for game trackers. One instance per process, singleton. Public surface:

- `start()` / `stop()` — wire into [src/index.ts](src/index.ts) bootstrap
- `runDiscoveryCycle(trackerId)` — refresh the tracker's `game_tracker_channels` set on Twitch + Kick
- `runPollCycle(trackerId)` — poll all currently-active channels for the tracker, write snapshots, update mismatch counters, drop stale entries
- `verifyChannel(trackerId, channelId, snapshot)` — the per-snapshot category match check; bumps `consecutive_mismatch_cycles` or resets it

Cadence: discovery every 60 s by default, poll cycle every 60 s offset by 30 s. Each cycle writes one snapshot per active channel.

Key design point: the service has its own poll loop. It does **not** join the existing `PollingOrchestrator`. Reason: the orchestrator's mental model is series → broadcast_days → channels, and bolting a game-tracker codepath onto it would mean either branching that model or fighting it. A parallel service is simpler.

### 5.2 Adapter changes

Minimal — both Twitch and Kick already expose category metadata per snapshot ([twitch.ts:294](src/adapters/twitch.ts:294), [kick.ts:271](src/adapters/kick.ts:271)). What we need:

- **Twitch**: nothing new. `searchLiveStreams(gameId="493057")` already paginates. Add a thin `getStreamsByGame(gameId)` wrapper if it makes the call site cleaner.
- **Kick**: nothing new for discovery. The existing 100-result hard cap ([kick.ts:462](src/adapters/kick.ts:462)) is the practical ceiling for v1 — PUBG on Kick is small enough that this isn't binding.
- **YouTube**: extend `getVideoDetails` ([youtube.ts:927](src/adapters/youtube.ts:927)) to optionally include `topicDetails` in the `part` parameter. Existing callers unaffected — pass an extra `part` arg with default `'snippet,liveStreamingDetails'`.

### 5.3 API routes: `src/api/routes/game-trackers.ts`

| Method | Route | Purpose | Auth |
|---|---|---|---|
| GET | `/api/game-trackers` | List all | viewer+ |
| POST | `/api/game-trackers` | Create | admin |
| GET | `/api/game-trackers/:id` | Detail | viewer+ |
| PUT | `/api/game-trackers/:id` | Edit (incl. pause/resume) | admin |
| DELETE | `/api/game-trackers/:id` | Delete (CASCADE drops snapshots — flag in UI) | admin |
| GET | `/api/game-trackers/:id/channels` | List currently-active channels | viewer+ |
| POST | `/api/game-trackers/:id/channels` | Add manual seed (YT) | editor |
| DELETE | `/api/game-trackers/:id/channels/:channelId` | Manual drop | editor |
| GET | `/api/game-trackers/:id/snapshots/range` | Range query for trends | viewer+ |
| GET | `/api/game-trackers/:id/leaderboard` | Top streams by CCV at-now or in-range | viewer+ |
| GET | `/api/game-trackers/:id/breakdown` | Platform/language/region breakdowns over a time range | viewer+ |

Re-uses the auth middleware and validation patterns from [src/api/routes/series.ts](src/api/routes/series.ts) verbatim.

### 5.4 Frontend (redesign)

New top-nav item **"Games"** sibling to Dashboard / Edit / Users.

`/games` lists all trackers with peak / current CCV preview cards.
`/games/:slug` is the live tracker page with three tabs:
- **Live** — current top streams, total CCV, platform breakdown (mirrors DashboardPage layout)
- **Trends** — last 24 h / 7 d / 30 d timeseries, hourly aggregates, platform / language / region splits
- **Channels** — list of streams currently in the polled set, with manual add/drop for YouTube seeds

Reuses existing chart components (`TimeSeriesPanel`, `PlatformBreakdownPanel`, `LeaderboardPanel`). Header `Header.tsx:40-59` extends with a single new nav item. App router gets one new route block.

Sidebar selector (currently series-scoped) gets a tracker selector when the user is in `/games/*`. Same component shape.

### 5.5 Polling orchestrator: untouched

The existing [PollingOrchestrator](src/services/polling-orchestrator.ts) keeps running on tournament series. Game-tracker poll cycles run independently in `GameTrackerService`. The two share only the adapter layer + DB connection pool.

## 6. Cost and quota

Per-day worst case for **one** game tracker (PUBG: BG):

| Platform | Calls/day | Quota cost |
|---|---|---|
| Twitch | discovery: 5 pages × 1 call × 1440 cycles/day = 7 200 calls | Helix points (free at our scale) |
| Twitch | per-stream poll: ~50 streams × 1440 cycles = 72 000 polls | batched 100/call → 720 calls/day, also free |
| Kick | discovery: 1 call × 1440 = 1 440 calls | Free |
| Kick | per-stream poll: same path | Free |
| YouTube | poll only (no search): up to 200 streams ÷ 50 per `videos.list` = 4 calls × 1440 = **5 760 quota/day** | ~14 % of 40 K pool |

YouTube polling is the only quota cost. With multiple trackers, each new game adds another ~5–6 K/day. The pool can comfortably support 4–5 trackers concurrently with tournaments running. Beyond that we add a key.

If pool runs tight, the game-tracker YouTube path is the **first to back off** — we already have `acquirePoolClient` returning null on exhaustion. Game-tracker polling falls back to "skip this cycle" rather than scrape; tournament polling keeps priority.

## 7. Rollout

Phased so each step can soak before the next.

**Phase 1 — schema + Twitch only (~3 days)**
1. Migration: `game_trackers`, `game_tracker_channels`, `viewership_snapshots.game_tracker_id`. Index `(game_tracker_id, timestamp)`. Optional `viewership_snapshots.game_name`.
2. `GameTrackerService` skeleton — Twitch discovery + poll only, no Kick or YouTube.
3. API routes + admin form to create a tracker.
4. Single read-only frontend page (`/games/:slug` showing leaderboard + 24 h timeseries).
5. Manually create the PUBG: BG tracker. Soak for 1 week. Verify totals match the public Twitchtracker numbers within ~5 %.

**Phase 2 — add Kick (~1 day)**
6. Wire Kick discovery + poll. Same lifecycle code, +1 platform branch.
7. Verify Kick totals separately, then combined with Twitch.

**Phase 3 — add YouTube curated set (~2 days)**
8. Extend `getVideoDetails` to fetch `topicDetails`.
9. Manual-seed API + UI (admin can add YT channels).
10. Title + topic gating in `verifyChannel`.
11. Soak with 5–10 hand-picked PUBG YT channels for a week before opening to operators.

**Phase 4 — Trends UI (~3 days)**
12. Range query endpoint, hourly aggregates table or materialized view (depending on raw query perf).
13. Trends tab with time-range selector, platform/language/region breakdowns.
14. Channels tab with manual add/drop.

**Phase 5 — second tracker (~0 dev days, just config)**
15. Operator creates a second tracker (e.g., Mixmasters or COD: Warzone) via the admin UI. Validates the multi-tracker code path with no code changes.

Total dev: roughly **8–10 days** before the second tracker. Most of the cost is in Phase 4 (UI) — which can be parallelized if useful.

## 8. Edge cases and risks

- **Streamer in two trackers at once**: a streamer playing PUBG, switches to Apex mid-stream. Tracker-A drops them after 3 cycles. Tracker-B (if Apex tracker exists) picks them up on its next discovery cycle. This is handled naturally by the per-tracker `consecutive_mismatch_cycles` counter — there's no cross-tracker coupling.

- **Massive influx**: Dr. Disrespect-tier streamer goes live on PUBG. Tracker hits the 100-stream cap on Kick or processes 500+ streams on Twitch. **Mitigation**: respect `min_ccv_threshold` (default 10) in the discovery filter — stops the long tail. Hard cap on tracker-channels via env var (default 500) to prevent runaway memory.

- **Quota exhaustion mid-broadcast**: tournament + game-tracker YouTube path competing for the same pool. Game-tracker YouTube backs off first (already designed in §6). Worst case: gaps in YT trends data for the rest of the day, no impact on tournament data.

- **YouTube `topicCategories` is sometimes wrong / missing**: if `topicDetails.topicCategories` is empty for a video, fall through to title-only gating. Track in metadata so we can audit later. Don't drop streams just because the topic field is empty (false negatives are worse than false positives at this layer).

- **Twitch / Kick API outage**: discovery fails for a cycle. Existing channel set keeps polling (poll path is independent of discovery refresh). After 3 consecutive failed discoveries, log a warn (will surface in operator alerts).

- **Storage growth**: Twitch + Kick PUBG combined is ~50–150 active streams. At 60 s polling that's ~150 rows × 60 = 9 K rows/h × 24 = ~216 K rows/day per tracker. The retention summarizer already handles this scale, but worth a checkpoint at the end of week 1.

- **Discoverability of the feature itself**: a Trends UI that no one looks at is wasted effort. Make sure the operator manual gets a section about game trackers as part of Phase 4.

## 9. Open follow-ups (not blocking)

- **Cross-platform stream linking**: same streamer simulcasting across Twitch + YouTube currently shows up as two channels. A future pass could deduplicate via channel-display-name matching or a manual "same person" admin flag. Not required for v1; trends and totals work fine either way.

- **Public read-only view**: external links to `/games/:slug` for partners to see their game's health. Inherits the public-report auth model; defer until the feature stabilizes.

- **Webhooks / push notifications**: alert when a tracked stream crosses some viewer threshold. Reuse the existing push-notifier infra. Defer.

- **Auto-discover *new games* to track**: out of scope as stated; would need a meta-discovery pass over the platforms' top-categories endpoints and operator-curated allowlist.

## 10. Critical files

Files this plan touches if implemented:

- `migrations/<TBD>_create_game_trackers.ts` (new)
- `src/services/game-tracker-service.ts` (new, ~600 LOC est.)
- `src/api/routes/game-trackers.ts` (new, ~250 LOC est.)
- `src/api/index.ts` — wire route + service start/stop
- `src/index.ts` — bootstrap the new service
- `src/adapters/youtube.ts` — minor: `getVideoDetails` accepts `part` arg
- `src/models/game-tracker.ts` (new) + `src/models/game-tracker-channel.ts` (new)
- `src/dashboard` (redesign repo): new page tree under `pages/games/`, new top-nav entry, new sidebar variant
- Tests: integration tests for the discovery + drop loop using a mock adapter

## 11. Verification

After Phase 1:
- DB: `SELECT COUNT(*) FROM game_tracker_channels WHERE dropped_at IS NULL` matches Twitch's PUBG live-stream count within polling delay.
- DB: `SELECT MIN(concurrent_viewers) FROM viewership_snapshots WHERE game_tracker_id = …` ≥ `min_ccv_threshold`.
- Logs: no `consecutive_mismatch_cycles` overflow (i.e., counter never exceeds the threshold without triggering a drop).
- Logs: a manually-induced game switch (test channel changing category in the Twitch dashboard) drops within 3 minutes.

After Phase 4:
- Trends totals over 24 h match independent estimates (TwitchTracker, SullyGnome) within 5 %.
- Page load < 2 s for a 7-day range query at the current snapshot volume.
