import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE "platform_type" AS ENUM ('twitch', 'youtube', 'kick', 'tiktok')`);
  await knex.raw(`CREATE TYPE "channel_tier" AS ENUM ('primary', 'secondary', 'community', 'watch_party')`);
  await knex.raw(`CREATE TYPE "channel_source" AS ENUM ('manual', 'auto_discovered')`);

  await knex.schema.createTable('channels', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('series_id')
      .notNullable()
      .references('id')
      .inTable('tournament_series')
      .onDelete('CASCADE');
    table.specificType('platform', 'platform_type').notNullable();
    table.string('channel_identifier').notNullable();
    table.string('display_name').notNullable();
    table.string('language', 5);
    table.string('region');
    table.specificType('tier', 'channel_tier').defaultTo('community');
    table.specificType('source', 'channel_source').defaultTo('manual');
    table.boolean('is_active').defaultTo(false);
    table.timestamp('added_at').defaultTo(knex.fn.now());
    table.jsonb('metadata').defaultTo('{}');

    table.unique(['series_id', 'platform', 'channel_identifier']);
    table.index('series_id');
    table.index('platform');
    table.index('is_active');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('channels');
  await knex.raw('DROP TYPE IF EXISTS "channel_source"');
  await knex.raw('DROP TYPE IF EXISTS "channel_tier"');
  await knex.raw('DROP TYPE IF EXISTS "platform_type"');
}
