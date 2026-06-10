import { Router, Request, Response, NextFunction } from 'express';
import * as GameTrackerModel from '../../models/game-tracker';
import * as GameTrackerChannelModel from '../../models/game-tracker-channel';
import * as GameTrackerSnapshotModel from '../../models/game-tracker-snapshot';
import * as ChannelModel from '../../models/channel';
import { requireRole } from '../middleware/auth';
import type { GameTrackerService } from '../../services/game-tracker-service';
import logger from '../../utils/logger';

const router = Router();

// The orchestrating service is injected from src/index.ts at startup.
let trackerService: GameTrackerService | null = null;
export function setGameTrackerService(svc: GameTrackerService): void {
  trackerService = svc;
}

// ── Public list / detail (any authenticated user) ────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackers = await GameTrackerModel.findAll();
    res.json(trackers);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const activeCount = await GameTrackerChannelModel.countActive(tracker.id);
    const lastResult = trackerService?.getLastResult(tracker.id) ?? null;
    res.json({ ...tracker, active_channel_count: activeCount, last_cycle: lastResult });
  } catch (err) {
    next(err);
  }
});

// ── Admin CRUD ─────────────────────────────────────────────────────────

router.post('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug || typeof name !== 'string' || typeof slug !== 'string') {
      res.status(400).json({ error: 'name and slug are required' });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'slug must be lowercase alphanumeric + hyphens only' });
      return;
    }
    if (!req.body.twitch_game_id && !req.body.kick_category_id) {
      res.status(400).json({ error: 'at least one of twitch_game_id or kick_category_id is required' });
      return;
    }
    const tracker = await GameTrackerModel.create(req.body);
    if (tracker.status === 'active') {
      trackerService?.startTracker(tracker.id).catch((err: Error) =>
        logger.warn(`[GameTracker] failed to start tracker ${tracker.id} after create`, {
          error: err.message,
        }),
      );
    }
    res.status(201).json(tracker);
  } catch (err) {
    next(err);
  }
});

router.put('/:slug', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!existing) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const updated = await GameTrackerModel.update(existing.id, req.body);

    // Sync the running service with the new status.
    if (trackerService) {
      if (updated.status === 'active') {
        trackerService.startTracker(updated.id).catch(() => {});
      } else {
        trackerService.stopTracker(updated.id);
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:slug', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!existing) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    trackerService?.stopTracker(existing.id);
    await GameTrackerModel.remove(existing.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ── Channels for a tracker ─────────────────────────────────────────────

router.get('/:slug/channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const assignments = await GameTrackerChannelModel.listActive(tracker.id);
    if (assignments.length === 0) {
      res.json([]);
      return;
    }
    const channelIds = assignments.map((a) => a.channel_id);
    const channels = await ChannelModel.findByIds(channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    const merged = assignments.map((a) => ({
      ...a,
      channel: channelMap.get(a.channel_id) ?? null,
    }));
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

router.delete(
  '/:slug/channels/:channelId',
  requireRole('admin', 'editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const assignment = await GameTrackerChannelModel.findByTrackerAndChannel(
        tracker.id,
        req.params.channelId as string,
      );
      if (!assignment) {
        res.status(404).json({ error: 'Channel not assigned to this tracker' });
        return;
      }
      await GameTrackerChannelModel.softDrop(assignment.id, 'manual');
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── Trends + leaderboard ───────────────────────────────────────────────

router.get('/:slug/snapshots/range', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const bucketSeconds = req.query.bucketSeconds ? Number(req.query.bucketSeconds) : 60;

    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    if (toTs.getTime() <= fromTs.getTime()) {
      res.status(400).json({ error: 'to must be after from' });
      return;
    }

    const buckets = await GameTrackerSnapshotModel.rangeAggregate(tracker.id, fromTs, toTs, bucketSeconds);
    res.json({ from: fromTs, to: toTs, bucket_seconds: bucketSeconds, buckets });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 50;
    if (Number.isNaN(at.getTime())) {
      res.status(400).json({ error: 'at must be a valid ISO timestamp' });
      return;
    }
    const rows = await GameTrackerSnapshotModel.leaderboardAt(tracker.id, at, 120, limit);
    if (rows.length === 0) {
      res.json([]);
      return;
    }
    const channelIds = rows.map((r) => r.channel_id);
    const channels = await ChannelModel.findByIds(channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    const merged = rows.map((r) => ({
      ...r,
      channel: channelMap.get(r.channel_id) ?? null,
    }));
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/breakdown', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const [platform, language] = await Promise.all([
      GameTrackerSnapshotModel.platformBreakdown(tracker.id, fromTs, toTs),
      GameTrackerSnapshotModel.languageBreakdown(tracker.id, fromTs, toTs),
    ]);
    res.json({ from: fromTs, to: toTs, platform, language });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/channels/:channelId/timeline', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const channelId = req.params.channelId as string;
    const channel = await ChannelModel.findById(channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const fromTs = req.query.from
      ? new Date(String(req.query.from))
      : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const bucketSeconds = req.query.bucketSeconds ? Number(req.query.bucketSeconds) : 60;
    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    const [timeline, sessions] = await Promise.all([
      GameTrackerSnapshotModel.channelTimeline(tracker.id, channelId, fromTs, toTs, bucketSeconds),
      GameTrackerSnapshotModel.channelSessions(tracker.id, channelId, 30),
    ]);
    res.json({
      from: fromTs,
      to: toTs,
      bucket_seconds: bucketSeconds,
      channel,
      timeline,
      sessions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const q = (req.query.q as string | undefined)?.trim();
    if (!q || q.length < 2) {
      res.status(400).json({ error: 'q must be at least 2 characters' });
      return;
    }
    const days = req.query.days ? Math.min(Math.max(Number(req.query.days), 1), 90) : 30;
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 100) : 50;
    const rows = await GameTrackerSnapshotModel.searchTitlesAndChannels(tracker.id, q, days, limit);
    if (rows.length === 0) {
      res.json({ query: q, days, rows: [] });
      return;
    }
    const channels = await ChannelModel.findByIds(rows.map((r) => r.channel_id));
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    res.json({
      query: q,
      days,
      rows: rows.map((r) => ({ ...r, channel: channelMap.get(r.channel_id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/range-leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    const language = req.query.language ? String(req.query.language) : null;
    const platform = req.query.platform ? String(req.query.platform) : null;
    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    if (toTs.getTime() <= fromTs.getTime()) {
      res.status(400).json({ error: 'to must be after from' });
      return;
    }
    const [rows, total] = await Promise.all([
      GameTrackerSnapshotModel.rangeLeaderboard(tracker.id, fromTs, toTs, limit, {
        language,
        platform,
        offset,
      }),
      GameTrackerSnapshotModel.countRangeLeaderboard(tracker.id, fromTs, toTs, { language, platform }),
    ]);
    if (rows.length === 0) {
      res.json({ from: fromTs, to: toTs, total, rows: [] });
      return;
    }
    const channels = await ChannelModel.findByIds(rows.map((r) => r.channel_id));
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    res.json({
      from: fromTs,
      to: toTs,
      total,
      rows: rows.map((r) => ({ ...r, channel: channelMap.get(r.channel_id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
