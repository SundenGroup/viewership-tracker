import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    // Reuses the user_role enum created in the previous migration
    table.specificType('min_role', 'user_role').notNullable().defaultTo('viewer');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.dropColumn('min_role');
  });
}
