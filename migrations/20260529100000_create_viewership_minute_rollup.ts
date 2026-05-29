import type { Knex } from 'knex';

/**
 * Per-minute viewership rollup — derived materialization of the
 * (channel_id, minute_bucket, ccv) intermediate that EVERY report
 * aggregation in src/models/viewership-snapshot.ts computes on the fly.
 *
 * Why: reports re-aggregate 600K+ raw snapshot rows through a 3-level
 * GROUP BY on every cold load (~18s for a full-series report). That
 * intermediate — "SUM multi-stream per poll cycle, then MAX across poll
 * cycles per minute per channel" — is identical across peak/avg/hours/
 * breakdown/leaderboard/timeseries. Storing it once turns those reads
 * into a scan of a small table (~100ms).
 *
 * Grain: one row per (channel_id, minute_bucket). ccv = the per-channel
 * per-minute value (MAX over poll cycles of the per-cycle multi-stream
 * SUM). Scope ids (broadcast_day_id/stage_id/series_id) are carried for
 * fast scope filtering. Platform/language/region/tier are deliberately
 * NOT stored — reads JOIN channels for those, so channel metadata edits
 * (tier promotion, language fix, view-group changes) flow through to
 * reports immediately without touching the rollup.
 *
 * Consistency: kept exactly in sync with raw via a synchronous
 * statement-level trigger on viewership_snapshots (below). Because every
 * write source — polling orchestrator batch inserts, relay single
 * inserts, manual CSV imports, admin DELETE corrections — goes through
 * the same table, the DB trigger catches them all (an app-level hook
 * would miss the raw-SQL admin operations). Fully rebuildable from raw
 * at any time.
 */
