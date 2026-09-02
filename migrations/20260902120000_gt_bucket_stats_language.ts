import type { Knex } from 'knex';

/**
 * game_tracker_bucket_stats gains a language dimension so the share-of-
 * watch-time breakdown (platform AND language) is served from the rollup
 * for any window, instead of raw rows or day stats.
 *
 * Rows exist for every combination of (platform | '*') × (language | '*'):
 * the timeline reads ('*' or one platform, '*'), the platform breakdown
 * reads (platform, '*'), the language breakdown reads ('*' or the
 * platform filter, language). Same semantics as before otherwise.
 *
 * The table was created earlier today and is rebuilt from raw by
 * scripts/rollup-gt-buckets.ts --all, so recreate rather than migrate rows.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_bucket_stats');
  await knex.schema.createTable('game_tracker_bucket_stats', (table) => {
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
  await knex.schema.dropTableIfExists('game_tracker_bucket_stats');
  await knex.schema.createTable('game_tracker_bucket_stats', (table) => {
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.string('platform', 32).notNullable();
    table.timestamp('bucket_ts', { useTz: true }).notNullable();
    table.bigInteger('ccv_sum').notNullable().defaultTo(0);
    table.bigInteger('stream_sum').notNullable().defaultTo(0);
    table.integer('ccv_max').notNullable().defaultTo(0);
    table.integer('minutes').notNullable().defaultTo(0);
    table.primary(['game_tracker_id', 'platform', 'bucket_ts']);
  });
}
