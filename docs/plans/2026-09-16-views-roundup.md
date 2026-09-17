# Views round-up per tournament

Status: build plan, 2026-09-16. Author: Claude with Simon.
Related: the GeoGuessr WC 2026 day-by-day views pull (scratch CSV `ggwc26-views-by-day.csv`, 2026-09-16) that motivated this.

## 0. Decisions so far (Simon, 2026-09-16)

- The report metric is **live views**: the platform's view count for the live broadcast, not views to date.
- Per platform that means: YouTube, the public counter about 3 hours after the stream (corrected 2026-09-17: the counter lags while live, 4,246 views at 6,212 concurrent on a running stream, so the last live poll undercounts; at +3 h it has settled and replays are still few). Twitch, the archive counter read 24 to 36 hours after the stream (Twitch adds the live views in a daily batch 18 to 24 hours after the end; before that the archive shows replays only). SOOP, the cumulative viewers kept on the replay. TikTok, the "Total views" figure from LIVE Center, imported per LIVE. Kick, replays never count; Kick live views are an estimate from our own viewer-minutes.
- A broadcast longer than the tracked window only counts its window share (exact where the live counter was read at window start and end, otherwise the share method below).
- Measured, adjusted and estimated views are always labelled and never merged silently.

## 1. What each platform gives us (measured on real streams, 2026-09-16)

| Platform | During the broadcast (public) | After the broadcast (public) | Exact data with the owner's help |
|---|---|---|---|
| YouTube | `videos.list` `statistics.viewCount` ticks live (938 views at 270 concurrent, +17 in 150 s). Same call we already make, 1 quota unit per 50 videos. | Same field; replays keep adding (PAS2 Day 3 EN: 24k four hours after, 35k two days later). | YouTube Analytics API, scope `yt-analytics.readonly`: `views` with filter `liveOrOnDemand==LIVE`, dimension `video`. Exact live views per stream about 2 days later, for connected channels. |
| Twitch | Nothing; the archive counter stays near zero while live (forsen: 1,338 after five hours at 5.4k concurrent). | The archive inherits the live views in a daily batch 18 to 24 hours after the end (248 archives: 0.03 to 0.15 views per viewer-hour before, 5 to 6 after). Replays add about 0.1 per viewer-hour per day. Needs the VOD kept: 7 days non-affiliate, 14 affiliate, 60 partner; some channels keep none. | No analytics API at all (Twitch staff: "no API endpoints for data about past streams"). Stream Summary is dashboard-only; CSV import. `GET /analytics/games` exists for game owners, content unverified. |
| Kick | Nothing (`views: 0` while live). | `views` on `/api/v2/channels/{slug}/videos` counts replays only; list keeps about a week. | Public API has only `viewer_count`; creator dashboard only. |
| SOOP | Nothing cumulative (corrected 2026-09-17: `total_view_cnt` on the live list is PC plus mobile concurrent, 3,245 + 4,164 = 7,409, not a running total). | The replay list (`chapi.sooplive.co.kr/api/{id}/vods/review`) carries `count.read_cnt`, the broadcast's cumulative viewers (122,632 next to `vod_read_cnt` 452 for the replays); the thumbnail's rowKey holds the broadcast number we store as stream id. | Not needed. |
| TikTok | No official API; the LIVE room data may carry a cumulative `total_user` (unverified, no room was live during the check). | Nothing public. | LIVE Center per-LIVE card: Total views, Unique viewers, Active watch viewers, Average watch time, Peak and Average concurrent. Manual export or screenshot. No login scope covers LIVE (checked the scope list). |
| Steam | Current viewers only. | Nothing. | Nothing. |

Reference point for TikTok, PEC Fall Playoffs 1 Day 3 (Sep 13): LIVE Center says peak 762, average 282, 23,425 total views, 18,802 unique viewers, 1,459 active watch viewers, 1m46s average watch time; our tracker had peak 768 and average 291. Total views run at about 20 per viewer-hour, four times the Twitch rate.

## 2. Calibration and the share method

