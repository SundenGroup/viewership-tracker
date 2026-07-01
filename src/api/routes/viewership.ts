import { Router, Request, Response, NextFunction } from 'express';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';
import { publicCacheMiddleware } from '../middleware/public-cache';
import db from '../../utils/db';

const router = Router();

// Editor aggregations are uncacheable from the public-cache layer because
// their Referer is the admin dashboard, not /public/*. Without protection,
// each editor poll fires 5-8 heavy timeseries/metrics aggregations on
// viewership_snapshots — N concurrent editors stampedes PG. Cache with
// short TTLs so an edit (channel add, view-group change) surfaces within
// seconds while collapsing duplicate concurrent fetches to a single PG
// hit per URL window.
//   live           5s — feels real-time, cheap; small drift fine
//   metrics       10s — moderate aggregation, matches editor poll cadence
//   timeseries    15s — heaviest aggregation, low volatility
//   leaderboard   15s — same shape as timeseries
const liveCache        = publicCacheMiddleware({ ttlMs:  5_000, label: 'live',        scope: 'any' });
const metricsCache     = publicCacheMiddleware({ ttlMs: 10_000, label: 'metrics',     scope: 'any' });
const timeseriesCache  = publicCacheMiddleware({ ttlMs: 15_000, label: 'timeseries',  scope: 'any' });
const leaderboardCache = publicCacheMiddleware({ ttlMs: 15_000, label: 'leaderboard', scope: 'any' });

// ── Helpers ─────────────────────────────────────────────────────────────

function parseScope(
  query: Record<string, unknown>,
): { level: 'day' | 'stage' | 'series'; id: string } | null {
  const { scope, id } = query;
  if (!scope || !id) return null;
  if (!['day', 'stage', 'series'].includes(scope as string)) return null;
  return { level: scope as 'day' | 'stage' | 'series', id: id as string };
}

function parseViewFilter(query: Record<string, unknown>): ViewershipSnapshotModel.ViewFilter | undefined {
  const languages = (query.languages as string)?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const platforms = (query.platforms as string)?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!languages?.length && !platforms?.length) return undefined;
  return {
    ...(languages?.length ? { languages } : {}),
    ...(platforms?.length ? { platforms } : {}),
  };
}

