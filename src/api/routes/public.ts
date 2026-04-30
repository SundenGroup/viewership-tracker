/**
 * Public API Routes — no authentication required
 *
 * All endpoints resolve the series by short_name and require is_public = true.
 * Mounted at /api/public BEFORE the global authenticate middleware.
 */

import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { stat, readFile } from 'fs/promises';
import { requirePublicSeries } from '../middleware/auth';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';
import * as TournamentSeriesModel from '../../models/tournament-series';
import db from '../../utils/db';

const router = Router();
const REPORTS_BASE_DIR = path.resolve(process.cwd(), 'reports');

/**
 * Map a legacy static-report filename back to the equivalent live URL in the
 * redesigned dashboard.
 *
 * Filename grammar (see src/agent/report-agent.ts:1319-1338):
 *   {scope}_{date|stage}{_<viewGroup>}{_<excludes>}.html
 *     scope = day | stage | series
 *     date  = YYYY-MM-DD
 *     stage = sanitised stage name
 *     viewGroup, excludes = optional filter suffixes (_west, _xc-N, _xt-..., _xl-...)
 *
 * Variants always link to the unfiltered redesign URL — the redesign URL
 * scheme doesn't carry these filters, so we drop them and let the user
 * re-apply filters in the UI if needed.
 */
function legacyReportToNewDesignUrl(shortName: string, filename: string): string {
  // Strip extension and known variant suffixes (_xt-…, _xl-…, _xc-…, _<viewGroup>)
  const stem = filename.replace(/\.html$/i, '');

  // Day report: day_2026-04-19[…]
  const dayMatch = stem.match(/^day_(\d{4}-\d{2}-\d{2})/);
  if (dayMatch) {
    return `/public/${shortName}/report/detailed/${dayMatch[1]}`;
  }

  // Series report: series_2026-04-19[…] → series-level redesign view
  if (/^series_/.test(stem)) {
    return `/public/${shortName}/report/detailed`;
  }

  // Stage report: stage_<sanitised>[…] → fall back to series-level since
  // mapping the sanitised stage name back to its `order` would need a DB lookup.
  if (/^stage_/.test(stem)) {
    return `/public/${shortName}/report/detailed`;
  }

  // Unknown shape — series fallback.
  return `/public/${shortName}/report/detailed`;
}

/**
 * Build the "View in redesigned dashboard" banner HTML that gets spliced into
 * each legacy static report. Theme-matched (dark, low-contrast accent) so it
 * doesn't fight the report's own styling.
 */
function buildRedesignBanner(newDesignUrl: string): string {
  return (
    `<a href="${newDesignUrl}" class="ct-redesign-banner" style="` +
    `display:block;` +
    `background:#1a1d2b;` +
    `color:#d4d6e0;` +
    `border-bottom:1px solid #2a2d3b;` +
    `padding:10px 24px;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
    `font-size:13px;` +
    `text-decoration:none;` +
    `text-align:center;` +
    `">View this report in the redesigned dashboard →</a>`
  );
}

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
  const idsParam = query.ids as string | undefined;

  if (!scope || scope === 'series') return { level: 'series', id: seriesId };

  if (scope === 'multi_stage') {
    if (!idsParam) return null;
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return null;
    if (!ids.every(isValidUUID)) return null;
    return { level: 'multi_stage', ids };
  }

  if (!id || !isValidUUID(id)) return null;
  if (!['day', 'stage'].includes(scope)) return null;
  return { level: scope as 'day' | 'stage', id };
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

// Apply requirePublicSeries to all routes under /:shortName
router.use('/:shortName', requirePublicSeries('shortName'));

// ── GET /api/public/:shortName — Series info + stages/broadcast days ────

