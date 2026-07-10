import type { Knex } from 'knex';

/**
 * game_tracker_channel_day_stats — per-tracker, per-channel, per-UTC-day
 * pre-aggregates of game_tracker_snapshots, so month-range queries stop
 * scanning millions of raw minute rows (groundwork for top-20 trackers).
 *
 * Written by the nightly 04:20 UTC rollup cron in src/index.ts
 * (src/services/gt-day-rollup.ts, kill switch GT_ROLLUP=0) and by the
 * manual backfill script scripts/rollup-gt-days.ts. Semantics match the
 * stream_sessions finals (per-minute MAX dedup):
 *   - minutes_live = distinct minutes with a snapshot that day
 *   - ccv_minutes  = SUM of per-minute MAX ccv (viewer-minutes)
 *   - avg_ccv      = round(ccv_minutes / minutes_live)
 *   - peak_ccv     = MAX of per-minute MAX ccv
 *
 * This table is a permanent summary — never purged by raw retention.
 * Existing read endpoints are NOT rewired to it yet.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('game_tracker_channel_day_stats', (table) => {
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.date('day').notNullable(); // UTC calendar day
    table.integer('peak_ccv').notNullable().defaultTo(0);
    table.integer('avg_ccv').notNullable().defaultTo(0);
    table.bigInteger('ccv_minutes').notNullable().defaultTo(0);
    table.integer('minutes_live').notNullable().defaultTo(0);

    table.primary(['game_tracker_id', 'channel_id', 'day']);
  });
  // Range queries: "all channels of tracker X between day A and day B".
  await knex.raw(
    'CREATE INDEX gt_channel_day_stats_tracker_day_idx ON game_tracker_channel_day_stats (game_tracker_id, day)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_channel_day_stats');
}
