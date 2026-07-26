import db from '../utils/db';

/**
 * Stored stream sessions — one row per (tracker, channel, stream_id)
 * broadcast, maintained live by GameTrackerService and backfilled from
 * game_tracker_snapshots by scripts/backfill-stream-sessions.ts.
 *
 * Lifecycle: every poll cycle upserts the live rows (bump last_seen_at /
 * running peak / title history); a close pass flips rows silent for
 * >10 min to 'ended' and computes finals (minutes, viewer-minutes, avg,
 * chat volume, follower delta) from the raw per-minute tables.
 */

export type StreamSessionStatus = 'live' | 'ended';

export interface TitleEntry {
  title: string;
  at: string;
}

/**
 * Stream health (Stream Integrity Signals Phase 1). Written by
 * src/services/stream-health.ts for ended sessions with ≥50 avg CCV,
 * ≥30 min, and chat coverage. NULL columns = not scored (never a zero).
 */
export interface HealthFlag {
  kind: string;
  detail: string;
  /** 'critical' = damning on its own (caps the grade at F). */
  severity?: 'critical';
}

export interface HealthEvidence {
  /** Engagement percentile within the cohort (null when cohort too small). */
  engagementPct: number | null;
  cohort: { tracker: string; band: string; n: number };
  /** Plain-language findings — "signals, not proof". */
  flags: HealthFlag[];
  /** Out of engagement 40 / curve 30 / followers 15 / spikeResponse 15. */
  subscores: { engagement: number; curve: number; followers: number; spikeResponse: number };
}

export interface StreamSession {
  id: string;
  game_tracker_id: string;
  channel_id: string;
  stream_id: string;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  status: StreamSessionStatus;
  peak_ccv: number;
  avg_ccv: number;
  ccv_minutes: number;
  minutes_live: number;
  titles: TitleEntry[];
  category: string | null;
  followers_start: number | null;
  followers_end: number | null;
  messages: number;
  unique_chatters: number;
  health_score: number | null;
  health_grade: string | null;
  health_evidence: HealthEvidence | null;
}

/** The frozen row shape the sessions endpoints return. */
export interface StreamSessionRow {
  id: string;
  stream_id: string;
  started_at: Date;
  ended_at: Date | null;
  status: StreamSessionStatus;
  minutes_live: number;
  peak_ccv: number;
  avg_ccv: number;
  ccv_minutes: number;
  titles: TitleEntry[];
  category: string | null;
  followers_start: number | null;
  followers_end: number | null;
  messages: number;
  unique_chatters: number;
  health_score: number | null;
  health_grade: string | null;
  health_evidence: HealthEvidence | null;
}

export interface UpsertLiveSession {
  game_tracker_id: string;
  channel_id: string;
  stream_id: string;
  timestamp: Date;
  concurrent_viewers: number;
  stream_title: string | null;
  game_name: string | null;
  started_at: Date | null;
}

const TABLE = 'stream_sessions';

/** pg returns bigint as string and jsonb pre-parsed — normalize a DB row. */
function coerce(row: Record<string, unknown>): StreamSession {
  return {
    ...(row as unknown as StreamSession),
    peak_ccv: Number(row.peak_ccv),
    avg_ccv: Number(row.avg_ccv),
    ccv_minutes: Number(row.ccv_minutes),
    minutes_live: Number(row.minutes_live),
    messages: Number(row.messages),
    unique_chatters: Number(row.unique_chatters),
    titles: (row.titles ?? []) as TitleEntry[],
    health_score: row.health_score != null ? Number(row.health_score) : null,
    health_grade: (row.health_grade ?? null) as string | null,
    health_evidence: (row.health_evidence ?? null) as HealthEvidence | null,
  };
}

/** Project a session onto the frozen endpoint row shape. */
export function toRow(s: StreamSession): StreamSessionRow {
  return {
    id: s.id,
    stream_id: s.stream_id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    minutes_live: s.minutes_live,
    peak_ccv: s.peak_ccv,
    avg_ccv: s.avg_ccv,
    ccv_minutes: s.ccv_minutes,
    titles: s.titles,
    category: s.category,
    followers_start: s.followers_start,
    followers_end: s.followers_end,
    messages: s.messages,
    unique_chatters: s.unique_chatters,
    health_score: s.health_score,
    health_grade: s.health_grade,
    health_evidence: s.health_evidence,
  };
}

// ── Live lifecycle (called from GameTrackerService each cycle) ───────────

