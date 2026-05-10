import { Router, Request, Response, NextFunction } from 'express';
import * as TournamentSeriesModel from '../../models/tournament-series';
import { requireRole, hasMinRole, type UserRole } from '../middleware/auth';
import { AdapterRegistry } from '../../adapters';
import { TwitchAdapter } from '../../adapters/twitch';
import { KickAdapter } from '../../adapters/kick';
import { getDiscoveryService } from './polling';
import logger from '../../utils/logger';

const router = Router();

// GET /api/series — List all series (optional ?status=active)
// Viewers+ can access, but results are filtered by min_role
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    const filters: Partial<Pick<TournamentSeriesModel.TournamentSeries, 'status'>> = {};
    if (status && ['draft', 'active', 'completed'].includes(status as string)) {
      filters.status = status as TournamentSeriesModel.TournamentStatus;
    }
    const allSeries = await TournamentSeriesModel.findAll(filters);
    // Filter by min_role visibility
    const userRole = (req.user?.role ?? 'viewer') as UserRole;
    const visible = userRole === 'admin'
      ? allSeries
      : allSeries.filter((s) => hasMinRole(userRole, ((s as unknown as Record<string, unknown>).min_role as UserRole) ?? 'viewer'));
    // Hide game-tracker stub series — they only exist to satisfy
    // channels.series_id NOT NULL for game-tracker-managed channels and
    // are an internal implementation detail of the Discover surface.
    const series = visible.filter(
      (s) => (s.metadata as Record<string, unknown>)?.is_game_tracker_stub !== true,
    );
    res.json(series);
  } catch (err) {
    next(err);
  }
});

// POST /api/series — Create a new series (admin only)
router.post('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }
    const series = await TournamentSeriesModel.create(req.body);
    res.status(201).json(series);
  } catch (err) {
    next(err);
  }
});

// GET /api/series/games/lookup?name=PUBG — Search game/category names across platforms
// Returns arrays of matches so users can pick the correct one from similar names
// (e.g. "Counter-Strike: Source" vs "Counter-Strike 2")
// Must be before /:id to avoid "games" being captured as a series ID
router.get('/games/lookup', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const gameName = req.query.name as string;
    if (!gameName || typeof gameName !== 'string' || gameName.trim().length === 0) {
      res.status(400).json({ error: 'name query parameter is required' });
      return;
    }

    const name = gameName.trim();
    const results: Record<string, Array<{ id: string; name: string }>> = {
      twitch: [],
      kick: [],
    };

    // Search Twitch and Kick in parallel — return ALL matches
    const [twitchResult, kickResult] = await Promise.allSettled([
      (async () => {
        try {
          const registry = new AdapterRegistry();
          const adapter = registry.getAdapter('twitch') as TwitchAdapter;
          return await adapter.searchGames(name);
        } catch (err) {
          logger.warn(`Game lookup: Twitch search failed for "${name}"`, { error: (err as Error).message });
          return [];
        }
      })(),
      (async () => {
        try {
          const registry = new AdapterRegistry();
          const adapter = registry.getAdapter('kick') as KickAdapter;
          const cats = await adapter.searchCategories(name);
          return cats.map((c) => ({ id: String(c.id), name: c.name }));
        } catch (err) {
          logger.warn(`Game lookup: Kick search failed for "${name}"`, { error: (err as Error).message });
          return [];
        }
      })(),
    ]);

    if (twitchResult.status === 'fulfilled') {
      results.twitch = twitchResult.value;
    }
    if (kickResult.status === 'fulfilled') {
      results.kick = kickResult.value;
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/series/:id — Get series with nested stages + broadcast days
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await TournamentSeriesModel.findWithStages(req.params.id as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    res.json(series);
  } catch (err) {
    next(err);
  }
});

// PUT /api/series/:id — Update a series (editor+)
router.put('/:id', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const existing = await TournamentSeriesModel.findById(id);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated = await TournamentSeriesModel.update(id, req.body);

    // If the discovery cadence changed and discovery is currently running for
    // this series, restart so the new interval takes effect immediately.
    // Without this the existing setInterval keeps firing at the old cadence
    // until the next pm2 restart.
    if (existing.discovery_interval_ms !== updated.discovery_interval_ms) {
      const svc = getDiscoveryService();
      if (svc?.isRunning(id)) {
        svc.stopDiscovery(id);
        await svc.startDiscovery(id);
        logger.info(
          `[Series] Restarted discovery for ${id} after discovery_interval_ms ` +
          `changed (${existing.discovery_interval_ms} → ${updated.discovery_interval_ms})`,
        );
      }
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/series/:id — Delete a series (admin only)
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await TournamentSeriesModel.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PUT /api/series/:id/status — Update series status (admin only)
router.put('/:id/status', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    if (!status || !['draft', 'active', 'completed'].includes(status)) {
      res.status(400).json({ error: 'status must be one of: draft, active, completed' });
      return;
    }
    const existing = await TournamentSeriesModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated = await TournamentSeriesModel.updateStatus(req.params.id as string, status);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