router.get('/:shortName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const detail = await TournamentSeriesModel.findWithStages(series.id);

    // Extract view groups from metadata
    const viewGroups = (series.metadata as Record<string, unknown>)?.viewGroups ?? [];

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
      viewGroups,
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
    const scope = parseScope(req.query as Record<string, unknown>, series.id);
    const scopeArg = scope && scope.level !== 'series' ? scope : undefined;
    const filter = parseViewFilter(req.query as Record<string, unknown>);
    const snapshots = await ViewershipSnapshotModel.getLatestSnapshot(series.id, scopeArg, filter);

    // Deduplicate: take MAX(concurrent_viewers) per channel_id to handle
    // duplicate rows from the polling orchestrator (cross-series channels).
    const channelMax = new Map<string, number>();
    for (const s of snapshots) {
      channelMax.set(s.channel_id, Math.max(channelMax.get(s.channel_id) ?? 0, s.concurrent_viewers));
    }
    const totalCCV = [...channelMax.values()].reduce((sum, v) => sum + v, 0);
    const liveCount = [...channelMax.entries()].filter(([, v]) => v > 0).length;

    res.json({
      seriesId: series.id,
      timestamp: snapshots.length > 0 ? snapshots[0].timestamp : null,
      totalCCV,
      channelCount: channelMax.size,
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

// ── GET /api/public/:shortName/metrics ──────────────────────────────────

router.get('/:shortName/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = getPublicSeries(req);
    const scopeObj = parseScope(req.query as Record<string, unknown>, series.id);
    if (!scopeObj) {
      res.status(400).json({ error: 'Invalid scope or id' });
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

    // Grouped time series
    const needsJoin = groupBy === 'tier';
    const groupColumn = groupBy === 'channel' ? 'channel_id' : groupBy;
    const groupExpr = needsJoin ? 'c.tier' : `"${groupColumn}"`;
    const joinClause = needsJoin ? 'JOIN channels c ON c.id = vs.channel_id' : '';
    const vsPrefix = needsJoin ? 'vs.' : '';

    // Resolve scope WHERE fragment (single-target column = id, or multi_stage IN list).
    let scopeSql: string;
    let scopeBindings: Record<string, unknown>;
    const colPrefix = needsJoin ? 'vs.' : '';
    if (scopeObj.level === 'multi_stage') {
      scopeSql = `${colPrefix}"stage_id" = ANY(:scopeIds::uuid[])`;
      scopeBindings = { scopeIds: scopeObj.ids };
    } else {
      const scopeColumn =
        scopeObj.level === 'day'
          ? 'broadcast_day_id'
          : scopeObj.level === 'stage'
            ? 'stage_id'
            : 'series_id';
      scopeSql = `${colPrefix}"${scopeColumn}" = :scopeId`;
      scopeBindings = { scopeId: scopeObj.id };
    }

    const fClauses = filter ? ViewershipSnapshotModel.buildFilterClauses(filter) : { sql: '', bindings: {} };
    const fSql = needsJoin ? fClauses.sql.replace(/\b(language|platform|region)\b/g, 'vs.$1') : fClauses.sql;
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
             date_trunc('minute', ${vsPrefix}"timestamp")
               + (EXTRACT(epoch FROM ${vsPrefix}"timestamp" - date_trunc('minute', ${vsPrefix}"timestamp"))::int / :interval * :interval)
               * interval '1 second' AS bucket,
             ${vsPrefix}channel_id,
             ${groupExpr} AS group_key,
             MAX(${vsPrefix}concurrent_viewers) AS max_viewers
           FROM viewership_snapshots ${needsJoin ? 'vs' : ''}
           ${joinClause}
           WHERE ${scopeSql} ${fSql}
           GROUP BY bucket, ${vsPrefix}channel_id, group_key
         ) per_channel
         GROUP BY bucket, group_key
         ORDER BY bucket ASC, total_ccv DESC`,
        { interval, ...scopeBindings, ...fClauses.bindings },
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
    const idsParam = req.query.ids as string | undefined;

    let scopeObj: ViewershipSnapshotModel.Scope;

    if (scopeParam === 'series') {
      scopeObj = { level: 'series', id: seriesId };
    } else if (scopeParam === 'multi_stage') {
      const ids = (idsParam ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0 && ids.every(isValidUUID)) {
        scopeObj = { level: 'multi_stage', ids };
      } else {
        scopeObj = { level: 'series', id: seriesId };
      }
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

    const filter = parseViewFilter(req.query as Record<string, unknown>);
    const leaderboard = await ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 9999, filter);

    res.json({
      scope: scopeObj,
      channels: leaderboard.map((e) => ({
        channelId: e.channel_id,
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

      const rawFolder = series.short_name;
      if (!rawFolder) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // Normalize to match how report-agent saves files (lowercase, sanitized)
      const folder = rawFolder.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      const filePath = path.join(REPORTS_BASE_DIR, folder, filename);

      try {
        await stat(filePath);
      } catch {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // Read the static HTML and inject the "View in redesigned dashboard"
      // banner immediately after the first <div class="container"> opening
      // tag. This preserves the underlying file on disk (still a true
      // historical snapshot) while giving viewers a CTA to the live view.
      let html: string;
      try {
        html = await readFile(filePath, 'utf8');
      } catch {
        res.status(500).json({ error: 'Failed to read report' });
        return;
      }

      const newDesignUrl = legacyReportToNewDesignUrl(rawFolder, filename);
      const banner = buildRedesignBanner(newDesignUrl);
      // The report-builder template emits `<div class="container">` exactly once
      // as the outer wrapper. If for some reason the marker is missing (very old
      // report, unusual template), we fall through and serve the original file.
      const marker = '<div class="container">';
      const idx = html.indexOf(marker);
      const out =
        idx >= 0
          ? html.slice(0, idx + marker.length) + banner + html.slice(idx + marker.length)
          : html;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.send(out);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
