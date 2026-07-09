#!/usr/bin/env npx tsx
/**
 * Manual / backfill run of the stream health scorer
 * (src/services/stream-health.ts) over sessions ended in the last N days.
 *
 * Idempotent: re-runs recompute the same health_score / health_grade /
 * health_evidence columns. Sessions without chat coverage are left
 * unscored (nulls), never zeroed.
 *
 * Usage:
 *   npx tsx scripts/score-stream-health.ts            # last 7 days
 *   npx tsx scripts/score-stream-health.ts --days 30
 *
 * The cohort statement windows over 30 days of per-minute data — lift
 * the DB's statement_timeout for this run. Run with DB_POOL_MAX=1 so the
 * SET (a per-connection setting) applies to the connection every query
 * uses.
 */
import db from '../src/utils/db';
import { scoreSessions, sessionIdsEndedWithin } from '../src/services/stream-health';

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg === -1 ? 7 : Number(process.argv[daysArg + 1]);
  if (!Number.isFinite(days) || days <= 0) {
    console.error('Usage: npx tsx scripts/score-stream-health.ts [--days N]');
    process.exit(1);
  }

  await db.raw('SET statement_timeout = 0');

  try {
    const ids = await sessionIdsEndedWithin(days * 24);
    console.log(`${ids.length} candidate session(s) ended in the last ${days} day(s)`);
    if (ids.length === 0) return;

    const result = await scoreSessions(ids);
    console.log(
      `Scored ${result.scored} of ${result.candidates} candidate(s) ` +
      `(${result.skippedNoChat} without chat coverage left unscored) ` +
      `in ${(result.durationMs / 1000).toFixed(1)}s`,
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
