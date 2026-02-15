import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.createTable('tournament_series', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('short_name');
    table.string('game');
    table.string('partner');
    table
      .enum('status', ['draft', 'active', 'completed'], {
        useNative: true,
        enumName: 'tournament_status',
      })
      .defaultTo('draft');
    table.date('start_date');
    table.date('end_date');
    table.jsonb('discovery_keywords').defaultTo('[]');
    table.jsonb('discovery_game_ids').defaultTo('{}');
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tournament_series');
  await knex.raw('DROP TYPE IF EXISTS "tournament_status"');
}
