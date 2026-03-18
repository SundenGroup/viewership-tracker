/**
 * Relay endpoint for TikTok (and other) data pushed from external scrapers.
 *
 * External scrapers (e.g. running on a residential Mac to avoid data-center IP blocks)
 * POST snapshot data here. The endpoint writes directly into viewership_snapshots,
 * matching the same schema as the polling orchestrator.
 *
 * Auth: Bearer token via RELAY_SECRET env var.
 */
import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';
import logger from '../../utils/logger';

const router = Router();

// Simple bearer-token auth for relay endpoints
function requireRelayToken(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Relay not configured (RELAY_SECRET missing)' });
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Invalid relay token' });
    return;
  }

  next();
}

/**
 * POST /api/relay/tiktok
 *
 * Body: {
 *   channels: [
 *     { identifier: "@pubg.esports.official", viewers: 1200, title: "...", displayName: "..." }
 *   ]
 * }
 */
router.post('/tiktok', requireRelayToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      res.status(400).json({ error: 'channels array required' });
      return;
    }

    // Snap to the most recent bulk poll timestamp (within the last 2 minutes)
    // so relay data joins the same time bucket as the main poll cycle.
    const recentBulk = await db('viewership_snapshots')
      .where('timestamp', '>', db.raw("NOW() - INTERVAL '2 minutes'"))
      .groupBy('timestamp')
      .having(db.raw('COUNT(*) > 1'))
      .orderBy('timestamp', 'desc')
      .limit(1)
      .select('timestamp')
      .first();

    const timestamp = recentBulk ? new Date(recentBulk.timestamp) : new Date();
    const insertRows: Record<string, unknown>[] = [];
    let matched = 0;

    // Find all active TikTok channels across all series
    const dbChannels = await db('channels')
      .where('platform', 'tiktok')
      .where('is_active', true)
      .select('id', 'series_id', 'channel_identifier', 'language', 'region');

    // Build lookup map
    const channelMap = new Map<string, typeof dbChannels>();
    for (const ch of dbChannels) {
      const key = ch.channel_identifier.toLowerCase().replace(/^@/, '');
      const list = channelMap.get(key) ?? [];
      list.push(ch);
      channelMap.set(key, list);
    }

    // Find active broadcast days per series
    const seriesIds = [...new Set(dbChannels.map((c) => c.series_id))];
    const activeDays = await db('broadcast_days')
      .whereIn('series_id', seriesIds)
      .where('status', 'live')
      .select('id', 'series_id', 'stage_id');

    const seriesToDays = new Map<string, typeof activeDays>();
    for (const day of activeDays) {
      const list = seriesToDays.get(day.series_id) ?? [];
      list.push(day);
      seriesToDays.set(day.series_id, list);
    }

    // Build channel-to-day assignments
    const channelIds = dbChannels.map((c) => c.id);
    const channelDayAssignments = channelIds.length > 0
      ? await db('channel_broadcast_days').whereIn('channel_id', channelIds).select('channel_id', 'broadcast_day_id')
      : [];
    const channelDayMap = new Map<string, Set<string>>();
    for (const a of channelDayAssignments) {
      const set = channelDayMap.get(a.channel_id) ?? new Set();
      set.add(a.broadcast_day_id);
      channelDayMap.set(a.channel_id, set);
    }

    for (const input of channels) {
      const key = (input.identifier || '').toLowerCase().replace(/^@/, '');
      const matches = channelMap.get(key);
      if (!matches) continue;

      for (const ch of matches) {
        const days = seriesToDays.get(ch.series_id) ?? [];
        const assignedDays = channelDayMap.get(ch.id);

        for (const day of days) {
          if (assignedDays && assignedDays.size > 0 && !assignedDays.has(day.id)) continue;

          insertRows.push({
            channel_id: ch.id,
            broadcast_day_id: day.id,
            stage_id: day.stage_id,
            series_id: day.series_id,
            timestamp,
            concurrent_viewers: input.viewers ?? 0,
            platform: 'tiktok',
            language: ch.language,
            region: ch.region,
            stream_id: null,
            stream_title: input.title ?? null,
          });
        }
        matched++;
      }
    }

    // Insert snapshots
    if (insertRows.length > 0) {
      await db('viewership_snapshots').insert(insertRows);
    }

    logger.info(`[Relay] TikTok: ${matched} channels matched, ${insertRows.length} snapshots inserted`);
    res.json({ matched, snapshotsInserted: insertRows.length });
  } catch (err) {
    next(err);
  }
});

export default router;