- Twitch live views per viewer-hour (248 archives with at least 60 percent Discover coverage): median 5.5, middle half 3.8 to 6.4. Default factor for estimates; re-measure per platform once live counters are stored.
- Event share for a broadcast longer than the tracked span: views × (viewer-minutes inside the span ÷ viewer-minutes of the whole broadcast). Whole-broadcast curve from Discover when it covers at least 70 percent of the broadcast (`viewer_minutes`); otherwise tracked minutes ÷ broadcast minutes (`time_share`, low confidence). Where a live counter was read at both window edges, `windowed` and exact.
- GeoGuessr WC result with this method: 9.47M views to date, 8.05M after the share on 66 long broadcasts, 158k estimated for 41 channel-days without a source.

## 3. Backend

### 3.1 Tables (one migration, `hasTable` guarded like the others)

`stream_view_readings`: the live counter while a stream runs, at most one row per stream per minute.

```
id uuid pk, channel_id uuid fk channels cascade, broadcast_day_id uuid fk broadcast_days set null,
series_id uuid, stream_ref text (YouTube video id, SOOP broad_no), platform text,
read_at timestamptz, views bigint, unique (channel_id, stream_ref, read_at)
```

`stream_views`: the per-broadcast-day result, one row per channel, source and snapshot.

```
id uuid pk, channel_id uuid fk channels cascade, broadcast_day_id uuid fk broadcast_days cascade,
series_id uuid, stage_id uuid, platform text,
stream_ref text null (Twitch video id, YouTube video id, SOOP broad_no, Kick video id, or null),
source text: youtube_live | youtube_public | youtube_analytics | twitch_vod | kick_vod | soop_live | soop_vod | tiktok_livecenter | csv_import | estimate,
snapshot text: live_end | plus_36h | plus_7d | manual,
views bigint null (the platform's number as read; for tiktok_livecenter the Total views),
counted boolean (false for kick_vod and for replay-only readings),
broadcast_started_at, broadcast_ended_at timestamptz null, broadcast_minutes int null, tracked_minutes int null,
event_share numeric(6,4) null, event_share_method text (full | windowed | viewer_minutes | time_share | none),
event_views bigint null (the number that goes into totals), confidence text (measured | adjusted | estimated),
extra jsonb (unique viewers, active watch viewers, average watch time, unique viewers from a Stream Summary),
fetched_at timestamptz, note text,
unique (channel_id, broadcast_day_id, source, snapshot, coalesce(stream_ref, ''))
```

`channel_day_views` (SQL view): the best row per channel and day for reading. Priority: youtube_analytics, then youtube_live (windowed), then twitch_vod plus_36h (falls back to plus_7d), soop_live or soop_vod, tiktok_livecenter, csv_import, estimate. `kick_vod` rows are never selected; they exist for transparency.

### 3.2 Live counter readings in the poll loop (YouTube)

- `ChannelSnapshot` gets `platformViews?: number` (`src/adapters/types.ts`).
- YouTube adapter: add `statistics` to the `part` of the API-mode `videos.list` calls (`src/adapters/youtube.ts`, the multi-stream API path and the per-video enrichment) and set `platformViews` from `statistics.viewCount`. No extra quota, the cost is per call.
- Orchestrator (`src/services/polling-orchestrator.ts`, next to the snapshot batch insert): for every snapshot with `platformViews` and a live broadcast day, upsert one `stream_view_readings` row per stream per minute (`VIEWS_READINGS=0` switches it off; a failure never costs a poll). The collector turns the readings into `youtube_live` rows, snapshot `live_end`: `event_views` = last reading minus the first reading when the stream was already running at the window start (`windowed`), else the last reading (`full`). Because the counter lags, these rows only outrank the public read when the broadcast ran longer than the window.

### 3.3 Post-event collector (`src/services/views-collector.ts`)