/**
 * Batched upsert of this cycle's live sightings. One statement via
 * unnest — insert unseen (tracker, channel, stream) triples, bump
 * last_seen_at / running peak on the rest, and append a titles entry
 * only when the title differs from the last recorded one.
 *
 * followers_start is captured once, at insert, from the latest follower
 * snapshot (if any). A conflicting row is also resurrected to 'live'
 * (ended_at cleared) so a stream that dipped out for >10 min and came
 * back under the same stream_id gets re-closed — and its finals
 * recomputed over the full window — by a later close pass.
 */
export async function upsertLiveBatch(rows: UpsertLiveSession[]): Promise<number> {
  if (rows.length === 0) return 0;

  // The same (channel, stream) pair twice in one cycle (e.g. pagination
  // dupes) would make ON CONFLICT hit a row twice — keep the higher CCV.
  const dedup = new Map<string, UpsertLiveSession>();
  for (const r of rows) {
    const key = `${r.game_tracker_id}:${r.channel_id}:${r.stream_id}`;
    const prev = dedup.get(key);
    if (!prev || r.concurrent_viewers > prev.concurrent_viewers) dedup.set(key, r);
  }
  const batch = [...dedup.values()];

  const result = await db.raw(
    `
    INSERT INTO stream_sessions
      (game_tracker_id, channel_id, stream_id, started_at, last_seen_at, status,
       peak_ccv, titles, category, followers_start)
    SELECT
      v.game_tracker_id,
      v.channel_id,
      v.stream_id,
      COALESCE(v.platform_started_at, v.ts),
      v.ts,
      'live',
      v.ccv,
      CASE WHEN v.title IS NULL THEN '[]'::jsonb
           ELSE jsonb_build_array(jsonb_build_object('title', v.title, 'at', v.ts)) END,
      v.game_name,
      f.followers
    FROM unnest(
      ?::uuid[], ?::uuid[], ?::text[], ?::timestamptz[], ?::int[], ?::text[], ?::text[], ?::timestamptz[]
    ) AS v(game_tracker_id, channel_id, stream_id, ts, ccv, title, game_name, platform_started_at)
    LEFT JOIN LATERAL (
      SELECT followers FROM channel_follower_snapshots
      WHERE channel_id = v.channel_id
      ORDER BY ts DESC
      LIMIT 1
    ) f ON true
    ON CONFLICT (game_tracker_id, channel_id, stream_id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      status = 'live',
      ended_at = NULL,
      peak_ccv = GREATEST(stream_sessions.peak_ccv, EXCLUDED.peak_ccv),
      titles = CASE
        WHEN jsonb_array_length(EXCLUDED.titles) > 0
         AND (EXCLUDED.titles -> 0) ->> 'title' IS DISTINCT FROM
             (stream_sessions.titles -> (jsonb_array_length(stream_sessions.titles) - 1)) ->> 'title'
        THEN stream_sessions.titles || EXCLUDED.titles
        ELSE stream_sessions.titles
      END
    `,
    [
      batch.map((r) => r.game_tracker_id),
      batch.map((r) => r.channel_id),
      batch.map((r) => r.stream_id),
      batch.map((r) => r.timestamp),
      batch.map((r) => r.concurrent_viewers),
      batch.map((r) => r.stream_title),
      batch.map((r) => r.game_name),
      batch.map((r) => r.started_at),
    ],
  );
  return (result as { rowCount?: number }).rowCount ?? batch.length;
}

/**
 * Flip live sessions that went silent for >10 min to 'ended'
 * (ended_at = last snapshot we saw). Returns the closed ids so the
 * caller can compute finals for exactly those rows.
 */
