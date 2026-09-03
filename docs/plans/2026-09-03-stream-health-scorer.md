# Stream health scorer: stored features, nightly cohorts

Date: 2026-09-03. Status: implemented, deploy after the GeoGuessr WC Day 2 broadcast (20:30 UTC), backfill the same night.

## Why

The hourly scorer (`src/services/stream-health.ts`) rebuilt its cohort baselines from scratch on every run: every ended session of the last 30 days in the affected game and size band combinations, joined minute by minute to `game_tracker_snapshots` (61M rows, 21 GB). Every hourly pass on 2026-09-03 took 34 to 37 minutes at 90% CPU on the database. The 12:10 UTC run overlapped the live broadcast, the event tracker's poll cycles queued behind it (30 s per cycle grew to five minutes), and the timeline showed empty minutes until the query was cancelled.

## What changed

1. **Per-session features, computed once.** `finalizeSessions` (session end) now also runs `computeHealthFeatures` (`src/services/stream-health-features.ts`) for sessions inside the scorer gates (avg CCV 50+, 30+ minutes): snapshot minutes, chat-evidence minutes, mean and standard deviation of CCV, engagement ratio, and the positive minute-over-minute rises off a base of 50+ viewers (at most 720 kept). Stored in `stream_sessions.health_features` (jsonb). About 1,100 sessions a day qualify, a few KB each.
2. **Cohort baselines nightly.** `buildHealthCohorts` aggregates those features per (tracker, band, platform) and the mixed (tracker, band) slice into `stream_health_cohorts`: the per-session `{ch, eng, conv, cv}` list the scorer already consumed, plus the pooled 99th-percentile rise. Seconds over about 20k short rows; the raw snapshot table is never touched.
3. **Hourly pass only scores.** `scoreSessions()` without ids takes every scorable session that has features and no grade yet (newest first, 3,000 per run), reads the cohort table and each target's own minute array (60 s statement timeout), writes the grade. No time window, so a skipped run leaves nothing behind.
4. **Nightly pass (04:15 UTC)**: recompute features for sessions that ended in the last 24 hours (late chat and follower data), rebuild cohorts, re-score the last 7 days. Skipped as a whole while any broadcast day is live; the next night catches up and the previous baselines stay in use meanwhile.
5. **Backfill**: `npx tsx scripts/backfill-health-features.ts --days 30 --build --rescore`, run once in a quiet window after the deploy.

Grades keep the same formulas, gates and evidence text. Only the cost and the timing of the baseline refresh changed.

## Migration

`migrations/20260903150000_stream_health_features.ts`: nullable column, new table, partial index. Additive only.

## Kill switch

`HEALTH_SCORER=0` in `.env` disables both crons (set on the server on 2026-09-03 13:07 UTC; remove it after the backfill).

## Rollout (tonight)

1. After Day 2 completes (20:30 UTC): push to main, the workflow deploys (about two minutes, one restart, migration runs on boot).
2. `cd /opt/clutch-viewership-tracker && npx tsx scripts/backfill-health-features.ts --days 30 --build --rescore` (the feature scan is the old hourly cost, once).
3. Remove `HEALTH_SCORER=0` from `.env`, `pm2 restart clutch-viewership`.
4. Check `/var/log/clutch/out.log` for `[StreamHealth] scoring pass complete` at the next :10 with a duration in seconds.
