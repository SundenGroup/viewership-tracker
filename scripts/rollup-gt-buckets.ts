#!/usr/bin/env npx tsx
/**
 * Backfill the game-tracker 10-minute bucket rollup
 * (src/services/gt-bucket-rollup.ts → game_tracker_bucket_stats) from raw
 * game_tracker_snapshots, one UTC day per statement. Idempotent.
 *
 * Usage:
 *   npx tsx scripts/rollup-gt-buckets.ts --days 7
 *   DB_POOL_MAX=1 npx tsx scripts/rollup-gt-buckets.ts --all
 */
import db from '../src/utils/db';
import { backfillBuckets } from '../src/services/gt-bucket-rollup';

async function main() {
  await db.raw('SET statement_timeout = 0');
  try {
    let from: Date;
    if (process.argv.includes('--all')) {
      const r = await db.raw<{ rows: Array<{ oldest: Date | null }> }>(
        'SELECT MIN("timestamp") AS oldest FROM game_tracker_snapshots',
      );
      if (!r.rows[0]?.oldest) {
        console.log('No snapshots — nothing to roll up.');
        return;
      }
      from = new Date(r.rows[0].oldest);
    } else {
      const i = process.argv.indexOf('--days');
      const days = i === -1 ? 3 : Number(process.argv[i + 1]);
      if (!Number.isFinite(days) || days <= 0) {
        console.error('Usage: npx tsx scripts/rollup-gt-buckets.ts [--days N | --all]');
        process.exit(1);
      }
      from = new Date(Date.now() - days * 86_400_000);
    }
    const to = new Date(Date.now() - 90_000);
    console.log(`Rolling buckets from ${from.toISOString()} to ${to.toISOString()} …`);
    const started = Date.now();
    const total = await backfillBuckets(from, to, (r) => {
      console.log(`  ${r.from.toISOString().slice(0, 16)} → ${r.to.toISOString().slice(0, 16)}: ${r.rows} rows`);
    });
    console.log(`Done: ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
