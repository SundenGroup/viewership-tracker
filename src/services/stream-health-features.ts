/**
 * Per-session inputs of the stream health scorer, computed ONCE from the
 * raw per-minute snapshots when a session ends (finalizeSessions) or by
 * scripts/backfill-health-features.ts, and stored on
 * stream_sessions.health_features. The nightly cohort build and the
 * hourly scoring pass read these instead of re-scanning 30 days of
 * snapshots every hour (which took 35 minutes of database time per run
 * and starved the event tracker's polls on 2026-09-03).
 *
 * Only sessions that can ever be scored get features (avg_ccv >= 50,
 * minutes_live >= 30, the same gates as the scorer); the rest stay NULL
 * and are never candidates. Sizes: about 1,100 such sessions a day, a
 * few KB of JSON each.
 */
import type { Knex } from 'knex';
import db from '../utils/db';

/** Scorer gates; keep in lockstep with stream-health.ts. */
export const FEATURE_MIN_AVG_CCV = 50;
export const FEATURE_MIN_MINUTES = 30;
/** Ignore rises off a base below this many viewers (tiny denominators). Same as the scorer. */
export const FEATURE_RISE_LEVEL_FLOOR = 50;
/** A 12-hour session has at most 720 minute-over-minute rises; longer ones keep the largest. */
const MAX_RISES_STORED = 720;

export interface HealthFeatures {
  /** Minutes with at least one snapshot. */
  snapMinutes: number;
  /** Minutes with chat evidence: a chat_minute_rollup row, or a collector watch interval (silence counts as a real zero). */
  chatMinutes: number;
  meanCcv: number | null;
  sdCcv: number | null;
  /** mean(chatters / ccv) over chat-evidence minutes with ccv > 0; null without chat evidence. */
  engRatio: number | null;
  /** Positive minute-over-minute rises (fraction of the previous level) off a base >= FEATURE_RISE_LEVEL_FLOOR. */
  rises: number[];
  computedAt: string;
}

/**
 * Compute and store features for the given (ended) sessions. Sessions
 * outside the scorer gates are left untouched (health_features stays
 * NULL). Returns the number of sessions updated.
 */
export async function computeHealthFeatures(
  sessionIds: string[],
  trx?: Knex.Transaction,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const conn = trx ?? db;
  const result = await conn.raw<{ rowCount: number }>(
    `
    WITH t AS (
      SELECT id, game_tracker_id, channel_id, stream_id, started_at, ended_at
      FROM stream_sessions
      WHERE id = ANY(?::uuid[])
        AND ended_at IS NOT NULL
        AND avg_ccv >= ?
        AND minutes_live >= ?
    ),
    pm AS (
      -- Joined on stream_id as well: a channel running two streams at once
      -- must not hand both sessions the bigger stream's curve.
      SELECT t.id AS session_id, t.channel_id,
             date_trunc('minute', g."timestamp") AS minute,
             MAX(g.concurrent_viewers)::int AS ccv
      FROM t
      JOIN game_tracker_snapshots g
        ON g.game_tracker_id = t.game_tracker_id
       AND g.channel_id = t.channel_id
       AND g.stream_id = t.stream_id
       AND g."timestamp" >= t.started_at
       AND g."timestamp" <= t.ended_at
      GROUP BY t.id, t.channel_id, date_trunc('minute', g."timestamp")
    ),
    pmc AS (
      -- chatters is 0 on watched-but-silent minutes and NULL only where the
      -- collector was not watching at all.
      SELECT pm.session_id, pm.minute, pm.ccv,
             COALESCE(r.chatters, CASE WHEN w.w IS NOT NULL THEN 0 END) AS chatters
      FROM pm
      LEFT JOIN chat_minute_rollup r
        ON r.channel_id = pm.channel_id AND r.minute = pm.minute
      LEFT JOIN LATERAL (
        SELECT 1 AS w FROM chat_watch_intervals wi
        WHERE wi.channel_id = pm.channel_id
          AND wi.started_at <= pm.minute
          AND COALESCE(wi.ended_at, wi.last_seen_at) >= pm.minute
        LIMIT 1
      ) w ON true
    ),
    stats AS (
      SELECT session_id,
             COUNT(*)::int AS snap_minutes,
             COUNT(*) FILTER (WHERE chatters IS NOT NULL)::int AS chat_minutes,
             AVG(ccv)::numeric AS mean_ccv,
             stddev_samp(ccv)::numeric AS sd_ccv,
             AVG(chatters::numeric / ccv) FILTER (WHERE chatters IS NOT NULL AND ccv > 0) AS eng_ratio
      FROM pmc
      GROUP BY session_id
    ),
    rise_rows AS (
      SELECT x.session_id, (x.ccv - x.prev_ccv)::numeric / x.prev_ccv AS rise
      FROM (
        SELECT session_id, ccv,
               lag(ccv) OVER (PARTITION BY session_id ORDER BY minute) AS prev_ccv
        FROM pm
      ) x
      WHERE x.prev_ccv >= ? AND x.ccv > x.prev_ccv
    ),
    rises AS (
      SELECT session_id, jsonb_agg(ROUND(rise, 4) ORDER BY rise DESC) AS rises
      FROM (
        SELECT session_id, rise,
               row_number() OVER (PARTITION BY session_id ORDER BY rise DESC) AS rn
        FROM rise_rows
      ) r
      WHERE r.rn <= ?
      GROUP BY session_id
    )
    UPDATE stream_sessions ss
    SET health_features = jsonb_build_object(
          'snapMinutes', COALESCE(s.snap_minutes, 0),
          'chatMinutes', COALESCE(s.chat_minutes, 0),
          'meanCcv', ROUND(s.mean_ccv, 3),
          'sdCcv', ROUND(s.sd_ccv, 3),
          'engRatio', ROUND(s.eng_ratio, 6),
          'rises', COALESCE(r.rises, '[]'::jsonb),
          'computedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
    FROM t
    LEFT JOIN stats s ON s.session_id = t.id
    LEFT JOIN rises r ON r.session_id = t.id
    WHERE ss.id = t.id
    `,
    [sessionIds, FEATURE_MIN_AVG_CCV, FEATURE_MIN_MINUTES, FEATURE_RISE_LEVEL_FLOOR, MAX_RISES_STORED],
  );
  return Number(result.rowCount ?? 0);
}

/**
 * Ids of scorable sessions (gates) that ended within the window and have
 * no features yet, oldest first. Used by the backfill and by the nightly
 * catch-up.
 */
export async function sessionIdsMissingFeatures(days: number, limit: number): Promise<string[]> {
  const rows = await db('stream_sessions')
    .where('status', 'ended')
    .whereNotNull('ended_at')
    .where('ended_at', '>=', db.raw(`now() - (?::text || ' days')::interval`, [String(days)]))
    .where('avg_ccv', '>=', FEATURE_MIN_AVG_CCV)
    .where('minutes_live', '>=', FEATURE_MIN_MINUTES)
    .whereNull('health_features')
    .orderBy('ended_at', 'asc')
    .limit(limit)
    .select('id');
  return rows.map((r: { id: string }) => r.id);
}
