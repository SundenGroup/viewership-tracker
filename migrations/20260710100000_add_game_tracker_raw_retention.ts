import type { Knex } from 'knex';

/**
 * Mixed raw-snapshot retention — per-tracker retain_raw_days on
 * game_trackers, consumed by the nightly purge cron in src/index.ts
 * (src/services/raw-retention.ts, kill switch RAW_RETENTION=0).
 *
 * - NULL = keep raw per-minute game_tracker_snapshots rows forever
 *   (the three partner trackers: pubg-battlegrounds, geoguessr, goals).
 * - 30 = purge raw rows older than 30 days. Every other existing tracker
 *   gets 30 here, and the column DEFAULT is 30 so future trackers
 *   inherit it — new trackers keep 30 days of raw minutes unless an
 *   operator deliberately NULLs it.
 *
 * Only the raw snapshot table is ever purged. stream_sessions,
 * chat_minute_rollup, channel_follower_snapshots and (once populated)
 * game_tracker_channel_day_stats are the permanent summaries and are
 * NEVER touched by retention.
 */

const KEEP_FOREVER_SLUGS = ['pubg-battlegrounds', 'geoguessr', 'goals'];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_trackers', (table) => {
    table.integer('retain_raw_days').nullable();
  });

  // Existing trackers: partners keep raw forever (stay NULL), everyone
  // else gets the 30-day window.
  await knex('game_trackers')
    .whereNotIn('slug', KEEP_FOREVER_SLUGS)
    .update({ retain_raw_days: 30 });

  // Future trackers inherit 30 by default.
  await knex.raw('ALTER TABLE game_trackers ALTER COLUMN retain_raw_days SET DEFAULT 30');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_trackers', (table) => {
    table.dropColumn('retain_raw_days');
  });
}