export async function closeStale(gameTrackerId: string): Promise<string[]> {
  const result = await db.raw<{ rows: Array<{ id: string }> }>(
    `
    UPDATE stream_sessions
    SET status = 'ended', ended_at = last_seen_at
    WHERE status = 'live'
      AND game_tracker_id = ?
      AND last_seen_at < now() - interval '10 minutes'
    RETURNING id
    `,
    [gameTrackerId],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Compute finals for a set of (already ended) sessions from the raw
 * per-minute tables, over each session's [started_at, ended_at] window:
 *   - minutes_live  = distinct minutes with a snapshot
 *   - ccv_minutes   = SUM of per-minute MAX ccv (viewer-minutes)
 *   - avg_ccv       = round(ccv_minutes / minutes_live)
 *   - peak_ccv      = per-minute MAX (kept monotonic vs the running peak)
 *   - messages / unique_chatters = SUMs from chat_minute_rollup
 *     (sum of per-minute chatters — a named approximation)
 *   - followers_end = latest follower snapshot ≤ ended_at + 10 min
 */
export async function finalizeSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.raw(
    `
    WITH closed AS (
      SELECT id, game_tracker_id, channel_id, started_at, ended_at
      FROM stream_sessions
      WHERE id = ANY(?::uuid[]) AND ended_at IS NOT NULL
    ),
    per_minute AS (
      SELECT c.id AS session_id,
             date_trunc('minute', s."timestamp") AS minute,
             MAX(s.concurrent_viewers) AS ccv
      FROM closed c
      JOIN game_tracker_snapshots s
        ON s.game_tracker_id = c.game_tracker_id
       AND s.channel_id = c.channel_id
       AND s."timestamp" >= c.started_at
       AND s."timestamp" <= c.ended_at
      GROUP BY c.id, date_trunc('minute', s."timestamp")
    ),
    snap_stats AS (
      SELECT session_id,
             COUNT(*)::int AS minutes_live,
             SUM(ccv)::bigint AS ccv_minutes,
             MAX(ccv)::int AS peak_ccv
      FROM per_minute
      GROUP BY session_id
    ),
    chat_stats AS (
      SELECT c.id AS session_id,
             SUM(r.messages)::int AS messages,
             SUM(r.chatters)::int AS chatters
      FROM closed c
      JOIN chat_minute_rollup r
        ON r.channel_id = c.channel_id
       AND r.minute >= date_trunc('minute', c.started_at)
       AND r.minute <= c.ended_at
      GROUP BY c.id
    ),
    follower_end AS (
      SELECT c.id AS session_id, f.followers
      FROM closed c
      JOIN LATERAL (
        SELECT followers FROM channel_follower_snapshots
        WHERE channel_id = c.channel_id
          AND ts <= c.ended_at + interval '10 minutes'
        ORDER BY ts DESC
        LIMIT 1
      ) f ON true
    )
    UPDATE stream_sessions ss
    SET minutes_live = COALESCE(st.minutes_live, 0),
        ccv_minutes = COALESCE(st.ccv_minutes, 0),
        avg_ccv = CASE
          WHEN COALESCE(st.minutes_live, 0) > 0
          THEN ROUND(st.ccv_minutes::numeric / st.minutes_live)::int
          ELSE 0
        END,
        peak_ccv = GREATEST(ss.peak_ccv, COALESCE(st.peak_ccv, 0)),
        messages = COALESCE(ch.messages, 0),
        unique_chatters = COALESCE(ch.chatters, 0),
        followers_end = fe.followers
    FROM closed c
    LEFT JOIN snap_stats st ON st.session_id = c.id
    LEFT JOIN chat_stats ch ON ch.session_id = c.id
    LEFT JOIN follower_end fe ON fe.session_id = c.id
    WHERE ss.id = c.id
    `,
    [ids],
  );
}

// ── Read paths (endpoints) ───────────────────────────────────────────────

export async function countByChannel(gameTrackerId: string, channelId: string): Promise<number> {
  const [row] = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_id: channelId })
    .count<{ count: string }[]>('* as count');
  return parseInt(row.count, 10);
}

export async function listByChannel(
  gameTrackerId: string,
  channelId: string,
  limit: number,
  offset: number,
): Promise<StreamSession[]> {
  const rows = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_id: channelId })
    .orderBy('started_at', 'desc')
    .limit(limit)
    .offset(offset);
  return rows.map(coerce);
}

export async function findByStream(
  gameTrackerId: string,
  channelId: string,
  streamId: string,
): Promise<StreamSession | null> {
  const row = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_id: channelId, stream_id: streamId })
    .first();
  return row ? coerce(row) : null;
}

/**
 * Per-minute CCV timeline for one session window (MAX per minute across
 * poll cycles).
 */
export async function sessionTimeline(
  gameTrackerId: string,
  channelId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ ts: Date; ccv: number }>> {
  const result = await db.raw<{ rows: Array<{ ts: Date; ccv: number }> }>(
    `
    SELECT date_trunc('minute', "timestamp") AS ts,
           MAX(concurrent_viewers)::int AS ccv
    FROM game_tracker_snapshots
    WHERE game_tracker_id = ?
      AND channel_id = ?
      AND "timestamp" >= ?
      AND "timestamp" <= ?
    GROUP BY ts
    ORDER BY ts ASC
    `,
    [gameTrackerId, channelId, fromTs, toTs],
  );
  return result.rows.map((r) => ({ ts: r.ts, ccv: Number(r.ccv) }));
}

