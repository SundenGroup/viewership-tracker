/**
 * Live-edge completeness trimming for bucketed timelines.
 *
 * Platforms report on different clocks: Twitch/YouTube are server-polled
 * and land immediately, while TikTok arrives via the residential relay up
 * to a cycle later. The newest minute therefore routinely exists WITHOUT
 * its TikTok rows, the live total "dips" at the right edge, and heals a
 * minute later — which makes the live chart lie ~80% of the time.
 *
 * Rather than serve a bucket that is still filling, drop trailing
 * buckets that are BOTH (a) recent enough to still be mid-flight and
 * (b) visibly below the channel coverage of the buckets just before
 * them. Channel COUNT (not viewers) is the completeness signal, so a
 * genuinely shrinking audience passes through untouched. Historical
 * scopes and completed days are inherently unaffected — their buckets
 * are older than the live edge.
 */

/** A trailing bucket must reach this share of the recent channel count
 *  to be considered complete. */
const COVERAGE_RATIO = 0.9;
/** How many trailing buckets may be withheld at most. */
const MAX_TRIM = 3;
/** Baseline = max channel count over this many buckets before the candidate. */
const BASELINE_WINDOW = 5;
/** Extra allowance past the bucket span for relay lag. */
const RELAY_LAG_MS = 3 * 60_000;

export function trimIncompleteEdge<T extends { bucket: Date | string; channel_count: string | number }>(
  rows: T[],
  intervalSeconds: number,
  nowMs: number = Date.now(),
): T[] {
  if (rows.length === 0) return rows;

  const perBucket = new Map<number, number>();
  for (const r of rows) {
    const t = new Date(r.bucket).getTime();
    perBucket.set(t, (perBucket.get(t) ?? 0) + Number(r.channel_count));
  }
  const buckets = [...perBucket.keys()].sort((a, b) => a - b);
  if (buckets.length < BASELINE_WINDOW + 1) return rows;

  const liveEdgeMs = intervalSeconds * 1000 + RELAY_LAG_MS;
  const drop = new Set<number>();
  for (let trimmed = 0; trimmed < MAX_TRIM; trimmed++) {
    const idx = buckets.length - 1 - trimmed;
    if (idx < BASELINE_WINDOW) break;
    const t = buckets[idx] as number;
    if (nowMs - t > liveEdgeMs + trimmed * intervalSeconds * 1000) break; // settled — it is what it is
    const baseline = Math.max(
      ...buckets.slice(idx - BASELINE_WINDOW, idx).map((b) => perBucket.get(b) ?? 0),
    );
    if (baseline <= 0) break;
    if ((perBucket.get(t) ?? 0) >= COVERAGE_RATIO * baseline) break;
    drop.add(t);
  }
  if (drop.size === 0) return rows;
  return rows.filter((r) => !drop.has(new Date(r.bucket).getTime()));
}
