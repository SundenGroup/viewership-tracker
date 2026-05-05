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

export async function rangeAggregate(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  bucketSeconds = 60,
): Promise<Array<{ ts: Date; total_ccv: number; stream_count: number }>> {
  return db(TABLE)
    .select(
      db.raw(`date_bin(?::interval, "timestamp", ?::timestamptz) as ts`, [
        `${bucketSeconds} seconds`,
        fromTs,
      ]),
    )
    .sum<{ total_ccv: string }[]>({ total_ccv: 'concurrent_viewers' })
    .countDistinct<{ stream_count: string }[]>({ stream_count: 'channel_id' })
    .where('game_tracker_id', gameTrackerId)
    .where('timestamp', '>=', fromTs)
    .where('timestamp', '<', toTs)
    .groupBy('ts')
    .orderBy('ts', 'asc') as unknown as Promise<
    Array<{ ts: Date; total_ccv: number; stream_count: number }>
  >;
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
