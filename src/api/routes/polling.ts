import { Router, Request, Response, NextFunction } from 'express';
import { PollingOrchestrator } from '../../services/polling-orchestrator';
import { DiscoveryService } from '../../services/discovery-service';
import { requireRole } from '../middleware/auth';

// The orchestrator and discovery instances are injected via factory functions
let orchestrator: PollingOrchestrator | null = null;
let discoveryService: DiscoveryService | null = null;

export function setOrchestrator(orch: PollingOrchestrator): void {
  orchestrator = orch;
}

export function setDiscoveryService(svc: DiscoveryService): void {
  discoveryService = svc;
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

// GET /api/polling/status — Get orchestrator status
router.get('/status', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    res.json(orch.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/trigger — Manually trigger one poll cycle
router.post('/trigger', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    const result = await orch.executePollCycle();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/start — Start the polling orchestrator
router.post('/start', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orch = ensureOrchestrator(res);
    if (!orch) return;
    orch.start();
    res.json(orch.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/stop — Stop the polling orchestrator
router.post('/stop', (_req: Request, res: Response, next: NextFunction) => {
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
router.get('/youtube-quota', async (_req: Request, res: Response, next: NextFunction) => {
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

// GET /api/polling/discovery/status — Get discovery status
router.get('/discovery/status', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const svc = ensureDiscovery(res);
    if (!svc) return;
    res.json(svc.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/polling/discovery/trigger/:seriesId — Manually trigger one discovery cycle
router.post('/discovery/trigger/:seriesId', async (req: Request, res: Response, next: NextFunction) => {
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

// POST /api/polling/discovery/start/:seriesId — Start discovery for a series
router.post('/discovery/start/:seriesId', (_req: Request, res: Response, next: NextFunction) => {
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

// POST /api/polling/discovery/stop/:seriesId — Stop discovery for a series
router.post('/discovery/stop/:seriesId', (_req: Request, res: Response, next: NextFunction) => {
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

export default router;
