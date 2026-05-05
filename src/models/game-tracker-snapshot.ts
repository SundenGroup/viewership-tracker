import db from '../utils/db';

export interface GameTrackerSnapshot {
  id: string;
  game_tracker_id: string;
  channel_id: string;
  timestamp: Date;
  concurrent_viewers: number;
  platform: string;
  language: string | null;
  region: string | null;
  stream_id: string | null;
  stream_title: string | null;
  game_name: string | null;
  started_at: Date | null;
}

export interface InsertSnapshot {
  game_tracker_id: string;
  channel_id: string;
  timestamp: Date;
  concurrent_viewers: number;
  platform: string;
  language?: string | null;
  region?: string | null;
  stream_id?: string | null;
  stream_title?: string | null;
  game_name?: string | null;
  started_at?: Date | null;
}

const TABLE = 'game_tracker_snapshots';

export async function bulkInsert(rows: InsertSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db(TABLE).insert(rows);
  return rows.length;
}

/**
 * Aggregate snapshots into time buckets for trend rendering.
 *
 * CCV is a point-in-time quantity — concurrent viewers AT a moment, not
 * a flow. Naively SUM-ing all rows in a bucket inflates the value by
 * the number of minutes in the bucket (every channel writes one row
 * per minute). The correct shape is two steps:
 *   1. SUM per minute → "total concurrent viewers across all channels
 *      at this minute" (this IS a sum because the channels are distinct
 *      at the same instant).
 *   2. AVG over minutes inside the bucket → "typical total CCV across
 *      this 5-min window".
 *
 * Same logic for stream_count: count distinct channels per minute,
 * then average minutes within the bucket. (Counting distinct directly
 * across the full bucket double-counts a streamer that appears in 5
 * consecutive minutes only once, so the per-minute approach is also
 * what the user expects when reading the chart.)
 */
export async function rangeAggregate(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  bucketSeconds = 60,
): Promise<Array<{ ts: Date; total_ccv: number; stream_count: number }>> {
  const rows = await db.raw<{
    rows: Array<{ ts: Date; total_ccv: string | null; stream_count: string | null }>;
  }>(
    `
    WITH per_minute AS (
      SELECT
        date_trunc('minute', "timestamp") AS minute_ts,
        SUM(concurrent_viewers) AS minute_total_ccv,
        COUNT(DISTINCT channel_id) AS minute_stream_count
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ?
        AND "timestamp" >= ?
        AND "timestamp" < ?
      GROUP BY minute_ts
    )
    SELECT
      date_bin(?::interval, minute_ts, ?::timestamptz) AS ts,
      AVG(minute_total_ccv)::float AS total_ccv,
      AVG(minute_stream_count)::float AS stream_count
    FROM per_minute
    GROUP BY ts
    ORDER BY ts ASC
    `,
    [gameTrackerId, fromTs, toTs, `${bucketSeconds} seconds`, fromTs],
  );
  return rows.rows.map((r) => ({
    ts: r.ts,
    total_ccv: r.total_ccv ? Math.round(Number(r.total_ccv)) : 0,
    stream_count: r.stream_count ? Math.round(Number(r.stream_count)) : 0,
  }));
}

export async function leaderboardAt(
  gameTrackerId: string,
  at: Date,
  windowSeconds = 120,
  limit = 50,
): Promise<
  Array<{
    channel_id: string;
    concurrent_viewers: number;
    stream_title: string | null;
    platform: string;
    language: string | null;
    timestamp: Date;
  }>
