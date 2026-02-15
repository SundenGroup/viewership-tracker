import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('viewership_snapshots', (table) => {
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
      .uuid('stage_id')
      .references('id')
      .inTable('stages')
      .onDelete('SET NULL');
    table
      .uuid('series_id')
      .references('id')
      .inTable('tournament_series')
      .onDelete('SET NULL');
    table.timestamp('timestamp', { useTz: true }).notNullable();
    table.integer('concurrent_viewers').notNullable().defaultTo(0);
    table.string('platform');
    table.string('language');
    table.string('region');

    table.index(['series_id', 'timestamp']);
    table.index(['broadcast_day_id', 'timestamp']);
    table.index(['channel_id', 'timestamp']);
    table.index('stage_id');
    table.index('platform');
    table.index('language');
    table.index('region');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('viewership_snapshots');
}
