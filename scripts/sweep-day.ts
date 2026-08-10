#!/usr/bin/env npx tsx
/**
 * End-of-broadcast-day sweep — one command for the repairs that were
 * being run by hand after every PGS7 day:
 *
 *   1. (optional) TRIM: delete everything from --trim HH:MM (CEST) on,
 *      for when the broadcast ended before the scheduled window.
 *   2. TikTok GAP FILL: 1–10-minute holes with live readings on both
 *      sides (relay reconnects) get linear interpolation. Longer
 *      silences are left alone — they may be genuine offline stretches.
 *   3. TikTok COLLAPSE REPAIR: single-minute plunges below half of both
 *      neighbours (stale relay re-emits) become the neighbour average.
 *   4. TikTok TERMINAL ZERO: a final-minute 0 after a STABLE level is
 *      the relay's zero-on-disconnect — carried forward from the last
 *      real reading. A declining tail (…372 → 116 → 0) is a genuine
 *      wind-down and is kept.
 *
 * Everything runs in ONE transaction with previewed counts; --dry-run
 * rolls back instead of committing. The ingest guard (relay-side)
 * prevents most new collapses; this is the backstop and the historian.
 *
 * Usage:
 *   npx tsx scripts/sweep-day.ts --day 2026-08-09              # by date
 *   npx tsx scripts/sweep-day.ts --day "Final Stage - Day 2"   # by label
 *   npx tsx scripts/sweep-day.ts --day 2026-08-09 --trim 15:21
 *   npx tsx scripts/sweep-day.ts --day 2026-08-09 --dry-run
 */
import db from '../src/utils/db';

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const DRY = process.argv.includes('--dry-run');
const DAY_ARG = arg('--day');
const TRIM = arg('--trim'); // "HH:MM" in CEST

