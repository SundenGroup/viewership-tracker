import type { Knex } from 'knex';

/**
 * Supporting indexes for the Discover fast paths:
 *   - game_tracker_bucket_stats_v2 (game_tracker_id, bucket_ts): the
 *     breakdown reads "every platform/language row inside a window"; the
 *     primary key leads with platform + language, so that pattern had to
 *     skip through the whole tracker's key space (1.4 s for 24 h).
 *   - game_tracker_channel_day_stats covering index: the week/month
 *     leaderboards read only these columns, so the scan becomes index-only.
 *
 * Created CONCURRENTLY (no write lock); knex must not wrap it in a
 * transaction. Both already exist in production (created by hand on
 * 2026-09-02) — IF NOT EXISTS keeps this a no-op there.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS gt_bucket_stats_v2_tracker_ts_idx ON game_tracker_bucket_stats_v2 (game_tracker_id, bucket_ts)',
  );
  await knex.raw(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS gt_channel_day_stats_tracker_day_cover_idx ON game_tracker_channel_day_stats (game_tracker_id, day) INCLUDE (channel_id, peak_ccv, ccv_minutes, minutes_live)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS gt_bucket_stats_v2_tracker_ts_idx');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS gt_channel_day_stats_tracker_day_cover_idx');
}
