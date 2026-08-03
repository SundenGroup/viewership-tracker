import type { Knex } from 'knex';

/**
 * SOOP as a fourth Discover platform.
 *
 * Category ids are SOOP's 8-digit ZERO-PADDED codes ("00040066" = PUBG:
 * Battlegrounds) — strings, never integers: parseInt would eat the
 * leading zeros and corrupt the id.
 */
export async function up(knex: Knex): Promise<void> {
  // Fail fast if a backup holds the lock (same guard as every DDL here).
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.schema.alterTable('game_trackers', (t) => {
    t.string('soop_category_id').nullable();
    t.string('soop_category_name').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_trackers', (t) => {
    t.dropColumn('soop_category_id');
    t.dropColumn('soop_category_name');
  });
}
