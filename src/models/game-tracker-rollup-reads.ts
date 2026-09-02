import db from '../utils/db';
import * as Snapshots from './game-tracker-snapshot';
import { todayRollupFresh } from '../services/gt-day-rollup';
import {
  BUCKET_EPOCH,
  BUCKET_ROLLUP_SECONDS,
  bucketFloor,
  mergeBucketParts,
  servableFromBucketRollup,
  snapLongRangeStart,
  splitRangeByUtcDays,
  type BucketPart,
} from '../utils/gt-ranges';

/**
 * Fast read paths for Discover, served from the two rollup tables:
 *   game_tracker_bucket_stats       — 10-minute buckets (timeline)
 *   game_tracker_channel_day_stats  — per channel per UTC day (leaderboards, shares)
 * Every function falls back to the raw query when the rollup can't cover
 * the request (short buckets, no rolled days inside the window, empty
 * table), so a paused rollup job degrades to slow, never to wrong.
 */

async function rolledThroughDay(gameTrackerId: string): Promise<string | null> {
  const row = await db('game_tracker_channel_day_stats')
    .where('game_tracker_id', gameTrackerId)
    .max<{ m: Date | string | null }>('day as m')
    .first();
  if (!row?.m) return null;
  const d = row.m instanceof Date ? row.m.toISOString().slice(0, 10) : String(row.m).slice(0, 10);
  return d;
}

// ── Timeline ───────────────────────────────────────────────────────────

export async function rangeAggregate(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  bucketSeconds: number,
  platform?: string | null,
): Promise<Array<{ ts: Date; total_ccv: number; stream_count: number }>> {
  if (!servableFromBucketRollup(bucketSeconds)) {
    return Snapshots.rangeAggregate(gameTrackerId, fromTs, toTs, bucketSeconds, platform);
  }
  const plat = platform ?? '*';
  const maxRow = await db('game_tracker_bucket_stats')
    .where({ game_tracker_id: gameTrackerId, platform: plat, language: '*' })
    .max<{ m: Date | null }>('bucket_ts as m')
    .first();
  if (!maxRow?.m) {
    return Snapshots.rangeAggregate(gameTrackerId, fromTs, toTs, bucketSeconds, platform);
  }
  const rolledEnd = new Date(new Date(maxRow.m).getTime() + BUCKET_ROLLUP_SECONDS * 1000);
  const cutoff = new Date(Math.min(rolledEnd.getTime(), toTs.getTime()));
  const parts: BucketPart[] = [];
  const interval = `${bucketSeconds} seconds`;

  if (cutoff.getTime() > fromTs.getTime()) {
    const rolled = await db.raw<{
      rows: Array<{ ts: Date; ccv_sum: string; stream_sum: string; minutes: string }>;
    }>(
      `
      SELECT date_bin(?::interval, bucket_ts, ?::timestamptz) AS ts,
             SUM(ccv_sum) AS ccv_sum, SUM(stream_sum) AS stream_sum, SUM(minutes) AS minutes
      FROM game_tracker_bucket_stats
      WHERE game_tracker_id = ? AND platform = ? AND language = '*' AND bucket_ts >= ? AND bucket_ts < ?
      GROUP BY 1
      `,
      [interval, BUCKET_EPOCH, gameTrackerId, plat, bucketFloor(fromTs), cutoff],
    );
    for (const r of rolled.rows) {
      parts.push({
        ts: new Date(r.ts).getTime(),
        ccv_sum: Number(r.ccv_sum),
        stream_sum: Number(r.stream_sum),
        minutes: Number(r.minutes),
      });
    }
  }
  if (cutoff.getTime() < toTs.getTime()) {
    const rawFrom = new Date(Math.max(cutoff.getTime(), fromTs.getTime()));
    const platformSql = platform ? 'AND platform = ?' : '';
    const params: unknown[] = platform
      ? [gameTrackerId, rawFrom, toTs, platform, interval, BUCKET_EPOCH]
      : [gameTrackerId, rawFrom, toTs, interval, BUCKET_EPOCH];
    const raw = await db.raw<{
      rows: Array<{ ts: Date; ccv_sum: string; stream_sum: string; minutes: string }>;
    }>(
      `
      WITH per_minute AS (
        SELECT date_trunc('minute', "timestamp") AS minute_ts,
               SUM(concurrent_viewers) AS ccv,
               COUNT(DISTINCT channel_id) AS streams
        FROM game_tracker_snapshots
        WHERE game_tracker_id = ? AND "timestamp" >= ? AND "timestamp" < ? ${platformSql}
        GROUP BY 1
      )
      SELECT date_bin(?::interval, minute_ts, ?::timestamptz) AS ts,
             SUM(ccv) AS ccv_sum, SUM(streams) AS stream_sum, COUNT(*) AS minutes
      FROM per_minute
      GROUP BY 1
      `,
      params,
    );
    for (const r of raw.rows) {
      parts.push({
        ts: new Date(r.ts).getTime(),
        ccv_sum: Number(r.ccv_sum),
        stream_sum: Number(r.stream_sum),
        minutes: Number(r.minutes),
      });
    }
  }
  return mergeBucketParts(parts);
}

