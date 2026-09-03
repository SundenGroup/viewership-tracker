import type { Knex } from 'knex';

/**
 * Stream health scorer, second shape (plan: docs/plans/2026-09-03-stream-health-scorer.md).
 *
 * The hourly scorer used to rebuild its cohort baselines from 30 days of
 * raw per-minute snapshots on every run (35 minutes of database time per
 * hour, and it starved the event tracker's polls mid-broadcast on
 * 2026-09-03). Now:
 *   - stream_sessions.health_features: the scorer's per-session inputs,
 *     computed once when the session is finalized (or by the backfill).
 *   - stream_health_cohorts: the per (tracker, size band, platform)
 *     baselines, rebuilt nightly from those stored features in seconds.
 *
 * Additive DDL only: a nullable column, a new table, a small partial
 * index for the hourly "what is still unscored" lookup.
 */
export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('stream_sessions', 'health_features');
  if (!hasCol) {
    await knex.schema.alterTable('stream_sessions', (t) => {
      t.jsonb('health_features').nullable();
    });
  }
  const hasTable = await knex.schema.hasTable('stream_health_cohorts');
  if (!hasTable) {
    await knex.schema.createTable('stream_health_cohorts', (t) => {
      t.uuid('game_tracker_id').notNullable()
        .references('id').inTable('game_trackers').onDelete('CASCADE');
      t.string('band', 16).notNullable();      // 50-200 | 200-1k | 1k-5k | 5k-20k | 20k+
      t.string('platform', 32).notNullable();  // '*' = the mixed all-platform slice
      t.decimal('p99_rise', 12, 6).nullable();
      t.jsonb('sessions').notNullable().defaultTo('[]'); // [{ch, eng, conv, cv}]
      t.integer('session_count').notNullable().defaultTo(0);
      t.integer('channel_count').notNullable().defaultTo(0);
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['game_tracker_id', 'band', 'platform']);
    });
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS stream_sessions_unscored_idx
      ON stream_sessions (ended_at)
      WHERE status = 'ended' AND health_score IS NULL AND health_features IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS stream_sessions_unscored_idx');
  await knex.schema.dropTableIfExists('stream_health_cohorts');
  const hasCol = await knex.schema.hasColumn('stream_sessions', 'health_features');
  if (hasCol) {
    await knex.schema.alterTable('stream_sessions', (t) => {
      t.dropColumn('health_features');
    });
  }
}
