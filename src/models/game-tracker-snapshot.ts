import db from '../utils/db';

export interface GameTrackerSnapshot {
  id: string;
  game_tracker_id: string;
  channel_id: string;
  timestamp: Date;
  concurrent_viewers: number;
  platform: string;
  language: string | null;
  region: string | null;
  stream_id: string | null;
  stream_title: string | null;
  game_name: string | null;
  started_at: Date | null;
}

export interface InsertSnapshot {
  game_tracker_id: string;
  channel_id: string;
  timestamp: Date;
  concurrent_viewers: number;
  platform: string;
  language?: string | null;
  region?: string | null;
  stream_id?: string | null;
  stream_title?: string | null;
  game_name?: string | null;
  started_at?: Date | null;
}

const TABLE = 'game_tracker_snapshots';

export async function bulkInsert(rows: InsertSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db(TABLE).insert(rows);
  return rows.length;
}

/**
 * Aggregate snapshots into time buckets for trend rendering.
 *
 * CCV is a point-in-time quantity — concurrent viewers AT a moment, not
 * a flow. Naively SUM-ing all rows in a bucket inflates the value by
 * the number of minutes in the bucket (every channel writes one row
 * per minute). The correct shape is two steps:
 *   1. SUM per minute → "total concurrent viewers across all channels
 *      at this minute" (this IS a sum because the channels are distinct
 *      at the same instant).
 *   2. AVG over minutes inside the bucket → "typical total CCV across
 *      this 5-min window".
 *
 * Same logic for stream_count: count distinct channels per minute,
 * then average minutes within the bucket. (Counting distinct directly
 * across the full bucket double-counts a streamer that appears in 5
 * consecutive minutes only once, so the per-minute approach is also
 * what the user expects when reading the chart.)
 */
export async function rangeAggregate(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  bucketSeconds = 60,
): Promise<Array<{ ts: Date; total_ccv: number; stream_count: number }>> {
  const rows = await db.raw<{
    rows: Array<{ ts: Date; total_ccv: string | null; stream_count: string | null }>;
  }>(
    `
    WITH per_minute AS (
      SELECT
        date_trunc('minute', "timestamp") AS minute_ts,
        SUM(concurrent_viewers) AS minute_total_ccv,
        COUNT(DISTINCT channel_id) AS minute_stream_count
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ?
        AND "timestamp" >= ?
        AND "timestamp" < ?
      GROUP BY minute_ts
    )
    SELECT
      date_bin(?::interval, minute_ts, ?::timestamptz) AS ts,
      AVG(minute_total_ccv)::float AS total_ccv,
      AVG(minute_stream_count)::float AS stream_count
    FROM per_minute
    GROUP BY ts
    ORDER BY ts ASC
    `,
    [gameTrackerId, fromTs, toTs, `${bucketSeconds} seconds`, fromTs],
  );
  return rows.rows.map((r) => ({
    ts: r.ts,
    total_ccv: r.total_ccv ? Math.round(Number(r.total_ccv)) : 0,
    stream_count: r.stream_count ? Math.round(Number(r.stream_count)) : 0,
  }));
}

export async function leaderboardAt(
  gameTrackerId: string,
  at: Date,
  windowSeconds = 120,
  limit = 50,
): Promise<
  Array<{
    channel_id: string;
    concurrent_viewers: number;
    stream_title: string | null;
    platform: string;
    language: string | null;
    timestamp: Date;
  }>
> {
  // Pick the most recent row per channel within [at-window, at]
  const fromTs = new Date(at.getTime() - windowSeconds * 1000);
  return db
    .select<
      Array<{
        channel_id: string;
        concurrent_viewers: number;
        stream_title: string | null;
        platform: string;
        language: string | null;
        timestamp: Date;
      }>
    >('s.channel_id', 's.concurrent_viewers', 's.stream_title', 's.platform', 's.language', 's.timestamp')
    .from(
      db.raw(
        `(
          SELECT DISTINCT ON (channel_id)
            channel_id, concurrent_viewers, stream_title, platform, language, "timestamp"
          FROM game_tracker_snapshots
          WHERE game_tracker_id = ?
            AND "timestamp" >= ?
            AND "timestamp" <= ?
          ORDER BY channel_id, "timestamp" DESC
        ) s`,
        [gameTrackerId, fromTs, at],
      ),
    )
    .orderBy('s.concurrent_viewers', 'desc')
    .limit(limit);
}

