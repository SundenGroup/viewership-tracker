import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE "metric_type" AS ENUM ('vod_views', 'clip_views', 'total_video_views')`);

  await knex.schema.createTable('post_event_metrics', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('channel_id')
      .notNullable()
      .references('id')
      .inTable('channels')
      .onDelete('CASCADE');
    table
      .uuid('broadcast_day_id')
      .references('id')
      .inTable('broadcast_days')
      .onDelete('SET NULL');
    table
      .uuid('series_id')
      .notNullable()
      .references('id')
      .inTable('tournament_series')
      .onDelete('CASCADE');
    table.specificType('metric_type', 'metric_type').notNullable();
    table.bigInteger('value');
    table.timestamp('collected_at').defaultTo(knex.fn.now());
    table.jsonb('metadata').defaultTo('{}');

    table.index('channel_id');
    table.index('series_id');
    table.index('broadcast_day_id');
    table.index('metric_type');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('post_event_metrics');
  await knex.raw('DROP TYPE IF EXISTS "metric_type"');
}
