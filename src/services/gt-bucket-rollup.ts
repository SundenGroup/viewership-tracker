/**
 * Game-tracker 10-minute bucket rollup — pre-aggregates
 * game_tracker_snapshots into game_tracker_bucket_stats (one row per
 * tracker / platform / language / 10-minute bucket; '*' = every platform
 * or every language, '-' = no language tag)
 * so the Trends timeline and the 24h peak stop scanning raw minute rows.
 *
 * Semantics are exactly rangeAggregate()'s: a minute's total is the SUM
 * of that minute's snapshot rows, a minute's stream count is the number
 * of distinct channels, and a bucket stores the SUM of those per-minute
 * values plus how many minutes had data (so AVG = sum / minutes).
 *
 * Scheduled every 2 minutes from src/index.ts (kill switch GT_ROLLUP=0),
 * re-rolling the last 30 minutes so late rows settle; idempotent. History
 * is backfilled with scripts/rollup-gt-buckets.ts.
 */

import db from '../utils/db';
import logger from '../utils/logger';
import { BUCKET_EPOCH, BUCKET_ROLLUP_SECONDS, bucketFloor } from '../utils/gt-ranges';

export interface BucketRollupResult {
  from: Date;
  to: Date;
  rows: number;
}

/**
 * Upsert every (tracker, platform, bucket) row whose bucket starts in
 * [from, to). `from` is floored to a bucket boundary so a bucket is
 * always recomputed from ALL of its minutes, never a tail of them.
 */
export async function rollupBuckets(from: Date, to: Date): Promise<BucketRollupResult> {
  const start = bucketFloor(from);
  const end = bucketFloor(to);
  if (end.getTime() <= start.getTime()) return { from: start, to: end, rows: 0 };
  const result = await db.raw<{ rowCount: number }>(
    `
    WITH per_minute AS (
      -- finest grain: one row per tracker / platform / language / minute
      SELECT game_tracker_id,
             platform::text AS platform,
             COALESCE(NULLIF(LOWER(language), ''), '-') AS language,
             date_trunc('minute', "timestamp") AS minute,
             SUM(concurrent_viewers) AS ccv,
             COUNT(DISTINCT channel_id) AS streams
      FROM game_tracker_snapshots
      WHERE "timestamp" >= ? AND "timestamp" < ?
      GROUP BY 1, 2, 3, 4
    ),
    u AS (
      SELECT game_tracker_id, platform, language, minute, ccv, streams FROM per_minute
      UNION ALL
      SELECT game_tracker_id, platform, '*', minute, SUM(ccv), SUM(streams) FROM per_minute GROUP BY 1, 2, 4
      UNION ALL
      SELECT game_tracker_id, '*', language, minute, SUM(ccv), SUM(streams) FROM per_minute GROUP BY 1, 3, 4
      UNION ALL
      SELECT game_tracker_id, '*', '*', minute, SUM(ccv), SUM(streams) FROM per_minute GROUP BY 1, 4
    )
    INSERT INTO game_tracker_bucket_stats
      (game_tracker_id, platform, language, bucket_ts, ccv_sum, stream_sum, ccv_max, minutes)
    SELECT game_tracker_id,
           platform,
           language,
           date_bin(?::interval, minute, ?::timestamptz) AS bucket_ts,
           SUM(ccv)::bigint,
           SUM(streams)::bigint,
           MAX(ccv)::int,
           COUNT(*)::int
    FROM u
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (game_tracker_id, platform, language, bucket_ts) DO UPDATE SET
      ccv_sum    = EXCLUDED.ccv_sum,
      stream_sum = EXCLUDED.stream_sum,
      ccv_max    = EXCLUDED.ccv_max,
      minutes    = EXCLUDED.minutes
    `,
    [start, end, `${BUCKET_ROLLUP_SECONDS} seconds`, BUCKET_EPOCH],
  );
  return { from: start, to: end, rows: result.rowCount };
}

/**
 * The scheduled pass: the last 30 minutes of closed buckets. A bucket is
 * only written once it has fully elapsed (end ≤ now − 90 s), so the live
 * bucket is always read from raw by the endpoints.
 */
export async function rollupRecentBuckets(): Promise<BucketRollupResult> {
  const now = Date.now();
  const to = bucketFloor(new Date(now - 90_000));
  const from = new Date(to.getTime() - 30 * 60_000);
  const result = await rollupBuckets(from, to);
  logger.debug('[GTBuckets] rolled', { from: result.from, to: result.to, rows: result.rows });
  return result;
}

/**
 * Backfill in one-day chunks (oldest first) so a full-history run keeps
 * each statement small. Returns the number of rows upserted.
 */
export async function backfillBuckets(
  from: Date,
  to: Date,
  onChunk?: (r: BucketRollupResult) => void,
): Promise<number> {
  let total = 0;
  let cursor = bucketFloor(from);
  const end = bucketFloor(to);
  while (cursor.getTime() < end.getTime()) {
    const next = new Date(Math.min(cursor.getTime() + 86_400_000, end.getTime()));
    const r = await rollupBuckets(cursor, next);
    total += r.rows;
    onChunk?.(r);
    cursor = next;
  }
  return total;
}
