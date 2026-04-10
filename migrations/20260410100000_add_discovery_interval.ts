import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    // Per-series discovery interval in milliseconds.
    // NULL = use global DISCOVERY_INTERVAL_MS env var.
    table.integer('discovery_interval_ms').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.dropColumn('discovery_interval_ms');
  });
}