export async function rangeLeaderboard(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  limit = 50,
  opts: { language?: string | null; platform?: string | null; offset?: number } = {},
): Promise<
  Array<{
    channel_id: string;
    peak_ccv: number;
    avg_ccv: number;
    minutes_live: number;
    days_streamed: number;
    platform: string;
    language: string | null;
  }>
> {
  // Per-STREAMER aggregates within the range. We group by streamer identity
  // (platform + lower(channel_identifier)) rather than channel_id, because
  // the same streamer can have several channel rows across series (gt-pubg,
  // a tournament series, …) and the game tracker accumulates snapshots under
  // each — grouping by channel_id would list the streamer multiple times.
  // Merging by identity dedups those and unions their minutes/days.
  //
  // - peak_ccv     = MAX across all the streamer's snapshots
  // - avg_ccv      = AVG across all snapshots
  // - minutes_live = distinct minutes with a snapshot (overlaps counted once)
  // - days_streamed= distinct calendar days with a snapshot
  // A representative channel_id (the highest-peak one) is returned for the
  // row link/avatar; identifier+platform are identical across the merged set.
  // Optional server-side language/platform filters (so e.g. picking "TR"
  // returns the top TR streamers, not just the TR streamers that happened to
  // be in the global top-N), plus OFFSET for pagination.
  const params: unknown[] = [gameTrackerId, fromTs, toTs];
  let filterSql = '';
  if (opts.language) {
    filterSql += ' AND LOWER(s.language) = LOWER(?)';
    params.push(opts.language);
  }
  if (opts.platform) {
    filterSql += ' AND c.platform = ?';
    params.push(opts.platform);
  }
  params.push(limit, Math.max(0, opts.offset ?? 0));
  const rows = await db.raw<{
    rows: Array<{
      channel_id: string;
      peak_ccv: string;
      avg_ccv: string;
      minutes_live: string;
      days_streamed: string;
      platform: string;
      language: string | null;
    }>;
  }>(
    `
    SELECT
      (array_agg(s.channel_id ORDER BY s.concurrent_viewers DESC))[1] AS channel_id,
      MAX(s.concurrent_viewers) AS peak_ccv,
      AVG(s.concurrent_viewers)::int AS avg_ccv,
      COUNT(DISTINCT date_trunc('minute', s."timestamp")) AS minutes_live,
      COUNT(DISTINCT date_trunc('day', s."timestamp")) AS days_streamed,
      MAX(s.platform) AS platform,
      MAX(s.language) AS language
    FROM game_tracker_snapshots s
    JOIN channels c ON c.id = s.channel_id
    WHERE s.game_tracker_id = ?
      AND s."timestamp" >= ?
      AND s."timestamp" < ?
      ${filterSql}
    GROUP BY c.platform, LOWER(c.channel_identifier)
    ORDER BY peak_ccv DESC
    LIMIT ? OFFSET ?
    `,
    params,
  );
  return rows.rows.map((r) => ({
    channel_id: r.channel_id,
    peak_ccv: Number(r.peak_ccv),
    avg_ccv: Number(r.avg_ccv),
    minutes_live: Number(r.minutes_live),
    days_streamed: Number(r.days_streamed),
    platform: r.platform,
    language: r.language,
  }));
}

/**
 * Total distinct streamers in the range-leaderboard for a tracker — same
 * streamer-identity grouping + filters as rangeLeaderboard(), so the UI can
 * render "Page X of Y" instead of a bare Prev/Next heuristic.
 */
