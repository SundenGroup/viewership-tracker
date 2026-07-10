/**
 * Raw-snapshot retention — nightly purge of expired game_tracker_snapshots
 * rows for trackers with a retain_raw_days window set (NULL = keep raw
 * minute rows forever; the partner trackers stay NULL).
 *
 * Scheduled at 04:40 UTC from src/index.ts (kill switch RAW_RETENTION=0),
 * after the 04:20 day-stats rollup — a day is always summarized into
 * game_tracker_channel_day_stats before its raw rows can age out.
 *
 * Deletes run in batches of 50k rows via a ctid subselect so no single
 * statement holds locks for long, each batch in its own transaction with
 * SET LOCAL statement_timeout = 0 (the server default would kill large
 * scans) and a 40P01 deadlock retry — the live poll cycle writes the same
 * table.
 *
 * NEVER purged here (permanent summaries): stream_sessions,
 * chat_minute_rollup, channel_follower_snapshots,
 * game_tracker_channel_day_stats.
 */

import db from '../utils/db';
import logger from '../utils/logger';

const BATCH_SIZE = 50_000;

/** Retry transient Postgres deadlocks (40P01) — the live poll cycle inserts
 *  into the same table; a collision aborts one of the two, so just re-run. */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' || i >= attempts) throw err;
      const wait = 2000 * i + Math.floor(Math.random() * 1500);
      logger.warn('[RawRetention] deadlock with live poll cycle — retrying', {
        waitMs: wait,
        attempt: `${i}/${attempts - 1}`,
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export interface TrackerPurgeResult {
  slug: string;
  retainRawDays: number;
  purged: number;
  batches: number;
}

/**
 * Purge expired raw snapshots for every tracker with retain_raw_days set.
 * Returns per-tracker counts (also logged). Safe to re-run any time.
 */
export async function purgeExpiredRawSnapshots(
  batchSize = BATCH_SIZE,
): Promise<TrackerPurgeResult[]> {
  const trackers = await db('game_trackers')
    .select<Array<{ id: string; slug: string; retain_raw_days: number }>>(
      'id', 'slug', 'retain_raw_days',
    )
    .whereNotNull('retain_raw_days')
    .orderBy('slug', 'asc');

  const results: TrackerPurgeResult[] = [];
  for (const tracker of trackers) {
    // One cutoff per tracker run — batches stay consistent even if the
    // loop takes a while.
    const cutoff = new Date(Date.now() - tracker.retain_raw_days * 86_400_000);
    let purged = 0;
    let batches = 0;

    for (;;) {
      const deleted = await withDeadlockRetry(() =>
        db.transaction(async (trx) => {
          await trx.raw('SET LOCAL statement_timeout = 0');
          const res = await trx.raw<{ rowCount: number }>(
            `
            DELETE FROM game_tracker_snapshots
            WHERE ctid IN (
              SELECT ctid FROM game_tracker_snapshots
              WHERE game_tracker_id = ?
                AND "timestamp" < ?
              LIMIT ?
            )
            `,
            [tracker.id, cutoff, batchSize],
          );
          return res.rowCount;
        }),
      );
      purged += deleted;
      if (deleted > 0) batches++;
      if (deleted < batchSize) break;
    }

    results.push({
      slug: tracker.slug,
      retainRawDays: tracker.retain_raw_days,
      purged,
      batches,
    });
    logger.info('[RawRetention] tracker purge complete', {
      tracker: tracker.slug,
      retainRawDays: tracker.retain_raw_days,
      cutoff: cutoff.toISOString(),
      purged,
      batches,
    });
  }
  return results;
}
