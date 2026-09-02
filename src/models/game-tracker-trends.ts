import db from '../utils/db';
import { classifyTrend, toUtcDay, type TrendClass } from '../utils/gt-ranges';

/**
 * Trends for the Discover "Trending" section, split the way readers
 * actually use it:
 *   risers    — channels that beat their own recent baseline
 *   newcomers — channels with no baseline at all: new to the tracker, or
 *               returning after a quiet week
 *
 * The old query ranked by absolute gain over the previous window, so any
 * channel that took a day off topped the list as "0 → 15K". The baseline
 * here is the best daily peak over the 7 rolled-up days before the
 * current window, read from game_tracker_channel_day_stats — the current
 * window itself is raw for ≤ 48h and day-stats + raw-today beyond that.
 */

export interface TrendRow {
  channel_id: string;
  cur_peak: number;
  baseline_peak: number | null;
  ratio: number | null;
  cls: TrendClass;
  /** When the tracker first saw the channel (game_tracker_channels.joined_at). */
  joined_at: Date | null;
}

interface RawRow {
  channel_id: string;
  cur_peak: string;
  baseline_peak: string | null;
  has_older: boolean;
  joined_at: Date | null;
}

export async function trendsV2(
  gameTrackerId: string,
  hours: number,
  limit: number,
): Promise<{ risers: TrendRow[]; newcomers: TrendRow[]; baselineDays: { fromDay: string; toDay: string } }> {
  const now = new Date();
  const curFrom = new Date(now.getTime() - hours * 3_600_000);
  const curFromDay = toUtcDay(curFrom);
  const todayStart = new Date(Date.parse(`${toUtcDay(now)}T00:00:00Z`));
  const baselineTo = curFromDay; // exclusive
  const baselineFrom = toUtcDay(new Date(Date.parse(`${curFromDay}T00:00:00Z`) - 7 * 86_400_000));

  // Current-window peak: raw for short windows; a day or more reads the
  // rolled-up days plus raw for today (so "24h" is yesterday + today).
  const curSql =
    hours < 24
      ? `
      SELECT channel_id, MAX(concurrent_viewers) AS peak
      FROM game_tracker_snapshots
      WHERE game_tracker_id = :tid AND "timestamp" >= :curFrom
      GROUP BY channel_id`
      : `
      SELECT channel_id, MAX(peak) AS peak FROM (
        SELECT channel_id, peak_ccv AS peak
        FROM game_tracker_channel_day_stats
        WHERE game_tracker_id = :tid AND day >= :curFromDay::date
        UNION ALL
        SELECT channel_id, MAX(concurrent_viewers) AS peak
        FROM game_tracker_snapshots
        WHERE game_tracker_id = :tid AND "timestamp" >= GREATEST(:todayStart::timestamptz, :curFrom::timestamptz)
        GROUP BY channel_id
      ) u GROUP BY channel_id`;

  const result = await db.raw<{ rows: RawRow[] }>(
    `
    WITH cur AS (${curSql}),
    base AS (
      SELECT channel_id, MAX(peak_ccv) AS peak
      FROM game_tracker_channel_day_stats
      WHERE game_tracker_id = :tid AND day >= :baselineFrom::date AND day < :baselineTo::date
      GROUP BY channel_id
    ),
    older AS (
      SELECT DISTINCT channel_id
      FROM game_tracker_channel_day_stats
      WHERE game_tracker_id = :tid AND day < :baselineFrom::date
    )
    SELECT c.channel_id,
           c.peak AS cur_peak,
           b.peak AS baseline_peak,
           (o.channel_id IS NOT NULL) AS has_older,
           gtc.joined_at
    FROM cur c
    LEFT JOIN base b ON b.channel_id = c.channel_id
    LEFT JOIN older o ON o.channel_id = c.channel_id
    LEFT JOIN game_tracker_channels gtc ON gtc.game_tracker_id = :tid AND gtc.channel_id = c.channel_id
    WHERE c.peak >= 50
    `,
    { tid: gameTrackerId, curFrom, curFromDay, todayStart, baselineFrom, baselineTo },
  );

  const risers: TrendRow[] = [];
  const newcomers: TrendRow[] = [];
  for (const r of result.rows) {
    const cur = Number(r.cur_peak);
    const base = r.baseline_peak == null ? null : Number(r.baseline_peak);
    const c = classifyTrend(cur, base, r.has_older);
    if (!c) continue;
    const row: TrendRow = {
      channel_id: r.channel_id,
      cur_peak: cur,
      baseline_peak: base,
      ratio: c.ratio,
      cls: c.cls,
      joined_at: r.joined_at,
    };
    if (c.cls === 'riser') risers.push(row);
    else newcomers.push(row);
  }
  risers.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.cur_peak - a.cur_peak);
  newcomers.sort((a, b) => b.cur_peak - a.cur_peak);
  return {
    risers: risers.slice(0, limit),
    newcomers: newcomers.slice(0, limit),
    baselineDays: { fromDay: baselineFrom, toDay: baselineTo },
  };
}