export async function countRangeLeaderboard(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
  opts: { language?: string | null; platform?: string | null } = {},
): Promise<number> {
  const params: unknown[] = [gameTrackerId, fromTs, toTs];
  let filterSql = '';
  if (opts.language) {
    filterSql += ' AND LOWER(s.language) = LOWER(?)';
    params.push(opts.language);
  }
  if (opts.platform) {
    filterSql += ' AND c.platform = ?';
    params.push(opts.platform);
  }
  const result = await db.raw<{ rows: Array<{ n: string }> }>(
    `
    SELECT COUNT(*) AS n FROM (
      SELECT 1
      FROM game_tracker_snapshots s
      JOIN channels c ON c.id = s.channel_id
      WHERE s.game_tracker_id = ?
        AND s."timestamp" >= ?
        AND s."timestamp" < ?
        ${filterSql}
      GROUP BY c.platform, LOWER(c.channel_identifier)
    ) q
    `,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function languageBreakdown(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ language: string | null; total_ccv_minutes: number; peak: number }>> {
  // pg returns SUM()/MAX() of integer columns as strings — coerce, or JSON
  // consumers end up string-concatenating totals (the 0.0% breakdown bug).
  const rows = await db(TABLE)
    .select('language')
    .sum<{ total_ccv_minutes: string }[]>({ total_ccv_minutes: 'concurrent_viewers' })
    .max<{ peak: number }[]>({ peak: 'concurrent_viewers' })
    .where('game_tracker_id', gameTrackerId)
    .where('timestamp', '>=', fromTs)
    .where('timestamp', '<', toTs)
    .groupBy('language')
    .orderBy('total_ccv_minutes', 'desc');
  return (rows as Array<{ language: string | null; total_ccv_minutes: unknown; peak: unknown }>).map((r) => ({
    language: r.language,
    total_ccv_minutes: Number(r.total_ccv_minutes),
    peak: Number(r.peak),
  }));
}

/**
 * Per-channel time series within a tracker — for the broadcast-detail
 * page when an operator clicks a streamer row in the leaderboard.
 *
 * Returns one row per bucket with the channel's CCV. No aggregation
 * across channels, just this one streamer's timeline.
 */
export async function channelTimeline(
  gameTrackerId: string,
  channelId: string,
  fromTs: Date,
  toTs: Date,
  bucketSeconds = 60,
): Promise<
  Array<{
    ts: Date;
    concurrent_viewers: number;
    stream_title: string | null;
    stream_id: string | null;
  }>
> {
  const result = await db.raw<{
    rows: Array<{
      ts: Date;
      concurrent_viewers: string;
      stream_title: string | null;
      stream_id: string | null;
    }>;
  }>(
    `
    SELECT
      date_bin(?::interval, "timestamp", ?::timestamptz) AS ts,
      AVG(concurrent_viewers)::int AS concurrent_viewers,
      (array_agg(stream_title ORDER BY "timestamp" DESC) FILTER (WHERE stream_title IS NOT NULL))[1] AS stream_title,
      (array_agg(stream_id ORDER BY "timestamp" DESC) FILTER (WHERE stream_id IS NOT NULL))[1] AS stream_id
    FROM game_tracker_snapshots
    WHERE game_tracker_id = ?
      AND channel_id = ?
      AND "timestamp" >= ?
      AND "timestamp" < ?
    GROUP BY ts
    ORDER BY ts ASC
    `,
    [`${bucketSeconds} seconds`, fromTs, gameTrackerId, channelId, fromTs, toTs],
  );
  return result.rows.map((r) => ({
    ts: r.ts,
    concurrent_viewers: Number(r.concurrent_viewers),
    stream_title: r.stream_title,
    stream_id: r.stream_id,
  }));
}

/**
 * Distinct stream sessions for a channel within a tracker. A "session"
 * is a contiguous run of snapshots with the same stream_id. Returns
 * one row per session: title, peak, avg, start/end, minutes_live.
 *
 * Used by the broadcast-detail page to list "today's stream / yesterday's
 * stream / etc." for the streamer.
 */
export async function channelSessions(
  gameTrackerId: string,
  channelId: string,
  daysBack = 30,
): Promise<
  Array<{
    stream_id: string | null;
    stream_title: string | null;
    peak_ccv: number;
    avg_ccv: number;
    minutes_live: number;
    started_at: Date;
    ended_at: Date;
  }>
> {
  const result = await db.raw<{
    rows: Array<{
      stream_id: string | null;
      stream_title: string | null;
      peak_ccv: string;
      avg_ccv: string;
      minutes_live: string;
      started_at: Date;
      ended_at: Date;
    }>;
  }>(
    `
    SELECT
      stream_id,
      (array_agg(stream_title ORDER BY "timestamp" DESC) FILTER (WHERE stream_title IS NOT NULL))[1] AS stream_title,
      MAX(concurrent_viewers) AS peak_ccv,
      AVG(concurrent_viewers)::int AS avg_ccv,
      COUNT(DISTINCT date_trunc('minute', "timestamp")) AS minutes_live,
      MIN("timestamp") AS started_at,
      MAX("timestamp") AS ended_at
    FROM game_tracker_snapshots
    WHERE game_tracker_id = ?
      AND channel_id = ?
      AND "timestamp" > NOW() - (?::int * INTERVAL '1 day')
    GROUP BY stream_id
    HAVING MAX(concurrent_viewers) > 0
    ORDER BY MIN("timestamp") DESC
    `,
    [gameTrackerId, channelId, daysBack],
  );
  return result.rows.map((r) => ({
    stream_id: r.stream_id,
    stream_title: r.stream_title,
    peak_ccv: Number(r.peak_ccv),
    avg_ccv: Number(r.avg_ccv),
    minutes_live: Number(r.minutes_live),
    started_at: r.started_at,
    ended_at: r.ended_at,
  }));
}

/**
 * Search by stream title and channel display_name within a tracker.
 * One row per matching channel with its latest title and window peak.
 *
 * Runs against stream_sessions (one row per stream, titles jsonb kept as
 * a change history), NOT the raw snapshot table — an un-indexable ILIKE
 * over tens of millions of snapshot rows is what used to run this
 * straight into the statement timeout. Sessions are also retained
 * forever, so long-window search keeps working after raw retention
 * purges old snapshots. started_at gets a (window + 2d) prefilter so the
 * (game_tracker_id, started_at) index does the heavy lifting.
 */
export async function searchTitlesAndChannels(
  gameTrackerId: string,
  query: string,
  daysBack = 30,
  limit = 50,
): Promise<
  Array<{
    channel_id: string;
    last_seen: Date;
    stream_title: string | null;
    peak_ccv: number;
    matched_field: 'title' | 'channel';
  }>
> {
  const escaped = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const result = await db.raw<{
    rows: Array<{
      channel_id: string;
      last_seen: Date;
      stream_title: string | null;
      peak_ccv: string;
      matched_field: 'title' | 'channel';
    }>;
  }>(
    `
    SELECT
      ss.channel_id,
      MAX(ss.last_seen_at) AS last_seen,
      (array_agg(ss.titles -> (jsonb_array_length(ss.titles) - 1) ->> 'title'
                 ORDER BY ss.last_seen_at DESC)
         FILTER (WHERE jsonb_array_length(ss.titles) > 0))[1] AS stream_title,
      MAX(ss.peak_ccv) AS peak_ccv,
      CASE WHEN BOOL_OR(c.display_name ILIKE ? OR c.channel_identifier ILIKE ?)
           THEN 'channel' ELSE 'title' END AS matched_field
    FROM stream_sessions ss
    JOIN channels c ON c.id = ss.channel_id
    WHERE ss.game_tracker_id = ?
      AND ss.started_at > NOW() - ((?::int + 2) * INTERVAL '1 day')
      AND ss.last_seen_at > NOW() - (?::int * INTERVAL '1 day')
      AND (
        c.display_name ILIKE ?
        OR c.channel_identifier ILIKE ?
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(ss.titles) t
          WHERE t ->> 'title' ILIKE ?
        )
      )
    GROUP BY ss.channel_id
    ORDER BY last_seen DESC
    LIMIT ?
    `,
    [
      escaped, escaped,
      gameTrackerId, daysBack, daysBack,
      escaped, escaped, escaped,
      limit,
    ],
  );
  return result.rows.map((r) => ({
    channel_id: r.channel_id,
    last_seen: r.last_seen,
    stream_title: r.stream_title,
    peak_ccv: Number(r.peak_ccv),
    matched_field: r.matched_field,
  }));
}

export async function platformBreakdown(
  gameTrackerId: string,
  fromTs: Date,
  toTs: Date,
): Promise<Array<{ platform: string; total_ccv_minutes: number; peak: number }>> {
  // Same coercion as languageBreakdown — pg SUM()/MAX() arrive as strings.
  const rows = await db(TABLE)
    .select('platform')
    .sum<{ total_ccv_minutes: string }[]>({ total_ccv_minutes: 'concurrent_viewers' })
    .max<{ peak: number }[]>({ peak: 'concurrent_viewers' })
    .where('game_tracker_id', gameTrackerId)
    .where('timestamp', '>=', fromTs)
    .where('timestamp', '<', toTs)
    .groupBy('platform')
    .orderBy('total_ccv_minutes', 'desc');
  return (rows as Array<{ platform: string; total_ccv_minutes: unknown; peak: unknown }>).map((r) => ({
    platform: r.platform,
    total_ccv_minutes: Number(r.total_ccv_minutes),
    peak: Number(r.peak),
  }));
}

export async function purgeOlderThan(daysOld: number): Promise<number> {
  return db(TABLE)
    .where('timestamp', '<', db.raw(`NOW() - INTERVAL '? days'`, [daysOld]))
    .delete();
}