/** Chat volume per minute for one session window. Empty when no data. */
export async function chatWindow(
  channelId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ minute: Date; messages: number; chatters: number }>> {
  const result = await db.raw<{
    rows: Array<{ minute: Date; messages: number; chatters: number }>;
  }>(
    `
    SELECT minute, messages, chatters
    FROM chat_minute_rollup
    WHERE channel_id = ?
      AND minute >= date_trunc('minute', ?::timestamptz)
      AND minute <= ?
    ORDER BY minute ASC
    `,
    [channelId, fromTs, toTs],
  );
  return result.rows.map((r) => ({
    minute: r.minute,
    messages: Number(r.messages),
    chatters: Number(r.chatters),
  }));
}

/**
 * Rank of one session's peak_ccv among ALL sessions of the tracker
 * overlapping the same UTC calendar day (the day the session started),
 * plus the overlap count. Ties share the better rank.
 */
export async function rankForSession(
  gameTrackerId: string,
  sessionId: string,
): Promise<{ byPeakInTracker: number; of: number }> {
  const result = await db.raw<{ rows: Array<{ rank: string; of: string }> }>(
    `
    WITH me AS (
      SELECT started_at, peak_ccv FROM stream_sessions WHERE id = ?
    ),
    day AS (
      SELECT date_trunc('day', (SELECT started_at FROM me) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
    ),
    overlapping AS (
      SELECT s.peak_ccv
      FROM stream_sessions s, day d
      WHERE s.game_tracker_id = ?
        AND s.started_at < d.day_start + interval '1 day'
        AND COALESCE(s.ended_at, now()) >= d.day_start
    )
    SELECT COUNT(*) FILTER (WHERE o.peak_ccv > (SELECT peak_ccv FROM me)) + 1 AS rank,
           COUNT(*) AS of
    FROM overlapping o
    `,
    [sessionId, gameTrackerId],
  );
  const row = result.rows[0];
  return { byPeakInTracker: Number(row?.rank ?? 1), of: Number(row?.of ?? 0) };
}

/**
 * This channel's neighboring sessions by started_at within the tracker
 * (for prev/next stream navigation). Null at the edges.
 */
export async function neighborStreamIds(
  gameTrackerId: string,
  channelId: string,
  startedAt: Date,
): Promise<{ prevStreamId: string | null; nextStreamId: string | null }> {
  const [prev, next] = await Promise.all([
    db(TABLE)
      .where({ game_tracker_id: gameTrackerId, channel_id: channelId })
      .where('started_at', '<', startedAt)
      .orderBy('started_at', 'desc')
      .first('stream_id'),
    db(TABLE)
      .where({ game_tracker_id: gameTrackerId, channel_id: channelId })
      .where('started_at', '>', startedAt)
      .orderBy('started_at', 'asc')
      .first('stream_id'),
  ]);
  return {
    prevStreamId: prev?.stream_id ?? null,
    nextStreamId: next?.stream_id ?? null,
  };
}

// ── Channel summary aggregates ───────────────────────────────────────────

/**
 * Latest follower count + delta vs the closest snapshot at least 7 days
 * old. Nulls when the data doesn't exist yet.
 */
export async function followerSummary(
  channelId: string,
): Promise<{ current: number | null; delta7d: number | null }> {
  const result = await db.raw<{
    rows: Array<{ current: number | null; past: number | null }>;
  }>(
    `
    SELECT
      (SELECT followers FROM channel_follower_snapshots
        WHERE channel_id = ? ORDER BY ts DESC LIMIT 1) AS current,
      (SELECT followers FROM channel_follower_snapshots
        WHERE channel_id = ? AND ts <= now() - interval '7 days'
        ORDER BY ts DESC LIMIT 1) AS past
    `,
    [channelId, channelId],
  );
  const row = result.rows[0];
  const current = row?.current != null ? Number(row.current) : null;
  const past = row?.past != null ? Number(row.past) : null;
  return {
    current,
    delta7d: current != null && past != null ? current - past : null,
  };
}

/**
 * Channel's best session peak among sessions overlapping today (UTC),
 * ranked against every other channel's best today in this tracker.
 * todayByPeak is null when the channel has no session today.
 */
