/**
 * Game-tracker daily rollup — pre-aggregates game_tracker_snapshots into
 * game_tracker_channel_day_stats (one row per tracker/channel/UTC day) so
 * month-range queries stop scanning raw minute rows.
 *
 * Scheduled at 04:20 UTC from src/index.ts (kill switch GT_ROLLUP=0),
 * covering yesterday and — idempotently — the day before, so late-arriving
 * rows and a missed night both settle. Manual backfill over history:
 * scripts/rollup-gt-days.ts.
 *
 * Aggregation uses the same per-minute MAX dedup semantics as the
 * stream_sessions finals (src/models/stream-session.ts finalizeSessions):
 * a channel can have several snapshots in one minute (poll overlap, tab
 * bleed), so MAX per minute first, then aggregate minutes —
 *   minutes_live = COUNT of distinct minutes
 *   ccv_minutes  = SUM of per-minute MAX ccv (viewer-minutes)
 *   avg_ccv      = round(ccv_minutes / minutes_live)
 *   peak_ccv     = MAX of per-minute MAX ccv
 *
 * Read endpoints are NOT rewired to this table yet — range-leaderboard
 * still reads raw. The rollup is groundwork.
 */

import db from '../utils/db';
import logger from '../utils/logger';

export interface DayRollupResult {
  /** UTC day rolled up, 'YYYY-MM-DD'. */
  day: string;
  /** (tracker, channel) rows upserted for that day. */
  rows: number;
}

/** The UTC calendar day `offsetDays` before today, as 'YYYY-MM-DD'. */
export function utcDay(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Upsert one UTC day's stats for ALL trackers/channels from raw
 * snapshots. Idempotent — re-running a day recomputes identical rows
 * (and overwrites, so late-arriving snapshots settle on the next pass).
 */
export async function rollupDay(day: string): Promise<DayRollupResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`rollupDay: expected 'YYYY-MM-DD' UTC day, got "${day}"`);
  }
  const result = await db.raw<{ rowCount: number }>(
    `
    WITH per_minute AS (
      SELECT game_tracker_id,
             channel_id,
             date_trunc('minute', "timestamp") AS minute,
             MAX(concurrent_viewers) AS ccv
      FROM game_tracker_snapshots
      -- Day boundaries pinned to UTC explicitly: a bare timestamptz-vs-date
      -- comparison would use the server's TimeZone setting instead.
      WHERE "timestamp" >= (?::date)::timestamp AT TIME ZONE 'UTC'
        AND "timestamp" < (?::date + 1)::timestamp AT TIME ZONE 'UTC'
      GROUP BY game_tracker_id, channel_id, date_trunc('minute', "timestamp")
    )
    INSERT INTO game_tracker_channel_day_stats
      (game_tracker_id, channel_id, day, peak_ccv, avg_ccv, ccv_minutes, minutes_live)
    SELECT game_tracker_id,
           channel_id,
           ?::date,
           MAX(ccv)::int,
           ROUND(SUM(ccv)::numeric / COUNT(*))::int,
           SUM(ccv)::bigint,
           COUNT(*)::int
    FROM per_minute
    GROUP BY game_tracker_id, channel_id
    ON CONFLICT (game_tracker_id, channel_id, day) DO UPDATE SET
      peak_ccv     = EXCLUDED.peak_ccv,
      avg_ccv      = EXCLUDED.avg_ccv,
      ccv_minutes  = EXCLUDED.ccv_minutes,
      minutes_live = EXCLUDED.minutes_live
    `,
    [day, day, day],
  );
  return { day, rows: result.rowCount };
}

/**
 * Roll up the last `days` completed UTC days, oldest first, ending
 * yesterday (today is partial — it gets covered tomorrow night). The
 * nightly cron runs with days=2: yesterday plus, idempotently, the day
 * before.
 */
export async function rollupRecentDays(days: number): Promise<DayRollupResult[]> {
  const results: DayRollupResult[] = [];
  for (let offset = days; offset >= 1; offset--) {
    const result = await rollupDay(utcDay(offset));
    results.push(result);
    logger.info('[GTRollup] day rolled up', result);
  }
  return results;
}

// ── Intraday pass ────────────────────────────────────────────────────────
// Today's partial day is rolled every few minutes so the range leaderboard
// and breakdowns can read it from day stats instead of scanning today's
// raw rows on every request. The reads only trust it while it is fresh.

let lastTodayRollupAt = 0;
export const TODAY_ROLLUP_FRESH_MS = 8 * 60_000;

export async function rollupToday(): Promise<DayRollupResult> {
  const result = await rollupDay(utcDay(0));
  lastTodayRollupAt = Date.now();
  return result;
}

/** True when today's day-stats row set was refreshed recently enough to serve reads. */
export function todayRollupFresh(): boolean {
  return Date.now() - lastTodayRollupAt < TODAY_ROLLUP_FRESH_MS;
}
