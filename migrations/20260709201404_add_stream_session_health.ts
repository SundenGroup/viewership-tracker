import type { Knex } from 'knex';

/**
 * Stream Integrity Signals (Phase 1) — health scoring columns on
 * stream_sessions, written by src/services/stream-health.ts.
 *
 * Plan: docs/plans/2026-07-09-stream-integrity-signals.md.
 *
 * - health_score: composite 0-100 (engagement 40 / curve 30 /
 *   followers 15 / spike-response 15). NULL = not scored (live, too
 *   small, too short, or no chat coverage — never a zero).
 * - health_grade: 'A'-'F' derived from the score.
 * - health_evidence: { engagementPct, cohort, flags, subscores } —
 *   plain-language evidence shipped with every grade ("signals, not
 *   proof").
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stream_sessions', (table) => {
    table.integer('health_score').nullable();
    table.text('health_grade').nullable();
    table.jsonb('health_evidence').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stream_sessions', (table) => {
    table.dropColumn('health_evidence');
    table.dropColumn('health_grade');
    table.dropColumn('health_score');
  });
}
