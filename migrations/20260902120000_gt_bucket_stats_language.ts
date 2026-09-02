import type { Knex } from 'knex';

/**
 * game_tracker_bucket_stats_v2 — the 10-minute rollup with a language
 * dimension, so the share-of-watch-time breakdown (platform AND language)
 * is served from the rollup for any window.
 *
 * Rows exist for every combination of (platform | '*') × (language | '*'):
 * the timeline reads ('*' or one platform, '*'), the platform breakdown
 * reads (platform, '*'), the language breakdown reads ('*' or the
 * platform filter, language). Same semantics as v1 otherwise.
 *
 * A NEW table rather than an ALTER/DROP of v1: the nightly backups run
 * pg_dump for long stretches (and overlap), holding AccessShare locks on
 * every table, so any DDL on an existing table can wait indefinitely —
 * this migration blocked the app from booting once. CREATE TABLE needs
 * no lock on existing data. v1 is dropped by a later migration.
 * Rebuilt from raw by scripts/rollup-gt-buckets.ts --all.
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('game_tracker_bucket_stats_v2');
  if (exists) return;
  await knex.schema.createTable('game_tracker_bucket_stats_v2', (table) => {
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.string('platform', 32).notNullable(); // '*' = all platforms
    table.string('language', 16).notNullable(); // '*' = all languages, '-' = untagged
    table.timestamp('bucket_ts', { useTz: true }).notNullable(); // 10-min bucket start, epoch-aligned
    table.bigInteger('ccv_sum').notNullable().defaultTo(0);
    table.bigInteger('stream_sum').notNullable().defaultTo(0);
    table.integer('ccv_max').notNullable().defaultTo(0);
    table.integer('minutes').notNullable().defaultTo(0);
    table.primary(['game_tracker_id', 'platform', 'language', 'bucket_ts']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_bucket_stats_v2');
}
