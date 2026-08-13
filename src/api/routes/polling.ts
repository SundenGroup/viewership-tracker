import { Router, Request, Response, NextFunction } from 'express';
import { PollingOrchestrator } from '../../services/polling-orchestrator';
import { DiscoveryService } from '../../services/discovery-service';
import { requireRole } from '../middleware/auth';
import db from '../../utils/db';

// The orchestrator and discovery instances are injected via factory functions
let orchestrator: PollingOrchestrator | null = null;
let discoveryService: DiscoveryService | null = null;

export function setOrchestrator(orch: PollingOrchestrator): void {
  orchestrator = orch;
}

export function setDiscoveryService(svc: DiscoveryService): void {
  discoveryService = svc;
}

/** Singleton accessor for code outside this module (e.g. the series PUT
 *  handler, which restarts discovery when `discovery_interval_ms` changes). */
export function getDiscoveryService(): DiscoveryService | null {
  return discoveryService;
}

const router = Router();

function ensureOrchestrator(res: Response): PollingOrchestrator | null {
  if (!orchestrator) {
    res.status(503).json({ error: 'Polling orchestrator not initialized' });
    return null;
  }
  return orchestrator;
}

function ensureDiscovery(res: Response): DiscoveryService | null {
  if (!discoveryService) {
    res.status(503).json({ error: 'Discovery service not initialized' });
    return null;
  }
  return discoveryService;
}

// ── Polling routes ────────────────────────────────────────────────────
//
// Roles are declared per route (the mount in server.ts adds none): the
// two status GETs are editor+ because the editor UI polls them for its
// indicators, the discovery-feed actions are editor+ by design, and
// every control that starts/stops/spends quota stays admin.

