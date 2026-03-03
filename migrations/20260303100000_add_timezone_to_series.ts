import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.string('timezone', 64).notNullable().defaultTo('UTC');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.dropColumn('timezone');
  });
}