// ── Range leaderboard ──────────────────────────────────────────────────

export interface RangeLeaderboardRow {
  channel_id: string;
  peak_title: string | null;
  peak_ccv: number;
  avg_ccv: number;
  minutes_live: number;
  days_streamed: number;
  platform: string;
  language: string | null;
}

function rawEdgeSql(paramIndexHint: string): string {
  return `
      SELECT channel_id,
             MAX(ccv) AS peak,
             SUM(ccv) AS ccv_minutes,
             COUNT(*) AS minutes_live,
             (minute AT TIME ZONE 'UTC')::date AS day
      FROM (
        SELECT channel_id, date_trunc('minute', "timestamp") AS minute, MAX(concurrent_viewers) AS ccv
        FROM game_tracker_snapshots
        WHERE game_tracker_id = :tid AND "timestamp" >= :${paramIndexHint}From AND "timestamp" < :${paramIndexHint}To
        GROUP BY 1, 2
      ) m
      GROUP BY channel_id, (minute AT TIME ZONE 'UTC')::date`;
}

/**
 * One page of the range leaderboard plus the total, from day stats for
 * the full UTC days inside the window and raw snapshots for the edges.
 * Same streamer-identity grouping (platform + lower(identifier)) as the
 * raw query. Falls back to the raw query when no rolled day is inside
 * the window (e.g. a 24h range).
 */
export async function rangeLeaderboardPage(
  gameTrackerId: string,
  fromArg: Date,
  toTs: Date,
  limit: number,
  opts: { language?: string | null; platform?: string | null; offset?: number } = {},
): Promise<{ rows: RangeLeaderboardRow[]; total: number; source: 'rollup' | 'raw'; from: Date }> {
  const fromTs = snapLongRangeStart(fromArg, toTs);
  const through = await rolledThroughDay(gameTrackerId);
  const split = splitRangeByUtcDays(fromTs, toTs, through, todayRollupFresh());
  if (!split.fullDays) {
    const [rows, total] = await Promise.all([
      Snapshots.rangeLeaderboard(gameTrackerId, fromTs, toTs, limit, opts),
      Snapshots.countRangeLeaderboard(gameTrackerId, fromTs, toTs, opts),
    ]);
    return { rows, total, source: 'raw', from: fromTs };
  }

  const bindings: Record<string, unknown> = {
    tid: gameTrackerId,
    fromDay: split.fullDays.fromDay,
    toDay: split.fullDays.toDay,
    limit,
    offset: Math.max(0, opts.offset ?? 0),
    winFrom: fromTs,
    winTo: toTs,
  };
  const edgeSqls: string[] = [];
  split.rawEdges.forEach((e, i) => {
    const key = `e${i}`;
    bindings[`${key}From`] = e.from;
    bindings[`${key}To`] = e.to;
    edgeSqls.push(rawEdgeSql(key));
  });
  let filterSql = '';
  if (opts.platform) {
    filterSql += ' AND c.platform = :platform';
    bindings.platform = opts.platform;
  }
  if (opts.language) {
    filterSql += ' AND LOWER(c.language) = LOWER(:language)';
    bindings.language = opts.language;
  }

  const result = await db.raw<{
    rows: Array<{
      channel_id: string;
      peak_title: string | null;
      peak_ccv: string;
      ccv_minutes: string;
      minutes_live: string;
      days_streamed: string;
      platform: string;
      language: string | null;
      total: string;
    }>;
  }>(
    `
    WITH days AS (
      SELECT channel_id, peak_ccv AS peak, ccv_minutes, minutes_live, day
      FROM game_tracker_channel_day_stats
      WHERE game_tracker_id = :tid AND day >= :fromDay::date AND day < :toDay::date
      ${edgeSqls.map((s) => `UNION ALL ${s}`).join('\n')}
    ),
    per_channel AS (
      SELECT channel_id, MAX(peak) AS peak, SUM(ccv_minutes) AS ccv_minutes,
             SUM(minutes_live) AS minutes_live, COUNT(DISTINCT day) AS days
      FROM days
      GROUP BY channel_id
    ),
    ident AS (
      SELECT (array_agg(p.channel_id ORDER BY p.peak DESC))[1] AS channel_id,
             MAX(p.peak) AS peak_ccv,
             SUM(p.ccv_minutes) AS ccv_minutes,
             SUM(p.minutes_live) AS minutes_live,
             MAX(p.days) AS days_streamed,
             c.platform,
             MAX(c.language) AS language
      FROM per_channel p
      JOIN channels c ON c.id = p.channel_id
      WHERE 1 = 1 ${filterSql}
      GROUP BY c.platform, LOWER(c.channel_identifier)
    ),
    page AS (
      SELECT *, COUNT(*) OVER () AS total
      FROM ident
      ORDER BY peak_ccv DESC, channel_id
      LIMIT :limit OFFSET :offset
    )
    SELECT page.*, t.title AS peak_title
    FROM page
    LEFT JOIN LATERAL (
      SELECT ss.titles -> (jsonb_array_length(ss.titles) - 1) ->> 'title' AS title
      FROM stream_sessions ss
      WHERE ss.game_tracker_id = :tid
        AND ss.channel_id = page.channel_id
        AND ss.started_at < :winTo
        AND COALESCE(ss.ended_at, now()) > :winFrom
        AND jsonb_array_length(ss.titles) > 0
      ORDER BY ss.peak_ccv DESC
      LIMIT 1
    ) t ON true
    ORDER BY page.peak_ccv DESC, page.channel_id
    `,
    bindings,
  );
  const rows = result.rows.map((r) => {
    const minutes = Number(r.minutes_live);
    return {
      channel_id: r.channel_id,
      peak_title: r.peak_title ?? null,
      peak_ccv: Number(r.peak_ccv),
      avg_ccv: minutes > 0 ? Math.round(Number(r.ccv_minutes) / minutes) : 0,
      minutes_live: minutes,
      days_streamed: Number(r.days_streamed),
      platform: r.platform,
      language: r.language,
    };
  });
  const total = result.rows.length > 0 ? Number(result.rows[0]?.total ?? 0) : await countIdent(bindings, filterSql, edgeSqls);
  return { rows, total, source: 'rollup', from: fromTs };
}

