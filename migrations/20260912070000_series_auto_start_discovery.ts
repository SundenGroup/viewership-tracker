import type { Knex } from 'knex';

/**
 * Per-series "Auto-start Scout" switch.
 *
 * Until now Scout (event-side discovery) only ever started from the Start
 * button; when a broadcast day went live with nobody at the keyboard, no
 * co-stream was tracked (PAS2 Playoffs 1 Day 1, night of 2026-09-11, had
 * to be back-filled from Discover). With the switch on, the orchestrator
 * starts Scout for the series the moment one of its days goes live, and
 * switching it on while a day is already live starts Scout right away.
 *
 * Additive DDL only: one boolean column with a default, no rewrite.
 */
export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('tournament_series', 'auto_start_discovery');
  if (!hasCol) {
    await knex.schema.alterTable('tournament_series', (t) => {
      t.boolean('auto_start_discovery').notNullable().defaultTo(false);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('tournament_series', 'auto_start_discovery');
  if (hasCol) {
    await knex.schema.alterTable('tournament_series', (t) => {
      t.dropColumn('auto_start_discovery');
    });
  }
}
