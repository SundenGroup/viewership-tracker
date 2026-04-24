import { Router, Request, Response, NextFunction } from 'express';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';
import db from '../../utils/db';

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────

function parseScope(query: Record<string, unknown>): ViewershipSnapshotModel.Scope | null {
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
router.get('/live/:seriesId', async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/timeseries', async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/leaderboard/:seriesId', async (req: Request, res: Response, next: NextFunction) => {
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
        peakCCV: parseInt(e.peak_ccv, 10),
        avgCCV: Math.round(parseFloat(e.avg_ccv)),
        viewedHours: Math.round(parseInt(e.total_viewed_minutes, 10) / 60),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