// A page past the end still needs the total for "Page X of Y".
async function countIdent(
  bindings: Record<string, unknown>,
  filterSql: string,
  edgeSqls: string[],
): Promise<number> {
  const result = await db.raw<{ rows: Array<{ n: string }> }>(
    `
    SELECT COUNT(*) AS n FROM (
      SELECT 1
      FROM (
        SELECT channel_id
        FROM game_tracker_channel_day_stats
        WHERE game_tracker_id = :tid AND day >= :fromDay::date AND day < :toDay::date
        ${edgeSqls.map((s) => `UNION ALL SELECT channel_id FROM (${s}) x`).join('\n')}
      ) d
      JOIN channels c ON c.id = d.channel_id
      WHERE 1 = 1 ${filterSql}
      GROUP BY c.platform, LOWER(c.channel_identifier)
    ) q
    `,
    bindings,
  );
  return Number(result.rows[0]?.n ?? 0);
}

// ── Breakdown (share of watch time) ────────────────────────────────────

export interface Breakdown {
  platform: Array<{ platform: string; total_ccv_minutes: number; peak: number }>;
  language: Array<{ language: string | null; total_ccv_minutes: number; peak: number }>;
  source: 'rollup' | 'raw';
}

export async function breakdown(
  gameTrackerId: string,
  fromArg: Date,
  toTs: Date,
  platformFilter?: string | null,
): Promise<Breakdown & { from: Date }> {
  const fromTs = snapLongRangeStart(fromArg, toTs);
  const plat = platformFilter ?? '*';
  const maxRow = await db('game_tracker_bucket_stats')
    .where({ game_tracker_id: gameTrackerId, platform: plat, language: '*' })
    .max<{ m: Date | null }>('bucket_ts as m')
    .first();
  if (!maxRow?.m) {
    const [platform, language] = await Promise.all([
      Snapshots.platformBreakdown(gameTrackerId, fromTs, toTs, platformFilter),
      Snapshots.languageBreakdown(gameTrackerId, fromTs, toTs, platformFilter),
    ]);
    return { platform, language, source: 'raw', from: fromTs };
  }
  const rolledEnd = new Date(new Date(maxRow.m).getTime() + BUCKET_ROLLUP_SECONDS * 1000);
  const cutoff = new Date(Math.min(rolledEnd.getTime(), toTs.getTime()));

  // Rolled part: platform shares come from the language='*' rows, language
  // shares from the platform-scoped rows (platform '*' unless filtered).
  const byPlatform = new Map<string, { total: number; peak: number }>();
  const byLanguage = new Map<string | null, { total: number; peak: number }>();
  const add = (map: Map<string | null, { total: number; peak: number }>, key: string | null, total: number, peak: number) => {
    const cur = map.get(key) ?? { total: 0, peak: 0 };
    cur.total += total;
    cur.peak = Math.max(cur.peak, peak);
    map.set(key, cur);
  };
  if (cutoff.getTime() > fromTs.getTime()) {
    const rolled = await db.raw<{
      rows: Array<{ platform: string; language: string; ccv_sum: string; ccv_max: string }>;
    }>(
      `
      SELECT platform, language, SUM(ccv_sum) AS ccv_sum, MAX(ccv_max) AS ccv_max
      FROM game_tracker_bucket_stats
      WHERE game_tracker_id = ?
        AND bucket_ts >= ? AND bucket_ts < ?
        AND (
          (language = '*' AND platform <> '*' ${platformFilter ? 'AND platform = ?' : ''})
          OR (platform = ? AND language <> '*')
        )
      GROUP BY 1, 2
      `,
      platformFilter
        ? [gameTrackerId, bucketFloor(fromTs), cutoff, platformFilter, plat]
        : [gameTrackerId, bucketFloor(fromTs), cutoff, plat],
    );
    for (const r of rolled.rows) {
      const total = Number(r.ccv_sum);
      const peak = Number(r.ccv_max);
      if (r.language === '*') add(byPlatform as Map<string | null, { total: number; peak: number }>, r.platform, total, peak);
      else add(byLanguage, r.language === '-' ? null : r.language, total, peak);
    }
  }
  // Raw tail — the minutes the rollup has not reached yet (≤ a few minutes).
  if (cutoff.getTime() < toTs.getTime()) {
    const rawFrom = new Date(Math.max(cutoff.getTime(), fromTs.getTime()));
    const tail = await db.raw<{
      rows: Array<{ platform: string; language: string | null; ccv_sum: string; ccv_max: string }>;
    }>(
      `
      SELECT platform::text AS platform, language, SUM(concurrent_viewers) AS ccv_sum, MAX(concurrent_viewers) AS ccv_max
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ? AND "timestamp" >= ? AND "timestamp" < ? ${platformFilter ? 'AND platform = ?' : ''}
      GROUP BY 1, 2
      `,
      platformFilter ? [gameTrackerId, rawFrom, toTs, platformFilter] : [gameTrackerId, rawFrom, toTs],
    );
    for (const r of tail.rows) {
      const total = Number(r.ccv_sum);
      const peak = Number(r.ccv_max);
      add(byPlatform as Map<string | null, { total: number; peak: number }>, r.platform, total, peak);
      add(byLanguage, r.language ? r.language.toLowerCase() : null, total, peak);
    }
  }
  const platform = [...byPlatform.entries()]
    .map(([platform, v]) => ({ platform, total_ccv_minutes: v.total, peak: v.peak }))
    .sort((a, b) => b.total_ccv_minutes - a.total_ccv_minutes);
  const language = [...byLanguage.entries()]
    .map(([language, v]) => ({ language, total_ccv_minutes: v.total, peak: v.peak }))
    .sort((a, b) => b.total_ccv_minutes - a.total_ccv_minutes);
  return { platform, language, source: 'rollup', from: fromTs };
}

