/**
 * Pure helpers for the Discover fast paths — kept free of DB access so
 * they can be unit-tested.
 */

export const BUCKET_ROLLUP_SECONDS = 600;
/** Anchor for epoch-aligned buckets — every rolled bucket starts on a multiple of 10 min from here. */
export const BUCKET_EPOCH = '2000-01-01T00:00:00Z';

export interface UtcDaySplit {
  /** [fromDay, toDay) as 'YYYY-MM-DD' UTC days fully inside the window and already rolled up. */
  fullDays: { fromDay: string; toDay: string } | null;
  /** Sub-windows that still have to be read from raw snapshots. */
  rawEdges: Array<{ from: Date; to: Date }>;
}

const DAY_MS = 86_400_000;

function utcMidnightAtOrAfter(t: Date): Date {
  const ms = t.getTime();
  const floor = Math.floor(ms / DAY_MS) * DAY_MS;
  return new Date(floor === ms ? ms : floor + DAY_MS);
}

function utcMidnightAtOrBefore(t: Date): Date {
  return new Date(Math.floor(t.getTime() / DAY_MS) * DAY_MS);
}

export function toUtcDay(t: Date): string {
  return t.toISOString().slice(0, 10);
}

/**
 * Split [from, to) into the UTC calendar days that can be served from the
 * day-stats rollup and the raw edges that cannot. `rolledThroughDay` is the
 * newest day present in the rollup (inclusive) — days after it (today,
 * and yesterday before the nightly job ran) stay raw.
 */
export function splitRangeByUtcDays(
  from: Date,
  to: Date,
  rolledThroughDay: string | null,
  /**
   * True when today's partial day has been rolled up within the last few
   * minutes (the intraday pass): the trailing raw edge is then dropped and
   * today is read from the rollup too, a few minutes stale at most.
   */
  todayRolled = false,
): UtcDaySplit {
  if (!(to.getTime() > from.getTime())) return { fullDays: null, rawEdges: [] };
  if (!rolledThroughDay) return { fullDays: null, rawEdges: [{ from, to }] };

  const firstFull = utcMidnightAtOrAfter(from);
  // Exclusive end of the rolled span: the midnight after rolledThroughDay.
  const rolledEnd = new Date(Date.parse(`${rolledThroughDay}T00:00:00Z`) + DAY_MS);
  const toBoundary =
    todayRolled && rolledThroughDay === toUtcDay(to) ? utcMidnightAtOrAfter(to) : utcMidnightAtOrBefore(to);
  const lastFull = new Date(Math.min(toBoundary.getTime(), rolledEnd.getTime()));

  if (lastFull.getTime() <= firstFull.getTime()) {
    return { fullDays: null, rawEdges: [{ from, to }] };
  }
  const rawEdges: Array<{ from: Date; to: Date }> = [];
  if (from.getTime() < firstFull.getTime()) rawEdges.push({ from, to: firstFull });
  if (lastFull.getTime() < to.getTime()) rawEdges.push({ from: lastFull, to });
  return {
    fullDays: { fromDay: toUtcDay(firstFull), toDay: toUtcDay(lastFull) },
    rawEdges,
  };
}

export interface BucketPart {
  ts: number; // epoch ms of the (query-sized) bucket start
  ccv_sum: number;
  stream_sum: number;
  minutes: number;
  /** Highest single-minute total inside this part. */
  ccv_max: number;
}

/**
 * Merge bucket parts that may come from the rollup table and from the raw
 * tail (the same query bucket can be split across both) into the shape
 * rangeAggregate() returns: per bucket, the average of the per-minute
 * totals and the highest single minute.
 */
export function mergeBucketParts(
  parts: BucketPart[],
): Array<{ ts: Date; total_ccv: number; stream_count: number; peak_ccv: number }> {
  const byTs = new Map<number, { ccv: number; streams: number; minutes: number; peak: number }>();
  for (const p of parts) {
    const cur = byTs.get(p.ts) ?? { ccv: 0, streams: 0, minutes: 0, peak: 0 };
    cur.ccv += p.ccv_sum;
    cur.streams += p.stream_sum;
    cur.minutes += p.minutes;
    cur.peak = Math.max(cur.peak, p.ccv_max);
    byTs.set(p.ts, cur);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, v]) => ({
      ts: new Date(ts),
      total_ccv: v.minutes > 0 ? Math.round(v.ccv / v.minutes) : 0,
      stream_count: v.minutes > 0 ? Math.round(v.streams / v.minutes) : 0,
      peak_ccv: Math.round(v.peak),
    }));
}