export async function todayRank(
  gameTrackerId: string,
  channelId: string,
): Promise<{ todayByPeak: number | null; of: number }> {
  const result = await db.raw<{
    rows: Array<{ rank: string | null; of: string }>;
  }>(
    `
    WITH day AS (
      SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
    ),
    per_channel AS (
      SELECT s.channel_id, MAX(s.peak_ccv) AS best
      FROM stream_sessions s, day d
      WHERE s.game_tracker_id = ?
        AND s.started_at < d.day_start + interval '1 day'
        AND COALESCE(s.ended_at, now()) >= d.day_start
      GROUP BY s.channel_id
    ),
    me AS (SELECT best FROM per_channel WHERE channel_id = ?)
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM me)
           THEN (SELECT COUNT(*) FROM per_channel WHERE best > (SELECT best FROM me)) + 1
           ELSE NULL END AS rank,
      (SELECT COUNT(*) FROM per_channel) AS of
    `,
    [gameTrackerId, channelId],
  );
  const row = result.rows[0];
  return {
    todayByPeak: row?.rank != null ? Number(row.rank) : null,
    of: Number(row?.of ?? 0),
  };
}

/**
 * Percentile (0-100) of the channel's best session peak in the last 30
 * days among all channels' best peaks in this tracker. Null when the
 * channel has no sessions in the window or fewer than 10 channels do.
 */
export async function peakPercentile30d(
  gameTrackerId: string,
  channelId: string,
): Promise<number | null> {
  const result = await db.raw<{
    rows: Array<{ pct: string; n: string }>;
  }>(
    `
    WITH per_channel AS (
      SELECT channel_id, MAX(peak_ccv) AS best
      FROM stream_sessions
      WHERE game_tracker_id = ?
        AND started_at >= now() - interval '30 days'
      GROUP BY channel_id
    ),
    ranked AS (
      SELECT channel_id,
             PERCENT_RANK() OVER (ORDER BY best) AS pr,
             COUNT(*) OVER () AS n
      FROM per_channel
    )
    SELECT ROUND(pr * 100) AS pct, n FROM ranked WHERE channel_id = ?
    `,
    [gameTrackerId, channelId],
  );
  const row = result.rows[0];
  if (!row || Number(row.n) < 10) return null;
  return Number(row.pct);
}

/**
 * Health rollup over the channel's scored sessions in the last 30 days:
 * average health_score, the MEDIAN session grade (letters are flag-gated
 * per session, so the channel letter must come from the session letters,
 * not from re-cutting the avg score — A-F sorts correctly as text), and
 * how many scored sessions back it.
 */
export async function healthSummary30d(
  gameTrackerId: string,
  channelId: string,
): Promise<{ avgScore: number | null; medianGrade: string | null; scoredSessions: number }> {
  const result = await db.raw<{
    rows: Array<{ avg_score: number | null; median_grade: string | null; n: string }>;
  }>(
    `
    SELECT ROUND(AVG(health_score))::int AS avg_score,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY health_grade) AS median_grade,
           COUNT(*) AS n
    FROM stream_sessions
    WHERE game_tracker_id = ?
      AND channel_id = ?
      AND health_score IS NOT NULL
      AND started_at >= now() - interval '30 days'
    `,
    [gameTrackerId, channelId],
  );
  const row = result.rows[0];
  return {
    avgScore: row?.avg_score != null ? Number(row.avg_score) : null,
    medianGrade: row?.median_grade ?? null,
    scoredSessions: Number(row?.n ?? 0),
  };
}

/**
 * Average chat engagement over the channel's last 30 days: AVG over
 * minutes of (chatters / per-minute MAX ccv) * 100, joining
 * chat_minute_rollup to the per-minute snapshot rollup. Null when the
 * channel has no chat data in the window.
 */
export async function avgChattersPerViewerPct(
  gameTrackerId: string,
  channelId: string,
): Promise<number | null> {
  const result = await db.raw<{ rows: Array<{ pct: string | null }> }>(
    `
    WITH per_minute AS (
      SELECT date_trunc('minute', "timestamp") AS minute,
             MAX(concurrent_viewers) AS ccv
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ?
        AND channel_id = ?
        AND "timestamp" >= now() - interval '30 days'
      GROUP BY minute
    )
    SELECT ROUND(AVG((r.chatters::numeric / NULLIF(pm.ccv, 0)) * 100), 2) AS pct
    FROM per_minute pm
    JOIN chat_minute_rollup r
      ON r.channel_id = ?
     AND r.minute = pm.minute
    `,
    [gameTrackerId, channelId, channelId],
  );
  const pct = result.rows[0]?.pct;
  return pct != null ? Number(pct) : null;
}