// GET /api/polling/status — Get orchestrator status (editor+)
router.get('/status', requireRole('admin', 'editor'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    res.json(orch.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/trigger — Manually trigger one poll cycle (admin only)
router.post('/trigger', requireRole('admin'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    const result = await orch.executePollCycle();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/start — Start the polling orchestrator (admin only)
router.post('/start', requireRole('admin'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    orch.start();
    res.json(orch.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/stop — Stop the polling orchestrator (admin only)
router.post('/stop', requireRole('admin'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    orch.stop();
    res.json(orch.getStatus());
  } catch (err) {
    next(err);
  }
});

// GET /api/polling/youtube-quota — Get YouTube API quota usage (admin only)
router.get('/youtube-quota', requireRole('admin'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    const polling = orch.getYouTubeQuota();
    const poolUsage = orch.getYouTubePoolQuota();

    // Join per-key usage with the keys table to build per-partner aggregates
    const keys = await import('../../models/youtube-api-key').then((m) => m.listKeys(false));
    const perKey = keys.map((k) => ({
      id: k.id,
      label: k.label,
      partner: k.partner,
      secret_preview: k.secret_preview,
      daily_quota: k.daily_quota,
      used: poolUsage[k.id] ?? 0,
    }));
    const byPartner: Record<string, { partner: string | null; used: number; limit: number; keys: number }> = {};
    for (const k of perKey) {
      const partnerKey = k.partner ?? '__shared__';
      const entry = byPartner[partnerKey] ?? { partner: k.partner, used: 0, limit: 0, keys: 0 };
      entry.used += k.used;
      entry.limit += k.daily_quota;
      entry.keys += 1;
      byPartner[partnerKey] = entry;
    }
    const aggregateUsed = perKey.reduce((sum, k) => sum + k.used, 0);
    const aggregateLimit = perKey.reduce((sum, k) => sum + k.daily_quota, 0);

    res.json({
      polling: {
        used: polling.used,
        limit: polling.limit,
        remaining: polling.limit - polling.used,
        percentage: polling.limit > 0 ? Math.round((polling.used / polling.limit) * 100) : 0,
      },
      discoveryPool: {
        used: aggregateUsed,
        limit: aggregateLimit,
        remaining: aggregateLimit - aggregateUsed,
        percentage: aggregateLimit > 0 ? Math.round((aggregateUsed / aggregateLimit) * 100) : 0,
      },
      byPartner: Object.values(byPartner),
      perKey,
      // Back-compat: keep the original flat shape for any caller still
      // expecting { used, limit, remaining, percentage }.
      used: polling.used,
      limit: polling.limit,
      remaining: polling.limit - polling.used,
      percentage: polling.limit > 0 ? Math.round((polling.used / polling.limit) * 100) : 0,
    });
  } catch (err) {
    next(err);
  }
});

// ── Discovery routes ──────────────────────────────────────────────────

// GET /api/polling/discovery/status — Get discovery status (editor+)
router.get('/discovery/status', requireRole('admin', 'editor'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    res.json(svc.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/trigger/:seriesId — Manually trigger one discovery cycle (admin only)
router.post('/discovery/trigger/:seriesId', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const seriesId = req.params.seriesId as string;
    const result = await svc.executeDiscoveryCycle(seriesId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/start/:seriesId — Start discovery for a series (admin only)
router.post('/discovery/start/:seriesId', requireRole('admin'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const seriesId = (_req as Request).params.seriesId as string;
    svc.startDiscovery(seriesId);
    // Clear user-stopped flag so orchestrator won't block auto-start
    if (orchestrator) orchestrator.markDiscoveryUserStarted(seriesId);
    res.json({ started: true, seriesId });
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/stop/:seriesId — Stop discovery for a series (admin only)
router.post('/discovery/stop/:seriesId', requireRole('admin'), (_req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const seriesId = (_req as Request).params.seriesId as string;
    svc.stopDiscovery(seriesId);
    // Mark as user-stopped so orchestrator won't auto-restart
    if (orchestrator) orchestrator.markDiscoveryUserStopped(seriesId);
    res.json({ stopped: true, seriesId });
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/block — Block a channel for a series (editor+)
router.post('/discovery/block', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const { seriesId, channelId } = req.body;
    if (!seriesId || !channelId) {
      res.status(400).json({ error: 'seriesId and channelId are required' });
      return;
    }
    await svc.blockChannel(seriesId, channelId);
    res.json({ blocked: true, seriesId, channelId });
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/unblock — Undo a block: blocklist removal +
// reactivation + live-day pin (editor+)
router.post('/discovery/unblock', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const { seriesId, channelId } = req.body;
    if (!seriesId || !channelId) {
      res.status(400).json({ error: 'seriesId and channelId are required' });
      return;
    }
    await svc.unblockChannel(seriesId, channelId);
    res.json({ unblocked: true, seriesId, channelId });
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/clear — Clear all unapproved discovered channels (editor+)
router.post('/discovery/clear', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const { seriesId } = req.body;
    if (!seriesId) {
      res.status(400).json({ error: 'seriesId is required' });
      return;
    }
    const count = await svc.purgeDiscoveredChannels(seriesId);
    res.json({ cleared: true, seriesId, count });
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/promote — Promote a channel to a new tier (editor+)
router.post('/discovery/promote', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    const { channelId, tier } = req.body;
    if (!channelId || !tier) {
      res.status(400).json({ error: 'channelId and tier are required' });
      return;
    }
    await svc.promoteChannel(channelId, tier);
    res.json({ promoted: true, channelId, tier });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/polling/roster-liveness
 *
 * Probe every day-pinned channel of the series' live broadcast day(s)
 * directly against the platform adapters and report channels that are
 * LIVE right now but NOT pinned to today ("extend-pin candidates"), plus
 * pinned-today channels that are offline.
 *
 * Why: the orchestrator DROPS snapshots for a pinned channel on days it
 * isn't pinned to, so cross-day liveness never reaches the DB — during
 * PNC2026 six GeoGuessr casters silently lost a day of data this way.
 * This is the API version of scripts/check-roster-liveness.ts --pinned.
 *
 * POST (not GET): it performs real platform polls (incl. YouTube quota),
 * so it is admin-only. Body: { seriesId?: string } — defaults to all
 * series with a live day.
 */
router.post('/roster-liveness', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    const { seriesId } = (req.body ?? {}) as { seriesId?: string };

    let dayQuery = db('broadcast_days').where('status', 'live').select('id', 'series_id', 'label');
    if (seriesId) dayQuery = dayQuery.where('series_id', seriesId);
    const liveDays = await dayQuery;
    if (liveDays.length === 0) {
      res.json({ liveDays: [], probed: 0, liveNotPinnedToday: [], pinnedTodayOffline: [] });
      return;
    }
    const liveDayIds = new Set(liveDays.map((d) => d.id as string));
    const seriesIds = [...new Set(liveDays.map((d) => d.series_id as string))];

    // Only channels that HAVE day-pins — the set that can be "pinned to
    // another day". Bounded (~200), safe to probe across all platforms.
    const channels = await db('channels as c')
      .whereIn('c.series_id', seriesIds)
      .where('c.is_active', true)
      .whereExists(db('channel_broadcast_days as cbd').whereRaw('cbd.channel_id = c.id'))
      .select('c.id', 'c.series_id', 'c.platform', 'c.channel_identifier', 'c.display_name');
    if (channels.length === 0) {
      res.json({ liveDays, probed: 0, liveNotPinnedToday: [], pinnedTodayOffline: [] });
      return;
    }

    const pins = await db('channel_broadcast_days')
      .whereIn('channel_id', channels.map((c) => c.id as string))
      .select('channel_id', 'broadcast_day_id');
    const pinMap = new Map<string, string[]>();
    for (const p of pins) {
      const list = pinMap.get(p.channel_id) ?? [];
      list.push(p.broadcast_day_id);
      pinMap.set(p.channel_id, list);
    }

    const snaps = await orch.getRegistry().getViewerCountsMultiPlatform(
      channels.map((c) => ({
        platform: c.platform as import('../../adapters').PlatformName,
        channelIdentifier: c.channel_identifier as string,
      })),
    );
    const snapMap = new Map<string, { isLive: boolean; viewers: number; title: string }>();
    for (const s of snaps) {
      snapMap.set(`${s.platform}:${s.channelIdentifier.toLowerCase()}`, {
        isLive: s.isLive,
        viewers: s.concurrentViewers,
        title: s.title ?? '',
      });
    }

    const rows = channels.map((c) => {
      const snap = snapMap.get(`${c.platform}:${(c.channel_identifier as string).toLowerCase()}`);
      const pinnedDayIds = pinMap.get(c.id as string) ?? [];
      return {
        channelId: c.id as string,
        seriesId: c.series_id as string,
        platform: c.platform as string,
        identifier: c.channel_identifier as string,
        displayName: c.display_name as string,
        live: snap?.isLive ?? false,
        viewers: snap?.viewers ?? 0,
        title: snap?.title ?? '',
        pinnedDayIds,
        pinnedToday: pinnedDayIds.some((d) => liveDayIds.has(d)),
      };
    });

    res.json({
      liveDays,
      probed: rows.length,
      liveNotPinnedToday: rows
        .filter((r) => r.live && !r.pinnedToday)
        .sort((a, b) => b.viewers - a.viewers),
      pinnedTodayOffline: rows.filter((r) => r.pinnedToday && !r.live),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