export async function up(knex: Knex): Promise<void> {
  // ── Table ────────────────────────────────────────────────────────────
  await knex.schema.createTable('viewership_minute_rollup', (t) => {
    t.uuid('channel_id').notNullable();
    t.timestamp('minute_bucket', { useTz: true }).notNullable();
    t.integer('ccv').notNullable();
    t.uuid('broadcast_day_id').nullable();
    t.uuid('stage_id').nullable();
    t.uuid('series_id').nullable();
    t.primary(['channel_id', 'minute_bucket']);
  });

  // Scope-filter indexes — each report scopes by exactly one of these.
  await knex.raw(
    `CREATE INDEX viewership_minute_rollup_series_idx
       ON viewership_minute_rollup (series_id, minute_bucket)`,
  );
  await knex.raw(
    `CREATE INDEX viewership_minute_rollup_stage_idx
       ON viewership_minute_rollup (stage_id, minute_bucket)`,
  );
  await knex.raw(
    `CREATE INDEX viewership_minute_rollup_day_idx
       ON viewership_minute_rollup (broadcast_day_id, minute_bucket)`,
  );

  // ── Trigger function ─────────────────────────────────────────────────
  // Recomputes the affected (channel_id, minute_bucket) buckets straight
  // from raw, then upserts; removes rollup rows whose last raw row was
  // deleted. Statement-level + transition tables → fires once per
  // statement, so batch inserts and bulk deletes stay cheap.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION refresh_minute_rollup() RETURNS trigger AS $func$
    BEGIN
      -- IF NOT EXISTS + TRUNCATE keeps this safe when one transaction fires
      -- the trigger across several statements (e.g. a multi-statement admin
      -- correction); ON COMMIT DROP cleans it up at transaction end.
      CREATE TEMP TABLE IF NOT EXISTS _affected (channel_id uuid, minute_bucket timestamptz)
        ON COMMIT DROP;
      TRUNCATE _affected;

      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO _affected
          SELECT DISTINCT channel_id, date_trunc('minute', "timestamp")
          FROM new_rows;
      END IF;
      IF TG_OP IN ('DELETE', 'UPDATE') THEN
        INSERT INTO _affected
          SELECT DISTINCT channel_id, date_trunc('minute', "timestamp")
          FROM old_rows;
      END IF;

      -- Recompute every affected bucket from raw and upsert.
      WITH per_cycle AS (
        SELECT vs.channel_id,
               date_trunc('minute', vs."timestamp") AS minute_bucket,
               vs."timestamp" AS poll_ts,
               SUM(vs.concurrent_viewers) AS cycle_ccv,
               (array_agg(vs.broadcast_day_id))[1] AS bday,
               (array_agg(vs.stage_id))[1]         AS stg,
               (array_agg(vs.series_id))[1]        AS ser
        FROM viewership_snapshots vs
        JOIN (SELECT DISTINCT channel_id, minute_bucket FROM _affected) a
          ON a.channel_id = vs.channel_id
         AND a.minute_bucket = date_trunc('minute', vs."timestamp")
        GROUP BY vs.channel_id, date_trunc('minute', vs."timestamp"), vs."timestamp"
      ),
      per_channel AS (
        SELECT channel_id,
               minute_bucket,
               MAX(cycle_ccv) AS ccv,
               (array_agg(bday ORDER BY cycle_ccv DESC))[1] AS broadcast_day_id,
               (array_agg(stg  ORDER BY cycle_ccv DESC))[1] AS stage_id,
               (array_agg(ser  ORDER BY cycle_ccv DESC))[1] AS series_id
        FROM per_cycle
        GROUP BY channel_id, minute_bucket
      )
      INSERT INTO viewership_minute_rollup
        (channel_id, minute_bucket, ccv, broadcast_day_id, stage_id, series_id)
      SELECT channel_id, minute_bucket, ccv, broadcast_day_id, stage_id, series_id
      FROM per_channel
      ON CONFLICT (channel_id, minute_bucket) DO UPDATE
        SET ccv              = EXCLUDED.ccv,
            broadcast_day_id = EXCLUDED.broadcast_day_id,
            stage_id         = EXCLUDED.stage_id,
            series_id        = EXCLUDED.series_id;

      -- Drop rollup rows whose underlying raw rows were all deleted.
      DELETE FROM viewership_minute_rollup r
      USING _affected a
      WHERE r.channel_id = a.channel_id
        AND r.minute_bucket = a.minute_bucket
        AND NOT EXISTS (
          SELECT 1 FROM viewership_snapshots vs
          WHERE vs.channel_id = a.channel_id
            AND date_trunc('minute', vs."timestamp") = a.minute_bucket
        );

      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql;
  `);

  // ── Triggers (one per op so each declares the right transition table) ─
  await knex.raw(`
    CREATE TRIGGER trg_minute_rollup_ins
      AFTER INSERT ON viewership_snapshots
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION refresh_minute_rollup();
  `);
  await knex.raw(`
    CREATE TRIGGER trg_minute_rollup_upd
      AFTER UPDATE ON viewership_snapshots
      REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION refresh_minute_rollup();
  `);
  await knex.raw(`
    CREATE TRIGGER trg_minute_rollup_del
      AFTER DELETE ON viewership_snapshots
      REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION refresh_minute_rollup();
  `);

  // ── Backfill from all existing snapshots ─────────────────────────────
  // One-shot. Mirrors the per_cycle → per_channel logic over the whole
  // table. ON CONFLICT DO NOTHING so any rows the live trigger wrote
  // during the migration (if a poll lands mid-deploy) are preserved.
  await knex.raw(`
    INSERT INTO viewership_minute_rollup
      (channel_id, minute_bucket, ccv, broadcast_day_id, stage_id, series_id)
    SELECT channel_id, minute_bucket, MAX(cycle_ccv) AS ccv,
           (array_agg(bday ORDER BY cycle_ccv DESC))[1] AS broadcast_day_id,
           (array_agg(stg  ORDER BY cycle_ccv DESC))[1] AS stage_id,
           (array_agg(ser  ORDER BY cycle_ccv DESC))[1] AS series_id
    FROM (
      SELECT channel_id,
             date_trunc('minute', "timestamp") AS minute_bucket,
             "timestamp" AS poll_ts,
             SUM(concurrent_viewers) AS cycle_ccv,
             (array_agg(broadcast_day_id))[1] AS bday,
             (array_agg(stage_id))[1]         AS stg,
             (array_agg(series_id))[1]        AS ser
      FROM viewership_snapshots
      GROUP BY channel_id, date_trunc('minute', "timestamp"), "timestamp"
    ) per_cycle
    GROUP BY channel_id, minute_bucket
    ON CONFLICT (channel_id, minute_bucket) DO NOTHING;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_minute_rollup_ins ON viewership_snapshots');
  await knex.raw('DROP TRIGGER IF EXISTS trg_minute_rollup_upd ON viewership_snapshots');
  await knex.raw('DROP TRIGGER IF EXISTS trg_minute_rollup_del ON viewership_snapshots');
  await knex.raw('DROP FUNCTION IF EXISTS refresh_minute_rollup()');
  await knex.schema.dropTableIfExists('viewership_minute_rollup');
}