// ── Per-channel range facts (exact, raw — one channel is cheap) ────────

export async function channelRangeStats(
  gameTrackerId: string,
  channelId: string,
  fromTs: Date,
  toTs: Date,
): Promise<{ minutes_live: number; days_streamed: number }> {
  const result = await db.raw<{ rows: Array<{ minutes_live: string; days: string }> }>(
    `
    SELECT COUNT(DISTINCT date_trunc('minute', "timestamp")) AS minutes_live,
           COUNT(DISTINCT ("timestamp" AT TIME ZONE 'UTC')::date) AS days
    FROM game_tracker_snapshots
    WHERE game_tracker_id = ? AND channel_id = ? AND "timestamp" >= ? AND "timestamp" < ?
    `,
    [gameTrackerId, channelId, fromTs, toTs],
  );
  const r = result.rows[0];
  return { minutes_live: Number(r?.minutes_live ?? 0), days_streamed: Number(r?.days ?? 0) };
}

// ── Live leaderboard count (for "200 of 299") ──────────────────────────

export async function liveChannelCount(
  gameTrackerId: string,
  at: Date,
  windowSeconds = 120,
  filters: { platform?: string | null; language?: string | null } = {},
): Promise<number> {
  const fromTs = new Date(at.getTime() - windowSeconds * 1000);
  const params: unknown[] = [gameTrackerId, fromTs, at];
  let filterSql = '';
  if (filters.platform) {
    filterSql += ' AND platform = ?';
    params.push(filters.platform);
  }
  if (filters.language) {
    filterSql += ' AND LOWER(language) = LOWER(?)';
    params.push(filters.language);
  }
  const result = await db.raw<{ rows: Array<{ n: string }> }>(
    `SELECT COUNT(DISTINCT channel_id) AS n FROM game_tracker_snapshots
     WHERE game_tracker_id = ? AND "timestamp" >= ? AND "timestamp" <= ? ${filterSql}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}