// ── Poll scheduling ──────────────────────────────────────────────────────
// A tracker polls on whole multiples of its interval: the clock minute at
// the default 60 s. Every row of a poll is stamped with that boundary, not
// with the moment the platform reads happened to finish, so one poll is
// one minute on every chart no matter how long its reads took.

/** The first poll boundary strictly after `nowMs`. */
export function nextPollBoundary(nowMs: number, intervalMs: number): number {
  const size = Math.max(1000, Math.floor(intervalMs));
  return (Math.floor(nowMs / size) + 1) * size;
}

/** The poll boundary `nowMs` falls in: the stamp of a poll started by hand. */
export function pollBoundaryAtOrBefore(nowMs: number, intervalMs: number): number {
  const size = Math.max(1000, Math.floor(intervalMs));
  return Math.floor(nowMs / size) * size;
}

/**
 * How far back "live right now" looks for a channel's latest reading.
 * Rows carry the minute their poll was scheduled for and are written when
 * its reads finish, so the newest complete poll can be a full interval
 * plus one slow poll old.
 */
export const LIVE_WINDOW_SECONDS = 150;

/** True when a query bucket can be assembled from 10-minute rollup buckets. */
export function servableFromBucketRollup(bucketSeconds: number): boolean {
  return bucketSeconds >= BUCKET_ROLLUP_SECONDS && bucketSeconds % BUCKET_ROLLUP_SECONDS === 0;
}

/** Start of the 10-minute rollup bucket containing `t` (epoch-aligned). */
export function bucketFloor(t: Date, bucketSeconds = BUCKET_ROLLUP_SECONDS): Date {
  const size = bucketSeconds * 1000;
  return new Date(Math.floor(t.getTime() / size) * size);
}

/**
 * Clamp a query-string integer: NaN / non-numeric input falls back to the
 * default instead of leaking NaN into SQL (Math.min(NaN, …) is NaN).
 */
export function clampInt(raw: unknown, min: number, max: number, dflt: number): number {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), min), max);
}

export type TrendClass = 'riser' | 'new' | 'returning';

/**
 * Classify a channel for the Trends tab.
 *   riser     — has a meaningful baseline and beat it by the ratio floor
 *   new       — never had a rolled-up day before the current window
 *   returning — has history, but nothing in the baseline window
 * Returns null when the channel is neither (steady, or below the floors).
 */
export function classifyTrend(
  curPeak: number,
  baselinePeak: number | null,
  hasOlderHistory: boolean,
  opts: { minPeak?: number; minBaseline?: number; riseRatio?: number } = {},
): { cls: TrendClass; ratio: number | null } | null {
  const minPeak = opts.minPeak ?? 50;
  const minBaseline = opts.minBaseline ?? 100;
  const riseRatio = opts.riseRatio ?? 1.5;
  if (curPeak < minPeak) return null;
  if (baselinePeak == null || baselinePeak <= 0) {
    return { cls: hasOlderHistory ? 'returning' : 'new', ratio: null };
  }
  if (baselinePeak < minBaseline) return null;
  const ratio = curPeak / baselinePeak;
  if (ratio >= riseRatio) return { cls: 'riser', ratio };
  return null;
}

/**
 * Windows of a week or more are snapped down to the UTC midnight of their
 * first day: the partial first day is the one part of a long range that
 * still has to be read from raw minute rows (up to a day of cold data),
 * and "last 7 days" as 7 full days plus today is what readers expect.
 * Shorter windows stay exact.
 */
export const DAY_SNAP_MIN_HOURS = 7 * 24;

export function snapLongRangeStart(from: Date, to: Date): Date {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours < DAY_SNAP_MIN_HOURS) return from;
  return utcMidnightAtOrBefore(from);
}