Scheduled with `node-cron` in `src/index.ts` like the stream-health pass, hourly at :40, kill switch `VIEWS_COLLECTOR=0`, never while a broadcast day is live. Three passes per completed day, each recorded in `stream_views_runs`: `plus_3h` (YouTube's settled counter, SOOP replays), `plus_36h` (Twitch archives once the live views have landed, plus YouTube, SOOP and Kick again) and `plus_7d` (Twitch and YouTube once more, for the replay growth). A day first seen later than 36 hours skips straight to the pass that fits its age; days older than 10 days are left to a manual run. Idempotent through the unique key. Manual trigger: `POST /api/days/:id/views/collect` (admin or editor).

Per channel with rollup rows on the day (tracked span, minutes and viewer-minutes from `viewership_minute_rollup`):

- Twitch: resolve the login once (`channels.metadata.twitch_user_id` when present, else `users`), `videos?user_id&type=archive&first=100`, match archives overlapping the tracked span with a 15-minute margin, one `twitch_vod` row per archive. Send Helix requests without a browser User-Agent (the videos-by-game endpoint returns `data: []` with one). Record the broadcaster type and the reason when nothing matched (no VODs, expired, deleted).
- YouTube: stored stream ids from the day's snapshots, validated on `snippet.channelId` and the live times (stored ids can be bled from other pages; multi-stream slot rows carry their own video id and are looked up like any other row), fallback the channel's `/streams` tab (zero quota). `youtube_public` rows at `plus_36h` and `plus_7d` so the replay growth stays visible next to the `youtube_live` reading.
- SOOP: `soop_vod` from the VOD list `read_cnt` when no live reading exists.
- Kick: `kick_vod` rows with `counted = false`.
- Estimates: for channel-days with no counted source, one `estimate` row: `event_views` = viewer-hours × the platform factor (settings, default 5.5), confidence `estimated`.
- Share: for `twitch_vod` (and any source without a windowed reading) whose broadcast runs more than 15 percent or 20 minutes beyond the tracked span, compute `event_share` from Discover viewer-minutes when coverage is at least 70 percent, else time share; `event_views = views × share`, confidence `adjusted`.
- Retention guard: the 36-hour pass is inside every platform's retention; the 7-day pass may find Twitch non-affiliate VODs gone and must not delete the earlier row.

### 3.4 Manual import

`POST /api/days/:id/views/import` (admin or editor) with rows `{ channel_id, source: tiktok_livecenter | twitch_stream_summary | csv_import, views, extra?, note? }`, writing `snapshot = manual`, confidence `measured`. The TikTok card maps to `views` = Total views and `extra` = unique viewers, active watch viewers, average watch time, peak and average concurrent. Twitch Stream Summary rows map live views to `views` and unique viewers to `extra`.

### 3.5 Read API

- `GET /api/public/:shortName/views?scope=day|stage|series&id=` (cached like `metrics`): per channel the best row (views, event_views, confidence, source, method, note), totals per platform and overall split into measured, adjusted and estimated. Multi-stage: sum over the stages' days.
- Editor: `GET /api/days/:id/views` returns every row including uncounted and missing channels with the reason, for the panel in 4.3; `GET /api/views/status?scope=&id=` tells the export dialog which days are not collected or still waiting for the 36-hour pass.

### 3.6 Settings

Per-platform estimate factors and the collector switch live with the other tracker settings (same place as the YouTube keys page). Defaults: 5.5 everywhere until measured per platform.

## 4. Frontend and reports

### 4.0 Views are opt-in per export (Simon, 2026-09-17)

Views never appear in a report unless the person exporting ticks **Include views** in the export dialog. Default off, no memory of the last choice, so every external report is a deliberate decision.

- Export dialog (`components/editor/ExportDialog.tsx`): a checkbox "Include views" under the format choice, with a one-line note ("live views per platform, partly estimated; adds a section and a table column"). Shown for single targets and multi-stage alike.
- Public report link: the flag rides the URL as `?views=1`, the same way the comparison rides `vs_scope`. Without it the report page renders exactly as today, no views section, no column, no request to the views endpoint.
- Legacy static HTML, PDF and DOCX: `includeViews: true` on `POST /api/reports/generate`, default false; the report agent skips the views query and the section entirely when it is off.
- CSV and JSON: the channel summary carries the views columns only when the box is ticked; the dedicated `views` granularity is always available since it is a data export, not a report.
- Editor views panel (4.3) is unaffected; it is where the numbers are checked before anyone ticks the box.

### 4.1 Public report page (dashboard `pages/ReportPage.tsx`)

Views stay out of the hero. The hero KPIs are measured to the minute; live views are partly reconstructed, and a fourth tile with three sub-figures made the top of the report noisy (Simon, 2026-09-16). Views get their own section instead, placed after the language peaks and before the streamer table:

- Section "Live views" with one line per platform: live views, how many channels are measured, adjusted and estimated, and the platform's definition as a muted note. The totals row shows the counted total once, with the estimated part stated in words below it ("of which about 158k estimated"). No comparison chips here in the first version; a baseline comparison can come later once a series has two events with views.
- Streamer table: a "Live views" column, sortable, with a small M / A / E marker and a tooltip carrying the source, the broadcast length against the tracked minutes and the method. Kick rows show the estimate with the marker, never the replay number. The column is hidden entirely when a day has no views rows at all (older events), so existing reports do not change.
- Platform, language and category tables stay as they are; their views figures live in the Live views section, not in extra columns.

### 4.2 Legacy static HTML report (`src/agent/report-builder-html.ts`) and PDF / DOCX

- The same "Live views" section after the breakdown tables: per platform, counted total, estimated part in words, and a definitions footnote (what counts as a view per platform, the Twitch timing, the estimate factor, the share method).
- "Live Views" column in the streamer table with the M / A / E marker, hidden when the day has no views rows.
- No views KPI card and no trend chip on views.
- The report agent's `aggregateMetrics` model gains `liveViews` per channel and per platform; the payload query pulls from `channel_day_views`.

### 4.3 Editor

- Per broadcast day, a "Views" panel: every channel with its best row, source and confidence, the collector's last run, missing channels with the reason (no VOD, expired, no public source), buttons "Collect now" and "Re-run", and "Add manually" for the TikTok card and Stream Summary numbers.
- Retention warning when a day older than 6 days still has no Twitch rows.

### 4.4 Exports (`src/api/routes/export.ts`)

- `channel_summary` gains `live_views`, `views_confidence`, `views_source`, `views_method`, `broadcast_minutes`, `event_share`; `minute_totals` and `per_minute` are unchanged.
- New granularity `views`: every `stream_views` row including uncounted and the snapshots (`plus_36h`, `plus_7d`), so the replay growth and the Kick replay numbers are available without ever entering a total.
- JSON export mirrors both. The export dialog needs no new control.

## 5. Order of work

1. Migration, `platformViews` in the adapters, readings and `live_end` rows in the orchestrator: 0.5 day.
2. Collector with Twitch, YouTube, SOOP, Kick, estimates and share; cron and manual trigger; unit tests for archive matching, share math and the estimate: 1.5 days.
3. Read API and exports: 0.5 day.
4. Public report page and legacy HTML / PDF / DOCX: 1 day.
5. Editor panel and manual import (TikTok card, Stream Summary): 1 day.
6. Later: YouTube Analytics connect for the official channels (OAuth, exact live views), TikTok `total_user` check during a live event, Twitch game analytics for the game owners.

Backfill once step 3 is live: PEC Fall and PAS2 days so far (their Twitch VODs are still within retention this week; affiliates from Sep 11 expire Sep 25), and the GeoGuessr WC results from the scratch CSV loaded as `csv_import` rows, since those VODs are partly gone already.

## 6. Tests

- Archive matching: overlap with the tracked span, restarts (two archives one day), a stream starting the day before, a broadcast spanning two tracked days.
- Share: `viewer_minutes` with full coverage, `time_share` fallback, cap at 1, `windowed` from readings.
- Collector idempotency: a second run adds nothing; a 7-day pass with a vanished VOD keeps the 36-hour row.
- YouTube: bled video id rejected on `channelId`; slot rows looked up by their own id.
- Estimate: factor from settings, `estimated` confidence, never counted together with a measured row for the same channel-day.

## 7. Open questions

- Whether to show Kick replay views anywhere in the public report (the export keeps them regardless).
- How a partner-facing report states the estimated share of a total: a separate line, or a footnote with the percentage.
- Factor per platform: keep 5.5 for all until YouTube and SOOP live counters give platform-specific numbers, or set TikTok separately once a few LIVE Center cards are in (Day 3 gave about 20 per viewer-hour).
