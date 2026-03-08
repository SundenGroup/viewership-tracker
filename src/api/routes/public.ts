/**
 * Public API Routes — no authentication required
 *
 * All endpoints resolve the series by short_name and require is_public = true.
 * Mounted at /api/public BEFORE the global authenticate middleware.
 */

import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { stat } from 'fs/promises';
import { requirePublicSeries } from '../middleware/auth';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';
import * as TournamentSeriesModel from '../../models/tournament-series';
import db from '../../utils/db';

const router = Router();
const REPORTS_BASE_DIR = path.resolve(process.cwd(), 'reports');

// ── Helpers ──────────────────────────────────────────────────────────────

function getPublicSeries(req: Request): TournamentSeriesModel.TournamentSeries {
  return (req as Request & { publicSeries: TournamentSeriesModel.TournamentSeries }).publicSeries;
}

function isValidUUID(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

function parseScope(
  query: Record<string, unknown>,
  seriesId: string,
): ViewershipSnapshotModel.Scope | null {
  const scope = query.scope as string | undefined;
  const id = query.id as string | undefined;

  if (!scope || scope === 'series') return { level: 'series', id: seriesId };
  if (!id || !isValidUUID(id)) return null;
  if (!['day', 'stage'].includes(scope)) return null;
  return { level: scope as 'day' | 'stage', id };
}

// Apply requirePublicSeries to all routes under /:shortName
router.use('/:shortName', requirePublicSeries('shortName'));

// ── GET /api/public/:shortName — Series info + stages/broadcast days ────

router.get('/:shortName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const detail = await TournamentSeriesModel.findWithStages(series.id);

    res.json({
      id: series.id,
      name: series.name,
      shortName: series.short_name,
      game: series.game,
      partner: series.partner,
      status: series.status,
      timezone: series.timezone,
      startDate: series.start_date,
      endDate: series.end_date,
      stages: detail
        ? detail.stages.map((s) => ({
            id: s.id,
            name: s.name,
            order: s.order,
            start_date: s.start_date,
            end_date: s.end_date,
            broadcast_days: (s.broadcast_days ?? []).map((d) => ({
              id: d.id,
              label: d.label,
              date: d.date,
              status: d.status,
              broadcast_start: d.broadcast_start,
              broadcast_end: d.broadcast_end,
            })),
          }))
        : [],
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/public/:shortName/live-ccv ─────────────────────────────────

router.get('/:shortName/live-ccv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const snapshots = await ViewershipSnapshotModel.getLatestSnapshot(series.id);

    const totalCCV = snapshots.reduce((sum, s) => sum + s.concurrent_viewers, 0);
    const liveCount = snapshots.filter((s) => s.concurrent_viewers > 0).length;

    res.json({
      seriesId: series.id,
      timestamp: snapshots.length > 0 ? snapshots[0].timestamp : null,
      totalCCV,
      channelCount: snapshots.length,
      liveChannels: liveCount,
      channels: snapshots.map((s) => ({
        channelId: s.channel_id,
        displayName: s.display_name,
        channelIdentifier: s.channel_identifier,
        platform: s.platform,
        concurrentViewers: s.concurrent_viewers,
        language: s.language,
        region: s.region,
        timestamp: s.timestamp,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/public/:shortName/metrics ──────────────────────────────────

router.get('/:shortName/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const scopeObj = parseScope(req.query as Record<string, unknown>, series.id);
    if (!scopeObj) {
      res.status(400).json({ error: 'Invalid scope or id' });
      return;
    }

    const [
      peakCCV,
      avgCCV,
      totalViewedHours,
      platformBreakdown,
      languageBreakdown,
      regionBreakdown,
      channelLeaderboard,
    ] = await Promise.all([
      ViewershipSnapshotModel.getPeakCCV(scopeObj),
      ViewershipSnapshotModel.getAverageCCV(scopeObj),
      ViewershipSnapshotModel.getTotalViewedHours(scopeObj),
      ViewershipSnapshotModel.getPlatformBreakdown(scopeObj),
      ViewershipSnapshotModel.getLanguageBreakdown(scopeObj),
      ViewershipSnapshotModel.getRegionBreakdown(scopeObj),
      ViewershipSnapshotModel.getChannelLeaderboard(scopeObj),
    ]);

    res.json({
      scope: scopeObj,
      peakCCV: peakCCV
        ? { timestamp: peakCCV.timestamp, totalCCV: parseInt(peakCCV.total_ccv, 10) }
        : null,
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
        displayName: e.display_name,
        platform: e.platform,
        tier: e.tier ?? 'community',
        peakCCV: parseInt(e.peak_ccv, 10),
        avgCCV: parseFloat(e.avg_ccv),
        totalViewedMinutes: parseInt(e.total_viewed_minutes, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/public/:shortName/timeseries ───────────────────────────────

router.get('/:shortName/timeseries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const scopeObj = parseScope(req.query as Record<string, unknown>, series.id);
    if (!scopeObj) {
      res.status(400).json({ error: 'Invalid scope or id' });
      return;
    }

    const interval = parseInt(req.query.interval as string, 10) || 60;
    if (![60, 300, 600].includes(interval)) {
      res.status(400).json({ error: 'interval must be one of: 60, 300, 600 (seconds)' });
      return;
    }

    const groupBy = (req.query.groupBy as string) || 'total';
    if (!['total', 'platform', 'language', 'region', 'channel'].includes(groupBy)) {
      res.status(400).json({ error: 'groupBy must be one of: total, platform, language, region, channel' });
      return;
    }

    if (groupBy === 'total') {
      const buckets = await ViewershipSnapshotModel.getTimeSeriesData(scopeObj, interval);
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

    // Grouped time series
    const scopeColumn =
      scopeObj.level === 'day'
        ? 'broadcast_day_id'
        : scopeObj.level === 'stage'
          ? 'stage_id'
          : 'series_id';

    const groupColumn = groupBy === 'channel' ? 'channel_id' : groupBy;

    const rows: Array<{
      bucket: Date;
      group_key: string;
      total_ccv: string;
      channel_count: string;
    }> = await db
      .raw(
        `SELECT bucket, group_key,
           SUM(max_viewers)::text AS total_ccv,
           COUNT(*)::text AS channel_count
         FROM (
           SELECT
             date_trunc('minute', "timestamp")
               + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
               * interval '1 second' AS bucket,
             channel_id,
             "${groupColumn}" AS group_key,
             MAX(concurrent_viewers) AS max_viewers
           FROM viewership_snapshots
           WHERE "${scopeColumn}" = :id
           GROUP BY bucket, channel_id, group_key
         ) per_channel
         GROUP BY bucket, group_key
         ORDER BY bucket ASC, total_ccv DESC`,
        { interval, id: scopeObj.id },
      )
      .then(
        (r: {
          rows: Array<{
            bucket: Date;
            group_key: string;
            total_ccv: string;
            channel_count: string;
          }>;
        }) => r.rows,
      );

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

// ── GET /api/public/:shortName/leaderboard ──────────────────────────────

router.get('/:shortName/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const seriesId = series.id;
    const scopeParam = (req.query.scope as string) || 'day';
    const dayId = req.query.dayId as string | undefined;
    const stageId = req.query.stageId as string | undefined;

    let scopeObj: ViewershipSnapshotModel.Scope;

    if (scopeParam === 'series') {
      scopeObj = { level: 'series', id: seriesId };
    } else if (scopeParam === 'stage') {
      if (stageId && isValidUUID(stageId)) {
        scopeObj = { level: 'stage', id: stageId };
      } else {
        scopeObj = { level: 'series', id: seriesId };
      }
    } else {
      if (dayId && isValidUUID(dayId)) {
        scopeObj = { level: 'day', id: dayId };
      } else {
        const activeDay = await db('broadcast_days')
          .where('series_id', seriesId)
          .where('status', 'live')
          .orderBy('date', 'desc')
          .first();

        if (activeDay) {
          scopeObj = { level: 'day', id: activeDay.id };
        } else {
          const recentDay = await db('broadcast_days')
            .where('series_id', seriesId)
            .where('status', 'completed')
            .orderBy('date', 'desc')
            .first();

          scopeObj = recentDay
            ? { level: 'day', id: recentDay.id }
            : { level: 'series', id: seriesId };
        }
      }
    }

    const leaderboard = await ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 9999);

    res.json({
      scope: scopeObj,
      channels: leaderboard.map((e) => ({
        channelId: e.channel_id,
        displayName: e.display_name,
        platform: e.platform,
        tier: e.tier ?? 'community',
        peakCCV: parseInt(e.peak_ccv, 10),
        avgCCV: Math.round(parseFloat(e.avg_ccv)),
        viewedHours: Math.round(parseInt(e.total_viewed_minutes, 10) / 60),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/public/:shortName/reports/:filename — Serve HTML report ────

router.get(
  '/:shortName/reports/:filename',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const series = getPublicSeries(req);
      const filename = req.params.filename as string;

      // Only allow .html files publicly
      if (!filename || !filename.endsWith('.html')) {
        res.status(400).json({ error: 'Only HTML reports are publicly accessible' });
        return;
      }

      // Sanitize to prevent directory traversal
      if (filename.includes('..') || filename.includes('/')) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      const folder = series.short_name;
      if (!folder) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      const filePath = path.join(REPORTS_BASE_DIR, folder, filename);

      try {
        await stat(filePath);
      } catch {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
