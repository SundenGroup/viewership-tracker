import type { Knex } from 'knex';

/**
 * Add a unique index to prevent duplicate TikTok relay snapshots within the same minute.
 * This is a safety net — the relay code already deduplicates, but concurrent requests
 * from multiple relay sources can race past the code-level check.
 *
 * Uses a partial index (WHERE platform = 'tiktok') so it only affects relay data
 * and doesn't interfere with other platforms that may legitimately have multiple
 * snapshots per minute (e.g. YouTube multi-stream).
 */
export async function up(knex: Knex): Promise<void> {
  // First, clean up any existing duplicates (keep highest CCV per minute per channel)
  await knex.raw(`
    DELETE FROM viewership_snapshots
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY channel_id, date_trunc('minute', "timestamp")
            ORDER BY concurrent_viewers DESC, id DESC
          ) AS rn
        FROM viewership_snapshots
        WHERE platform = 'tiktok'
      ) sub
      WHERE rn > 1
    )
  `);

  // Create an immutable wrapper for date_trunc (needed for index expressions)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION trunc_minute_immutable(ts timestamptz)
    RETURNS timestamptz AS $$
      SELECT date_trunc('minute', ts);
    $$ LANGUAGE SQL IMMUTABLE STRICT
  `);

  // Create unique partial index using the immutable wrapper
  await knex.raw(`
    CREATE UNIQUE INDEX viewership_snapshots_tiktok_dedup
    ON viewership_snapshots (channel_id, (trunc_minute_immutable("timestamp")))
    WHERE platform = 'tiktok'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS viewership_snapshots_tiktok_dedup');
  await knex.raw('DROP FUNCTION IF EXISTS trunc_minute_immutable(timestamptz)');
}
