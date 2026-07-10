#!/usr/bin/env npx tsx
/**
 * Manual / backfill run of the game-tracker daily rollup
 * (src/services/gt-day-rollup.ts) — upserts per-tracker per-channel
 * per-UTC-day stats into game_tracker_channel_day_stats from raw
 * game_tracker_snapshots, using per-minute MAX dedup semantics.
 *
 * Idempotent: re-running a day recomputes and overwrites the same
 * (tracker, channel, day) rows. Days end at YESTERDAY (UTC) — today is
 * partial and is covered by the nightly 04:20 UTC cron tomorrow.
 *
 * Usage:
 *   npx tsx scripts/rollup-gt-days.ts              # last 3 completed days
 *   npx tsx scripts/rollup-gt-days.ts --days 30
 *   npx tsx scripts/rollup-gt-days.ts --all        # every day since the
 *                                                  # oldest raw snapshot
 *
 * A full-history run scans every raw snapshot row — lift the DB's
 * statement_timeout for this run. Run with DB_POOL_MAX=1 so the SET (a
 * per-connection setting) applies to the connection every query uses:
 *   DB_POOL_MAX=1 npx tsx scripts/rollup-gt-days.ts --all
 */
import db from '../src/utils/db';
import { rollupDay, utcDay } from '../src/services/gt-day-rollup';

async function resolveDays(): Promise<number> {
  if (process.argv.includes('--all')) {
    // Every UTC day from the oldest raw snapshot through yesterday
    // (UTC-explicit — CURRENT_DATE / bare ::date use the server TimeZone).
    const result = await db.raw<{ rows: Array<{ days: string | null }> }>(
      `SELECT ((now() AT TIME ZONE 'UTC')::date
             - (MIN("timestamp") AT TIME ZONE 'UTC')::date)::int AS days
       FROM game_tracker_snapshots`,
    );
    const days = result.rows[0]?.days;
    if (days == null) {
      console.log('No snapshots found — nothing to roll up.');
      return 0;
    }
    return Number(days);
  }
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg === -1 ? 3 : Number(process.argv[daysArg + 1]);
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    console.error('Usage: npx tsx scripts/rollup-gt-days.ts [--days N | --all]');
    process.exit(1);
  }
  return days;
}

async function main() {
  await db.raw('SET statement_timeout = 0');

  try {
    const days = await resolveDays();
    if (days === 0) return;

    console.log(`Rolling up ${days} completed UTC day(s), ending ${utcDay(1)}...`);
    let totalRows = 0;
    let daysWithData = 0;
    for (let offset = days; offset >= 1; offset--) {
      const { day, rows } = await rollupDay(utcDay(offset));
      totalRows += rows;
      if (rows > 0) daysWithData++;
      console.log(`  ${day}: ${rows} (tracker, channel) row(s) upserted`);
    }
    console.log(
      `Done — ${totalRows} row(s) upserted across ${daysWithData} day(s) with data (${days} day(s) scanned).`,
    );
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