async function main() {
  if (!DAY_ARG) {
    console.error('Required: --day <YYYY-MM-DD | label fragment>');
    process.exit(1);
  }
  if (TRIM && !/^\d{1,2}:\d{2}$/.test(TRIM)) {
    console.error('--trim must be HH:MM (CEST)');
    process.exit(1);
  }

  const dayQuery = db('broadcast_days')
    .where('series_id', db('tournament_series').select('id').where('short_name', 'PGSC3'))
    .orderBy('broadcast_start');
  if (/^\d{4}-\d{2}-\d{2}$/.test(DAY_ARG)) {
    dayQuery.whereRaw(`(broadcast_start AT TIME ZONE 'Europe/Berlin')::date = ?`, [DAY_ARG]);
  } else {
    dayQuery.where('label', 'ilike', `%${DAY_ARG}%`);
  }
  const days = await dayQuery.select('id', 'label', 'broadcast_start');
  if (days.length !== 1) {
    console.error(
      days.length === 0
        ? `No PGSC3 broadcast day matches "${DAY_ARG}"`
        : `Ambiguous — matches: ${days.map((d) => d.label).join(' | ')}`,
    );
    process.exit(1);
  }
  const day = days[0];
  console.log(`Sweeping "${day.label}" (${day.id})${DRY ? ' — DRY RUN' : ''}`);

  await db.transaction(async (trx) => {
    await trx.raw('SET LOCAL statement_timeout = 0');

    // ── 1. Optional trim ──
    if (TRIM) {
      const cutUtc = await trx.raw(
        `SELECT ((broadcast_start AT TIME ZONE 'Europe/Berlin')::date::text || ' ' || ?)::timestamp
                AT TIME ZONE 'Europe/Berlin' AS cut
         FROM broadcast_days WHERE id = ?`,
        [TRIM, day.id],
      );
      const cut = cutUtc.rows[0].cut;
      const preview = await trx('viewership_snapshots')
        .where('broadcast_day_id', day.id).where('timestamp', '>=', cut)
        .count<{ count: string }[]>('* as count');
      const n = Number(preview[0].count);
      const deleted = await trx('viewership_snapshots')
        .where('broadcast_day_id', day.id).where('timestamp', '>=', cut)
        .delete();
      if (deleted !== n) throw new Error(`trim mismatch: previewed ${n}, deleted ${deleted}`);
      console.log(`  trim ≥ ${TRIM} CEST: ${deleted} row(s) removed`);
    }

    // ── 2. Gap fill ──
    const fills = await trx.raw(
      `
      WITH m AS (
        SELECT channel_id, date_trunc('minute', timestamp) AS minute, MAX(concurrent_viewers) AS ccv
        FROM viewership_snapshots
        WHERE broadcast_day_id = ? AND platform = 'tiktok' GROUP BY 1, 2),
      gaps AS (
        SELECT channel_id, minute AS r_min, ccv AS r_ccv,
               LAG(minute) OVER (PARTITION BY channel_id ORDER BY minute) AS l_min,
               LAG(ccv) OVER (PARTITION BY channel_id ORDER BY minute) AS l_ccv
        FROM m),
      f AS (
        SELECT g.channel_id, gs.minute,
               (g.l_ccv + (g.r_ccv - g.l_ccv)
                 * EXTRACT(epoch FROM (gs.minute - g.l_min))
                 / NULLIF(EXTRACT(epoch FROM (g.r_min - g.l_min)), 0))::int AS ccv
        FROM gaps g
        CROSS JOIN LATERAL generate_series(g.l_min + interval '1 minute',
                                           g.r_min - interval '1 minute', interval '1 minute') gs(minute)
        WHERE g.l_min IS NOT NULL
          AND g.r_min - g.l_min > interval '1 minute' AND g.r_min - g.l_min <= interval '10 minutes'
          AND g.l_ccv > 0 AND g.r_ccv > 0)
      INSERT INTO viewership_snapshots (channel_id, broadcast_day_id, stage_id, series_id, timestamp,
                                        concurrent_viewers, platform, language, region)
      SELECT f.channel_id, ?, bd.stage_id, bd.series_id, f.minute, f.ccv, 'tiktok', c.language, c.region
      FROM f JOIN channels c ON c.id = f.channel_id
      JOIN broadcast_days bd ON bd.id = ?
      WHERE NOT EXISTS (SELECT 1 FROM viewership_snapshots x
        WHERE x.channel_id = f.channel_id AND date_trunc('minute', x.timestamp) = f.minute)
      `,
      [day.id, day.id, day.id],
    );
    console.log(`  gap fill: ${fills.rowCount} minute(s) interpolated`);

    // ── 3. Collapse repair ──
    const collapses = await trx.raw(
      `
      WITH m AS (
        SELECT channel_id, date_trunc('minute', timestamp) AS minute, MAX(concurrent_viewers) AS ccv
        FROM viewership_snapshots
        WHERE broadcast_day_id = ? AND platform = 'tiktok' GROUP BY 1, 2),
      w AS (
        SELECT channel_id, minute, ccv,
               LAG(ccv) OVER (PARTITION BY channel_id ORDER BY minute) AS prev,
               LEAD(ccv) OVER (PARTITION BY channel_id ORDER BY minute) AS next
        FROM m),
      bad AS (
        SELECT channel_id, minute, ((prev + next) / 2)::int AS fixed
        FROM w WHERE prev >= 50 AND next >= 50 AND ccv < 0.5 * prev AND ccv < 0.5 * next)
      UPDATE viewership_snapshots v SET concurrent_viewers = bad.fixed
      FROM bad WHERE v.channel_id = bad.channel_id AND v.broadcast_day_id = ?
        AND date_trunc('minute', v.timestamp) = bad.minute
      `,
      [day.id, day.id],
    );
    console.log(`  collapse repair: ${collapses.rowCount} minute(s) corrected`);

    // ── 4. Terminal zero after a stable level ──
    const tails = await trx.raw(
      `
      WITH m AS (
        SELECT channel_id, date_trunc('minute', timestamp) AS minute, MAX(concurrent_viewers) AS ccv
        FROM viewership_snapshots
        WHERE broadcast_day_id = ? AND platform = 'tiktok' GROUP BY 1, 2),
      w AS (
        SELECT channel_id, minute, ccv,
               LAG(ccv)     OVER (PARTITION BY channel_id ORDER BY minute) AS prev,
               LAG(ccv, 2)  OVER (PARTITION BY channel_id ORDER BY minute) AS prev2,
               LEAD(minute) OVER (PARTITION BY channel_id ORDER BY minute) AS nxt
        FROM m),
      bad AS (
        SELECT channel_id, minute, prev AS fixed
        FROM w
        WHERE nxt IS NULL AND ccv = 0
          AND prev >= 50 AND prev2 IS NOT NULL
          AND abs(prev - prev2) <= 0.2 * prev2)   -- stable level, not a wind-down
      UPDATE viewership_snapshots v SET concurrent_viewers = bad.fixed
      FROM bad WHERE v.channel_id = bad.channel_id AND v.broadcast_day_id = ?
        AND date_trunc('minute', v.timestamp) = bad.minute
      `,
      [day.id, day.id],
    );
    console.log(`  terminal-zero fix: ${tails.rowCount} row(s)`);

    if (DRY) throw new Error('__dry_run_rollback__');
  }).catch((err: Error) => {
    if (err.message === '__dry_run_rollback__') {
      console.log('Dry run — all changes rolled back.');
      return;
    }
    throw err;
  });

  if (!DRY) console.log('Committed.');
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Fatal:', err.message);
  await db.destroy();
  process.exit(1);
});
