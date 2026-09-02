import type { Knex } from 'knex';

/**
 * game_tracker_bucket_stats — per-tracker, per-platform, 10-minute
 * pre-aggregates of game_tracker_snapshots, so the Trends chart and the
 * 24h/7d/30d timelines stop scanning raw minute rows (the 7-day chart was
 * reading ~4M rows per request; 30 days never finished).
 *
 * One row per (tracker, platform, bucket). platform '*' is the all-platform
 * total (its stream_sum counts distinct channels across every platform).
 * Semantics match rangeAggregate() exactly:
 *   - a minute's total = SUM of that minute's snapshot rows
 *   - a minute's stream count = COUNT(DISTINCT channel_id)
 *   - ccv_sum / stream_sum = sums of those per-minute values over the
 *     bucket, minutes = how many minutes had data → AVG = sum / minutes
 *   - ccv_max = the highest per-minute total inside the bucket
 *
 * Maintained by src/services/gt-bucket-rollup.ts (every 2 minutes for the
 * last half hour, idempotent) and backfilled by scripts/rollup-gt-buckets.ts.
 * Permanent summary — never purged by raw retention.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('game_tracker_bucket_stats', (table) => {
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.string('platform', 32).notNullable(); // '*' = all platforms
    table.timestamp('bucket_ts', { useTz: true }).notNullable(); // 10-min bucket start, epoch-aligned
    table.bigInteger('ccv_sum').notNullable().defaultTo(0);
    table.bigInteger('stream_sum').notNullable().defaultTo(0);
    table.integer('ccv_max').notNullable().defaultTo(0);
    table.integer('minutes').notNullable().defaultTo(0);
    table.primary(['game_tracker_id', 'platform', 'bucket_ts']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_bucket_stats');
}
