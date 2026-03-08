import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    // Default tier for channels promoted from auto-discovery
    table.string('discovery_default_tier', 32).notNullable().defaultTo('watch_party');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.dropColumn('discovery_default_tier');
  });
}
