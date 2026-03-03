import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';
import * as TournamentSeriesModel from '../../models/tournament-series';
import * as StageModel from '../../models/stage';
import * as BroadcastDayModel from '../../models/broadcast-day';
import * as ChannelModel from '../../models/channel';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';

const router = Router();

// GET /api/report-payload?scope={day|stage|multi_stage|series|custom}&id={uuid}&ids={csv}&startDate=&endDate=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scope, id, ids, startDate, endDate } = req.query;

    if (!scope) {
      res.status(400).json({ error: 'scope is required (day|stage|multi_stage|series|custom)' });
      return;
    }

    const validScopes = ['day', 'stage', 'multi_stage', 'series', 'custom'];
    if (!validScopes.includes(scope as string)) {
      res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
      return;
    }

    // ── Resolve scope to series, stages, and broadcast days ──────────

    let seriesId: string | undefined;
    let stageIds: string[] = [];
    let broadcastDayIds: string[] = [];

    switch (scope) {
      case 'series': {
        if (!id) {
          res.status(400).json({ error: 'id is required for scope=series' });
          return;
        }
        seriesId = id as string;
        const stages = await StageModel.findAll({ series_id: seriesId });
        stageIds = stages.map((s) => s.id);
        const days = await BroadcastDayModel.findAll({ series_id: seriesId });
        broadcastDayIds = days.map((d) => d.id);
        break;
      }

      case 'stage': {
        if (!id) {
          res.status(400).json({ error: 'id is required for scope=stage' });
          return;
        }
        const stage = await StageModel.findById(id as string);
        if (!stage) {
          res.status(404).json({ error: 'Stage not found' });
          return;
        }
        seriesId = stage.series_id;
        stageIds = [stage.id];
        const days = await BroadcastDayModel.findAll({ stage_id: stage.id });
        broadcastDayIds = days.map((d) => d.id);
        break;
      }

      case 'multi_stage': {
        if (!ids) {
          res.status(400).json({ error: 'ids is required for scope=multi_stage (comma-separated UUIDs)' });
          return;
        }
        stageIds = (ids as string).split(',').map((s) => s.trim());
        for (const sid of stageIds) {
          const stage = await StageModel.findById(sid);
          if (!stage) {
            res.status(404).json({ error: `Stage not found: ${sid}` });
            return;
          }
          if (!seriesId) seriesId = stage.series_id;
          const days = await BroadcastDayModel.findAll({ stage_id: sid });
          broadcastDayIds.push(...days.map((d) => d.id));
        }
        break;
      }

      case 'day': {
        if (!id) {
          res.status(400).json({ error: 'id is required for scope=day' });
          return;
        }
        const day = await BroadcastDayModel.findById(id as string);
        if (!day) {
          res.status(404).json({ error: 'Broadcast day not found' });
          return;
        }
        seriesId = day.series_id;
        stageIds = [day.stage_id];
        broadcastDayIds = [day.id];
        break;
      }

      case 'custom': {
        if (!id || !startDate || !endDate) {
          res.status(400).json({ error: 'id (series), startDate, and endDate are required for scope=custom' });
          return;
        }
        seriesId = id as string;
        const allDays = await BroadcastDayModel.findAll({ series_id: seriesId });
        broadcastDayIds = allDays
          .filter((d) => d.date >= (startDate as string) && d.date <= (endDate as string))
          .map((d) => d.id);
        stageIds = [...new Set(allDays.filter((d) => broadcastDayIds.includes(d.id)).map((d) => d.stage_id))];
        break;
      }
    }

    if (!seriesId) {
      res.status(400).json({ error: 'Could not determine series' });
      return;
    }

    // ── Fetch all data ──────────────────────────────────────────────

    const series = await TournamentSeriesModel.findById(seriesId);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    const stages = stageIds.length > 0
      ? await db('stages').whereIn('id', stageIds).orderBy('order', 'asc')
      : [];

    const broadcastDays = broadcastDayIds.length > 0
      ? await db('broadcast_days').whereIn('id', broadcastDayIds).orderBy('date', 'asc')
      : [];

    const channels = await ChannelModel.findAll({ series_id: seriesId, is_active: true });

    // ── Fetch snapshots for the resolved scope ──────────────────────

    let snapshotQuery = db('viewership_snapshots').where('series_id', seriesId);
    if (broadcastDayIds.length > 0 && scope !== 'series') {
      snapshotQuery = snapshotQuery.whereIn('broadcast_day_id', broadcastDayIds);
    }
    if (startDate) {
      snapshotQuery = snapshotQuery.where('timestamp', '>=', new Date(startDate as string));
    }
    if (endDate) {
      snapshotQuery = snapshotQuery.where('timestamp', '<=', new Date(endDate as string + 'T23:59:59.999Z'));
    }

    const snapshotCount = await snapshotQuery.clone().count('* as count').first();

    // ── Compute metrics for each broadcast day ──────────────────────

    const dayMetrics = await Promise.all(
      broadcastDayIds.map(async (dayId) => {
        const scopeObj: ViewershipSnapshotModel.Scope = { level: 'day', id: dayId };
        const [peak, avg, hours, platforms, languages, regions, leaderboard] = await Promise.all([
          ViewershipSnapshotModel.getPeakCCV(scopeObj),
          ViewershipSnapshotModel.getAverageCCV(scopeObj),
          ViewershipSnapshotModel.getTotalViewedHours(scopeObj),
          ViewershipSnapshotModel.getPlatformBreakdown(scopeObj),
          ViewershipSnapshotModel.getLanguageBreakdown(scopeObj),
          ViewershipSnapshotModel.getRegionBreakdown(scopeObj),
          ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 10),
        ]);
        return {
          broadcastDayId: dayId,
          peakCCV: peak ? parseInt(peak.total_ccv, 10) : 0,
          peakTimestamp: peak?.timestamp ?? null,
          avgCCV: parseFloat(avg),
          totalViewedHours: parseFloat(hours),
          platformBreakdown: platforms.map((b) => ({
            platform: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          languageBreakdown: languages.map((b) => ({
            language: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          regionBreakdown: regions.map((b) => ({
            region: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          channelLeaderboard: leaderboard.map((e) => ({
            channelId: e.channel_id,
            displayName: e.display_name,
            platform: e.platform,
            peakCCV: parseInt(e.peak_ccv, 10),
            avgCCV: parseFloat(e.avg_ccv),
          })),
        };
      }),
    );

    // ── Assemble payload ────────────────────────────────────────────

    res.json({
      generatedAt: new Date().toISOString(),
      scope,
      series: {
        id: series.id,
        name: series.name,
        shortName: series.short_name,
        game: series.game,
        partner: series.partner,
        status: series.status,
        timezone: series.timezone ?? 'UTC',
        startDate: series.start_date,
        endDate: series.end_date,
      },
      stages: stages.map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        status: s.status,
        startDate: s.start_date,
        endDate: s.end_date,
      })),
      broadcastDays: broadcastDays.map((d) => ({
        id: d.id,
        stageId: d.stage_id,
        label: d.label,
        date: d.date,
        broadcastStart: d.broadcast_start,
        broadcastEnd: d.broadcast_end,
        status: d.status,
      })),
      channels: channels.map((c) => ({
        id: c.id,
        platform: c.platform,
        channelIdentifier: c.channel_identifier,
        displayName: c.display_name,
        language: c.language,
        region: c.region,
        tier: c.tier,
        source: c.source,
      })),
      snapshotCount: parseInt((snapshotCount as { count: string })?.count ?? '0', 10),
      metrics: dayMetrics,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