> {
  // Pick the most recent row per channel within [at-window, at]
  const fromTs = new Date(at.getTime() - windowSeconds * 1000);
  return db
    .select<
      Array<{
        channel_id: string;
        concurrent_viewers: number;
        stream_title: string | null;
        platform: string;
        language: string | null;
        timestamp: Date;
      }>
    >('s.channel_id', 's.concurrent_viewers', 's.stream_title', 's.platform', 's.language', 's.timestamp')
    .from(
      db.raw(
        `(
          SELECT DISTINCT ON (channel_id)
            channel_id, concurrent_viewers, stream_title, platform, language, "timestamp"
          FROM game_tracker_snapshots
          WHERE game_tracker_id = ?
            AND "timestamp" >= ?
            AND "timestamp" <= ?
          ORDER BY channel_id, "timestamp" DESC
        ) s`,
        [gameTrackerId, fromTs, at],
      ),
    )
    .orderBy('s.concurrent_viewers', 'desc')
    .limit(limit);
}

export async function rangeLeaderboard(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  limit = 50,
): Promise<
  Array<{
    channel_id: string;
    peak_ccv: number;
    avg_ccv: number;
    minutes_live: number;
    platform: string;
    language: string | null;
  }>
> {
  // Per-channel aggregates within the range. avg_ccv is the AVERAGE
  // CCV across all snapshots in the range (so a streamer who was live
  // for 10 minutes at 100 viewers gets avg=100, not avg=33 if the
  // window was 30 minutes long). Sort by peak DESC.
  const rows = await db.raw<{
    rows: Array<{
      channel_id: string;
      peak_ccv: string;
      avg_ccv: string;
      minutes_live: string;
      platform: string;
      language: string | null;
    }>;
  }>(
    `
    SELECT
      channel_id,
      MAX(concurrent_viewers) AS peak_ccv,
      AVG(concurrent_viewers)::int AS avg_ccv,
      COUNT(DISTINCT date_trunc('minute', "timestamp")) AS minutes_live,
      MAX(platform) AS platform,
      MAX(language) AS language
    FROM game_tracker_snapshots
    WHERE game_tracker_id = ?
      AND "timestamp" >= ?
      AND "timestamp" < ?
    GROUP BY channel_id
    ORDER BY peak_ccv DESC
    LIMIT ?
    `,
    [gameTrackerId, fromTs, toTs, limit],
  );
  return rows.rows.map((r) => ({
    channel_id: r.channel_id,
    peak_ccv: Number(r.peak_ccv),
    avg_ccv: Number(r.avg_ccv),
    minutes_live: Number(r.minutes_live),
    platform: r.platform,
    language: r.language,
  }));
}

export async function languageBreakdown(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ language: string | null; total_ccv_minutes: number; peak: number }>> {
  return db(TABLE)
    .select('language')
    .sum<{ total_ccv_minutes: string }[]>({ total_ccv_minutes: 'concurrent_viewers' })
    .max<{ peak: number }[]>({ peak: 'concurrent_viewers' })
    .where('game_tracker_id', gameTrackerId)
    .where('timestamp', '>=', fromTs)
    .where('timestamp', '<', toTs)
    .groupBy('language')
    .orderBy('total_ccv_minutes', 'desc') as unknown as Promise<
    Array<{ language: string | null; total_ccv_minutes: number; peak: number }>
  >;
}

export async function platformBreakdown(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ platform: string; total_ccv_minutes: number; peak: number }>> {
  return db(TABLE)
    .select('platform')
    .sum<{ total_ccv_minutes: string }[]>({ total_ccv_minutes: 'concurrent_viewers' })
    .max<{ peak: number }[]>({ peak: 'concurrent_viewers' })
    .where('game_tracker_id', gameTrackerId)
    .where('timestamp', '>=', fromTs)
    .where('timestamp', '<', toTs)
    .groupBy('platform')
    .orderBy('total_ccv_minutes', 'desc') as unknown as Promise<
    Array<{ platform: string; total_ccv_minutes: number; peak: number }>
  >;
}

export async function purgeOlderThan(daysOld: number): Promise<number> {
  return db(TABLE)
    .where('timestamp', '<', db.raw(`NOW() - INTERVAL '? days'`, [daysOld]))
    .delete();
}
