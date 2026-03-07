import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.boolean('auto_start_polling').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tournament_series', (table) => {
    table.dropColumn('auto_start_polling');
  });
}
