/**
 * One-off backfill for the stream health scorer's stored features.
 *
 *   npx tsx scripts/backfill-health-features.ts [--days 30] [--batch 500] [--build] [--rescore]
 *
 * Computes stream_sessions.health_features for every scorable session
 * (avg_ccv >= 50, minutes_live >= 30) that ended within --days and has no
 * features yet, in batches. With --build it then rebuilds
 * stream_health_cohorts; with --rescore it re-scores the last 7 days
 * against the new baselines. Safe to re-run: it only touches sessions
 * whose features are missing. Run it in a quiet window: the feature scan
 * is the same per-minute join the old hourly scorer did, once.
 */
import db from '../src/utils/db';
import logger from '../src/utils/logger';
import { computeHealthFeatures, sessionIdsMissingFeatures } from '../src/services/stream-health-features';
import { buildHealthCohorts, scoreSessions, sessionIdsEndedWithin } from '../src/services/stream-health';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const days = Number(arg('--days', '30'));
  const batch = Number(arg('--batch', '500'));
  const build = process.argv.includes('--build');
  const rescore = process.argv.includes('--rescore');
  const startedMs = Date.now();

  let total = 0;
  for (;;) {
    const ids = await sessionIdsMissingFeatures(days, batch);
    if (ids.length === 0) break;
    const t0 = Date.now();
    const n = await computeHealthFeatures(ids);
    total += n;
    logger.info(`[HealthBackfill] features: +${n} (total ${total}) in ${Date.now() - t0}ms`);
    // Sessions outside the gates are never selected, so a batch that
    // updated nothing means the remaining ids cannot be computed.
    if (n === 0) break;
  }
  logger.info(`[HealthBackfill] features done: ${total} sessions in ${Math.round((Date.now() - startedMs) / 1000)}s`);

  if (build) {
    const r = await buildHealthCohorts({ force: true });
    logger.info(`[HealthBackfill] cohorts: ${r.cohorts} slices in ${r.durationMs}ms`);
  }
  if (rescore) {
    const ids = await sessionIdsEndedWithin(7 * 24);
    const r = await scoreSessions(ids);
    logger.info(`[HealthBackfill] rescored ${r.scored} of ${r.candidates} in ${r.durationMs}ms`);
  }
  await db.destroy();
}

main().catch((err) => {
  logger.error('[HealthBackfill] failed', { error: (err as Error).message });
  process.exit(1);
});
