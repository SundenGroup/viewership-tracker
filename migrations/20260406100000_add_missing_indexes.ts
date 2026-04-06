import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Index for broadcast day status queries (transition logic, orphan sweep)
  await knex.schema.alterTable('broadcast_days', (table) => {
    table.index(['status', 'series_id'], 'broadcast_days_status_series_id_index');
  });

  // Composite index for discovery queries (loading disabled channels by series+active+source)
  await knex.schema.alterTable('channels', (table) => {
    table.index(['series_id', 'is_active', 'source'], 'channels_series_active_source_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('broadcast_days', (table) => {
    table.dropIndex([], 'broadcast_days_status_series_id_index');
  });
  await knex.schema.alterTable('channels', (table) => {
    table.dropIndex([], 'channels_series_active_source_index');
  });
}