function isValidUUID(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/viewership/live/:seriesId — Current live CCV (latest snapshot per channel)
// Optional query params: ?scope=day|stage&id=<uuid> to filter by scope
router.get('/live/:seriesId', liveCache, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidUUID(req.params.seriesId)) {
      res.status(400).json({ error: 'Invalid seriesId format' });
      return;
    }
    const scope = parseScope(req.query) ?? undefined;
    const filter = parseViewFilter(req.query as Record<string, unknown>);
    const snapshots = await ViewershipSnapshotModel.getLatestSnapshot(req.params.seriesId as string, scope, filter);

    // Deduplicate: take MAX(concurrent_viewers) per channel_id to handle
    // duplicate rows from the polling orchestrator (cross-series channels).
    const channelMax = new Map<string, number>();
    for (const s of snapshots) {
      channelMax.set(s.channel_id, Math.max(channelMax.get(s.channel_id) ?? 0, s.concurrent_viewers));
    }
    const totalCCV = [...channelMax.values()].reduce((sum, v) => sum + v, 0);
    const channelCount = channelMax.size;
    const liveCount = [...channelMax.entries()].filter(([, v]) => v > 0).length;

    res.json({
      seriesId: req.params.seriesId as string,
      timestamp: snapshots.length > 0 ? snapshots[0].timestamp : null,
      totalCCV,
      channelCount,
      liveChannels: liveCount,
      channels: snapshots.map((s) => ({
        channelId: s.channel_id,
        displayName: s.display_name,
        channelIdentifier: s.channel_identifier,
        platform: s.platform,
        concurrentViewers: s.concurrent_viewers,
        language: s.language,
        region: s.region,
        tier: s.tier ?? null,
        timestamp: s.timestamp,
        streamId: s.stream_id ?? null,
        streamTitle: s.stream_title ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewership/snapshots — Raw snapshots with filters, paginated
router.get('/snapshots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scopeObj = parseScope(req.query);
    if (!scopeObj) {
      res.status(400).json({ error: 'scope (day|stage|series) and id are required' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit as string, 10) || 100));
    const offset = (page - 1) * limit;

    const scopeColumn =
      scopeObj.level === 'day' ? 'broadcast_day_id' :
      scopeObj.level === 'stage' ? 'stage_id' : 'series_id';

    let query = db('viewership_snapshots').where(scopeColumn, scopeObj.id);

    // Optional filters
    const { startTime, endTime, platform, language, region } = req.query;
    if (startTime) query = query.where('timestamp', '>=', new Date(startTime as string));
    if (endTime) query = query.where('timestamp', '<=', new Date(endTime as string));
    if (platform) query = query.where('platform', platform as string);
    if (language) query = query.where('language', language as string);
    if (region) query = query.where('region', region as string);

    // Count total
    const [{ count }] = await query.clone().count('* as count');
    const total = parseInt(count as string, 10);

    // Fetch page
    const snapshots = await query
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .offset(offset)
      .select('*');

    res.json({
      data: snapshots,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewership/metrics — Derived metrics for a scope
router.get('/metrics', metricsCache, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scopeObj = parseScope(req.query);
    if (!scopeObj) {
      res.status(400).json({ error: 'scope (day|stage|series) and id are required' });
      return;
    }

    const filter = parseViewFilter(req.query as Record<string, unknown>);

    const [
      peakCCV,
      avgCCV,
      totalViewedHours,
      platformBreakdown,
      languageBreakdown,
      regionBreakdown,
      channelLeaderboard,
    ] = await Promise.all([
      ViewershipSnapshotModel.getPeakCCV(scopeObj, filter),
      ViewershipSnapshotModel.getAverageCCV(scopeObj, filter),
      ViewershipSnapshotModel.getTotalViewedHours(scopeObj, filter),
      ViewershipSnapshotModel.getPlatformBreakdown(scopeObj, filter),
      ViewershipSnapshotModel.getLanguageBreakdown(scopeObj, filter),
      ViewershipSnapshotModel.getRegionBreakdown(scopeObj, filter),
      ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 9999, filter),
    ]);

    res.json({
      scope: scopeObj,
      peakCCV: peakCCV ? {
        timestamp: peakCCV.timestamp,
        totalCCV: parseInt(peakCCV.total_ccv, 10),
      } : null,
      avgCCV: parseFloat(avgCCV),
      totalViewedHours: parseFloat(totalViewedHours),
      platformBreakdown: platformBreakdown.map((b) => ({
        platform: b.key,
        totalCCV: parseInt(b.total_ccv, 10),
        avgCCV: parseFloat(b.avg_ccv),
        peakCCV: parseInt(b.peak_ccv, 10),
      })),
      languageBreakdown: languageBreakdown.map((b) => ({
        language: b.key,
        totalCCV: parseInt(b.total_ccv, 10),
        avgCCV: parseFloat(b.avg_ccv),
        peakCCV: parseInt(b.peak_ccv, 10),
      })),
      regionBreakdown: regionBreakdown.map((b) => ({
        region: b.key,
        totalCCV: parseInt(b.total_ccv, 10),
        avgCCV: parseFloat(b.avg_ccv),
        peakCCV: parseInt(b.peak_ccv, 10),
      })),
      channelLeaderboard: channelLeaderboard.map((e) => ({
        channelId: e.channel_id,
        channelIdentifier: e.channel_identifier,
        displayName: e.display_name,
        platform: e.platform,
        tier: e.tier ?? 'community',
        language: e.language ?? null,
        region: e.region ?? null,
        peakCCV: parseInt(e.peak_ccv, 10),
        avgCCV: parseFloat(e.avg_ccv),
        totalViewedMinutes: parseInt(e.total_viewed_minutes, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewership/timeseries — Time-bucketed data for charting
router.get('/timeseries', timeseriesCache, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scopeObj = parseScope(req.query);
    if (!scopeObj) {
      res.status(400).json({ error: 'scope (day|stage|series) and id are required' });
      return;
    }

    const interval = parseInt(req.query.interval as string, 10) || 60;
    if (![60, 300, 600].includes(interval)) {
      res.status(400).json({ error: 'interval must be one of: 60, 300, 600 (seconds)' });
      return;
    }

    const groupBy = (req.query.groupBy as string) || 'total';
    if (!['total', 'platform', 'language', 'region', 'channel', 'tier'].includes(groupBy)) {
      res.status(400).json({ error: 'groupBy must be one of: total, platform, language, region, channel, tier' });
      return;
    }

    const filter = parseViewFilter(req.query as Record<string, unknown>);

    if (groupBy === 'total') {
      const buckets = await ViewershipSnapshotModel.getTimeSeriesData(scopeObj, interval, filter);
      res.json({
        scope: scopeObj,
        interval,
        groupBy,
        data: buckets.map((b) => ({
          timestamp: b.bucket,
          totalCCV: parseInt(b.total_ccv, 10),
          channelCount: parseInt(b.channel_count, 10),
        })),
      });
      return;
    }

    // Grouped time series — build SQL dynamically
    const scopeColumn =
      scopeObj.level === 'day' ? 'broadcast_day_id' :
      scopeObj.level === 'stage' ? 'stage_id' : 'series_id';

    // For tier, we need to JOIN channels table; for others, column is on viewership_snapshots
    const needsJoin = groupBy === 'tier';
    const groupColumn = groupBy === 'channel' ? 'channel_id' : groupBy;
    const groupExpr = needsJoin ? 'c.tier' : `"${groupColumn}"`;
    const joinClause = needsJoin ? 'JOIN channels c ON c.id = vs.channel_id' : '';
    const vsPrefix = needsJoin ? 'vs.' : '';

    // Three-level dedup: SUM multi-stream rows per poll cycle, then MAX across
    // poll cycles per bucket per channel (picks the highest CCV), then SUM channels.
    // Works correctly with both 1x and 2x-per-minute polling.
    const fClauses = filter ? ViewershipSnapshotModel.buildFilterClauses(filter) : { sql: '', bindings: {} };
    // Prefix filter SQL with vs. alias when using JOIN
    const fSql = needsJoin ? fClauses.sql.replace(/\b(language|platform|region)\b/g, 'vs.$1') : fClauses.sql;
    const rows: Array<{ bucket: Date; group_key: string; total_ccv: string; channel_count: string }> = await db.raw(
      `SELECT bucket, group_key,
         SUM(channel_ccv)::text AS total_ccv,
         COUNT(*)::text AS channel_count
       FROM (
         SELECT bucket, channel_id, group_key,
           MAX(cycle_ccv) AS channel_ccv
         FROM (
           SELECT
             date_trunc('minute', ${vsPrefix}"timestamp")
               + (EXTRACT(epoch FROM ${vsPrefix}"timestamp" - date_trunc('minute', ${vsPrefix}"timestamp"))::int / :interval * :interval)
               * interval '1 second' AS bucket,
             ${vsPrefix}"timestamp" AS poll_ts,
             ${vsPrefix}channel_id,
             ${groupExpr} AS group_key,
             SUM(${vsPrefix}concurrent_viewers) AS cycle_ccv
           FROM viewership_snapshots ${needsJoin ? 'vs' : ''}
           ${joinClause}
           WHERE ${vsPrefix}"${scopeColumn}" = :id ${fSql}
           GROUP BY bucket, poll_ts, ${vsPrefix}channel_id, group_key
         ) per_cycle
         GROUP BY bucket, channel_id, group_key
       ) per_channel
       GROUP BY bucket, group_key
       ORDER BY bucket ASC, total_ccv DESC`,
      { interval, id: scopeObj.id, ...fClauses.bindings },
    ).then((r: { rows: Array<{ bucket: Date; group_key: string; total_ccv: string; channel_count: string }> }) => r.rows);

    res.json({
      scope: scopeObj,
      interval,
      groupBy,
      data: rows.map((r) => ({
        timestamp: r.bucket,
        groupKey: r.group_key,
        totalCCV: parseInt(r.total_ccv, 10),
        channelCount: parseInt(r.channel_count, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewership/leaderboard/:seriesId — Aggregate channel leaderboard
router.get('/leaderboard/:seriesId', leaderboardCache, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidUUID(req.params.seriesId)) {
      res.status(400).json({ error: 'Invalid seriesId format' });
      return;
    }

    const seriesId = req.params.seriesId as string;
    const scopeParam = (req.query.scope as string) || 'day';
    const dayId = req.query.dayId as string | undefined;
    const stageId = req.query.stageId as string | undefined;

    let scopeObj: ViewershipSnapshotModel.Scope;

    if (scopeParam === 'series') {
      scopeObj = { level: 'series', id: seriesId };
    } else if (scopeParam === 'stage') {
      // scope=stage: use provided stageId or fall back to series
      if (stageId && isValidUUID(stageId)) {
        scopeObj = { level: 'stage', id: stageId };
      } else {
        scopeObj = { level: 'series', id: seriesId };
      }
    } else {
      // scope=day: use provided dayId or auto-detect active/most recent
      if (dayId && isValidUUID(dayId)) {
        scopeObj = { level: 'day', id: dayId };
      } else {
        // Find active broadcast day (status='live') or most recent completed day
        const activeDay = await db('broadcast_days')
          .where('series_id', seriesId)
          .where('status', 'live')
          .orderBy('date', 'desc')
          .first();

        if (activeDay) {
          scopeObj = { level: 'day', id: activeDay.id };
        } else {
          // Fallback: most recent completed day
          const recentDay = await db('broadcast_days')
            .where('series_id', seriesId)
            .where('status', 'completed')
            .orderBy('date', 'desc')
            .first();

          if (recentDay) {
            scopeObj = { level: 'day', id: recentDay.id };
          } else {
            // No days at all — fall back to series scope
            scopeObj = { level: 'series', id: seriesId };
          }
        }
      }
    }

    const filter = parseViewFilter(req.query as Record<string, unknown>);
    const leaderboard = await ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 9999, filter);

    res.json({
      scope: scopeObj,
      channels: leaderboard.map((e) => ({
        channelId: e.channel_id,
        channelIdentifier: e.channel_identifier,
        displayName: e.display_name,
        platform: e.platform,
        tier: e.tier ?? 'community',
        language: e.language ?? null,
        region: e.region ?? null,
        peakCCV: parseInt(e.peak_ccv, 10),
        avgCCV: Math.round(parseFloat(e.avg_ccv)),
        viewedHours: Math.round(parseInt(e.total_viewed_minutes, 10) / 60),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/viewership/range-leaderboard ─────────────────────────────
// Returns leaderboard stats (peak/avg/viewed-minutes per channel) for an
// arbitrary timestamp range, scoped to a series. Used by the /explore page's
// drag-to-select-range panel. Same aggregation philosophy as the existing
// scope-based leaderboard query: SUM multi-stream per cycle, MAX across
// cycles per channel per minute, then aggregate over the window.
router.get('/range-leaderboard', leaderboardCache, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seriesId = req.query.seriesId as string | undefined;
    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;

    if (!seriesId || !isValidUUID(seriesId)) {
      res.status(400).json({ error: 'seriesId (UUID) is required' });
      return;
    }
    if (!fromStr || !toStr) {
      res.status(400).json({ error: 'from + to (ISO 8601) are required' });
      return;
    }
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO 8601 strings' });
      return;
    }
    if (to.getTime() <= from.getTime()) {
      res.status(400).json({ error: 'to must be after from' });
      return;
    }

    const result = await db.raw(
      `WITH per_cycle AS (
         SELECT vs.channel_id, date_trunc('minute', vs.timestamp) AS m,
                vs.timestamp AS poll_ts,
                SUM(vs.concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots vs
         WHERE vs.series_id = :seriesId
           AND vs.timestamp >= :fromTs AND vs.timestamp <= :toTs
         GROUP BY vs.channel_id, date_trunc('minute', vs.timestamp), vs.timestamp
       ),
       per_minute AS (
         SELECT channel_id, m, MAX(cycle_ccv) AS ccv
         FROM per_cycle GROUP BY channel_id, m
       )
       SELECT c.id AS channel_id,
              c.display_name,
              c.channel_identifier,
              c.platform,
              c.language,
              c.region,
              c.tier,
              MAX(per_minute.ccv)::int AS peak_ccv,
              AVG(per_minute.ccv)::float AS avg_ccv,
              SUM(per_minute.ccv)::int AS total_viewed_minutes
       FROM per_minute
       JOIN channels c ON c.id = per_minute.channel_id
       GROUP BY c.id, c.display_name, c.channel_identifier, c.platform, c.language, c.region, c.tier
       HAVING MAX(per_minute.ccv) > 0
       ORDER BY peak_ccv DESC`,
      { seriesId, fromTs: from, toTs: to },
    );
    const rows = (result as { rows: Array<Record<string, unknown>> }).rows;

    res.json({
      seriesId,
      from: from.toISOString(),
      to: to.toISOString(),
      channels: rows.map((r) => ({
        channelId: r.channel_id as string,
        displayName: r.display_name as string,
        channelIdentifier: r.channel_identifier as string,
        platform: r.platform as string,
        language: (r.language as string | null) ?? null,
        tier: (r.tier as string | null) ?? 'community',
        peakCCV: r.peak_ccv as number,
        avgCCV: Math.round(r.avg_ccv as number),
        viewedHours: Math.round((r.total_viewed_minutes as number) / 60),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/viewership/snapshot-at-timestamp ──────────────────────────
// Returns every channel's CCV at (or near) the requested timestamp,
// scoped to a series. Used by the /explore page's "what was happening at
// this exact minute?" panel.
//
// Query params:
//   seriesId   (required, UUID) — series to scope to
//   timestamp  (required, ISO 8601) — anchor moment
//   within     (optional, seconds, default 60, max 300) — search window
//
// Aggregation matches the dashboard chart's per-minute pipeline:
//   1. SUM multi-stream rows per poll cycle
//   2. MAX across poll cycles per channel within the window
//   3. Return per-channel rows ordered by ccv DESC
router.get('/snapshot-at-timestamp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seriesId = req.query.seriesId as string | undefined;
    const timestampStr = req.query.timestamp as string | undefined;
    const withinSecRaw = req.query.within as string | undefined;

    if (!seriesId || !isValidUUID(seriesId)) {
      res.status(400).json({ error: 'seriesId (UUID) is required' });
      return;
    }
    if (!timestampStr) {
      res.status(400).json({ error: 'timestamp (ISO 8601) is required' });
      return;
    }
    const ts = new Date(timestampStr);
    if (Number.isNaN(ts.getTime())) {
      res.status(400).json({ error: 'timestamp must be a valid ISO 8601 string' });
      return;
    }
    let within = parseInt(withinSecRaw ?? '60', 10);
    if (!Number.isFinite(within) || within < 0) within = 60;
    if (within > 300) within = 300;

    const fromTs = new Date(ts.getTime() - within * 1000);
    const toTs = new Date(ts.getTime() + within * 1000);

    // Three-level aggregation mirroring getTimeSeriesData:
    // SUM per poll cycle, MAX across cycles per channel.
    const result = await db.raw(
      `SELECT c.id AS channel_id,
              c.display_name,
              c.channel_identifier,
              c.platform,
              c.language,
              c.tier,
              MAX(per_cycle.cycle_ccv)::int AS ccv
       FROM (
         SELECT vs.channel_id,
                vs.timestamp AS poll_ts,
                SUM(vs.concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots vs
         WHERE vs.series_id = :seriesId
           AND vs.timestamp >= :fromTs
           AND vs.timestamp <= :toTs
         GROUP BY vs.channel_id, vs.timestamp
       ) per_cycle
       JOIN channels c ON c.id = per_cycle.channel_id
       GROUP BY c.id, c.display_name, c.channel_identifier, c.platform, c.language, c.tier
       HAVING MAX(per_cycle.cycle_ccv) > 0
       ORDER BY ccv DESC`,
      { seriesId, fromTs, toTs },
    );
    const rows = (result as { rows: Array<Record<string, unknown>> }).rows;

    res.json({
      seriesId,
      timestamp: ts.toISOString(),
      withinSeconds: within,
      channels: rows.map((r) => ({
        channelId: r.channel_id as string,
        displayName: r.display_name as string,
        channelIdentifier: r.channel_identifier as string,
        platform: r.platform as string,
        language: (r.language as string | null) ?? null,
        tier: (r.tier as string | null) ?? 'community',
        ccv: r.ccv as number,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/viewership/day-qa/:dayId
 *
 * Post-event data QA checklist for one broadcast day — the checks that
 * were run by hand after every PNC2026 day:
 *   - coverage gaps (minutes with zero data mid-broadcast → crash windows)
 *   - pinned channels that produced no data (never went live / wrong id)
 *   - data outside the scheduled window (post-stream tails to trim)
 *   - suspected cohost leftovers (channel pairs sharing identical values)
 *   - language hygiene (blank codes on channels with data)
 */
router.get('/day-qa/:dayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dayId = req.params.dayId as string;
    const day = await db('broadcast_days')
      .where('id', dayId)
      .first('id', 'series_id', 'label', 'broadcast_start', 'broadcast_end', 'status');
    if (!day) {
      res.status(404).json({ error: 'Broadcast day not found' });
      return;
    }

    // ── Basic stats + per-minute coverage ──
    const minuteRows = await db('viewership_snapshots')
      .where('broadcast_day_id', dayId)
      .select(db.raw("date_trunc('minute', \"timestamp\") as m"))
      .count('* as rows')
      .groupByRaw('1')
      .orderByRaw('1');
    const totalRows = minuteRows.reduce((s, r) => s + parseInt(String(r.rows), 10), 0);

    const gaps: Array<{ from: string; to: string; minutes: number }> = [];
    if (minuteRows.length > 1) {
      let prev = new Date(minuteRows[0].m as string).getTime();
      for (let i = 1; i < minuteRows.length; i++) {
        const cur = new Date(minuteRows[i].m as string).getTime();
        const deltaMin = Math.round((cur - prev) / 60_000);
        if (deltaMin > 2) {
          gaps.push({
            from: new Date(prev + 60_000).toISOString(),
            to: new Date(cur).toISOString(),
            minutes: deltaMin - 1,
          });
        }
        prev = cur;
      }
    }

    // ── Channels pinned to this day (or all-days) with zero data ──
    const zeroData = await db('channels as c')
      .where('c.series_id', day.series_id)
      .where('c.is_active', true)
      .where(function () {
        this.whereExists(
          db('channel_broadcast_days as cbd')
            .whereRaw('cbd.channel_id = c.id')
            .where('cbd.broadcast_day_id', dayId),
        ).orWhereNotExists(
          db('channel_broadcast_days as cbd2').whereRaw('cbd2.channel_id = c.id'),
        );
      })
      .whereNotExists(
        db('viewership_snapshots as v')
          .whereRaw('v.channel_id = c.id')
          .where('v.broadcast_day_id', dayId),
      )
      .select('c.id', 'c.platform', 'c.channel_identifier', 'c.display_name', 'c.tier');

    // ── Data outside the scheduled window (±15 min slack) ──
    const SLACK_MS = 15 * 60_000;
    const outside = await db('viewership_snapshots')
      .where('broadcast_day_id', dayId)
      .where(function () {
        this.where('timestamp', '<', new Date(new Date(day.broadcast_start).getTime() - SLACK_MS))
          .orWhere('timestamp', '>', new Date(new Date(day.broadcast_end).getTime() + SLACK_MS));
      })
      .count<{ count: string }[]>('* as count');
    const outsideRows = parseInt(outside[0]?.count ?? '0', 10);

    // ── Cohost leftovers: twitch channel pairs sharing the same nonzero
    //    value at the same minute ≥10 times (combined-badge signature) ──
    const cohostPairs = await db.raw(
      `
      WITH per_min AS (
        SELECT v.channel_id, date_trunc('minute', v."timestamp") AS m,
               max(v.concurrent_viewers) AS val
        FROM viewership_snapshots v
        JOIN channels c ON c.id = v.channel_id
        WHERE v.broadcast_day_id = ?
          AND c.platform = 'twitch'
          AND v.concurrent_viewers > 200
        GROUP BY 1, 2
      )
      SELECT c1.channel_identifier AS a, c2.channel_identifier AS b, count(*) AS shared_minutes
      FROM per_min p1
      JOIN per_min p2 ON p2.m = p1.m AND p2.val = p1.val AND p2.channel_id > p1.channel_id
      JOIN channels c1 ON c1.id = p1.channel_id
      JOIN channels c2 ON c2.id = p2.channel_id
      GROUP BY 1, 2
      HAVING count(*) >= 10
      ORDER BY shared_minutes DESC
      LIMIT 20
      `,
      [dayId],
    );

    // ── Language hygiene: channels with data but blank language ──
    const blankLanguage = await db('channels as c')
      .whereNull('c.language')
      .orWhere('c.language', '')
      .whereExists(
        db('viewership_snapshots as v')
          .whereRaw('v.channel_id = c.id')
          .where('v.broadcast_day_id', dayId),
      )
      .select('c.id', 'c.platform', 'c.channel_identifier', 'c.display_name');

    res.json({
      day: {
        id: day.id,
        label: day.label,
        status: day.status,
        broadcastStart: day.broadcast_start,
        broadcastEnd: day.broadcast_end,
      },
      totalRows,
      minutesWithData: minuteRows.length,
      gaps,
      zeroDataChannels: zeroData,
      outsideScheduleRows: outsideRows,
      cohostSuspectPairs: (cohostPairs.rows ?? []) as Array<{
        a: string;
        b: string;
        shared_minutes: string;
      }>,
      blankLanguageChannels: blankLanguage,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
