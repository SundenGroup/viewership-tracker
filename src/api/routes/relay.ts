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
import crypto from 'crypto';
import db from '../../utils/db';
import logger from '../../utils/logger';

const router = Router();

// Timing-safe bearer-token auth for relay endpoints
function requireRelayToken(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Relay not configured (RELAY_SECRET missing)' });
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Invalid relay token' });
    return;
  }

  const token = auth.slice(7);
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret);
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    res.status(401).json({ error: 'Invalid relay token' });
    return;
  }

  next();
}

// Optional callback to trigger WebSocket broadcast after TikTok relay data arrives
type RelayBroadcastFn = (seriesIds: string[]) => void;
let relayBroadcast: RelayBroadcastFn | null = null;

export function setRelayBroadcast(fn: RelayBroadcastFn): void {
  relayBroadcast = fn;
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

    // Insert snapshots — only one per channel per minute (prevents double-counting
    // when multiple relays push data that lands on different poll timestamps)
    let snapshotsInserted = 0;
    if (insertRows.length > 0) {
      for (const row of insertRows) {
        const existsInMinute = await db('viewership_snapshots')
          .where('channel_id', row.channel_id as string)
          .whereRaw("date_trunc('minute', \"timestamp\") = date_trunc('minute', ?::timestamptz)", [
            (row.timestamp as Date).toISOString(),
          ])
          .where('platform', 'tiktok')
          .first();
        if (!existsInMinute) {
          await db('viewership_snapshots').insert(row);
          snapshotsInserted++;
        }
      }
    }

    logger.info(`[Relay] TikTok: ${matched} channels matched, ${snapshotsInserted} snapshots inserted`);

    // Trigger WebSocket broadcast so dashboard gets updated TikTok numbers
    if (snapshotsInserted > 0 && relayBroadcast) {
      const affectedSeriesIds = [...new Set(insertRows.map((r) => r.series_id as string))];
      try {
        relayBroadcast(affectedSeriesIds);
      } catch (err) {
        logger.debug('[Relay] TikTok broadcast callback failed', { error: (err as Error).message });
      }
    }

    res.json({ matched, snapshotsInserted });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/relay/twitch
 *
 * Receives Twitch viewer counts from an external relay (e.g. US-based server)
 * and updates existing snapshots where the relay value is HIGHER than what
 * we already have. This captures step values our EU server might miss.
 *
 * Body: {
 *   platform: "twitch",
 *   channels: [
 *     { identifier: "pubg_battlegrounds", viewers: 5381 }
 *   ]
 * }
 */
router.post('/twitch', requireRelayToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      res.status(400).json({ error: 'channels array required' });
      return;
    }

    // Find the most recent bulk poll timestamp (within last 2 minutes)
    const recentBulk = await db('viewership_snapshots')
      .where('timestamp', '>', db.raw("NOW() - INTERVAL '2 minutes'"))
      .groupBy('timestamp')
      .having(db.raw('COUNT(*) > 1'))
      .orderBy('timestamp', 'desc')
      .limit(1)
      .select('timestamp')
      .first();

    if (!recentBulk) {
      res.json({ matched: 0, updated: 0, reason: 'no recent poll cycle found' });
      return;
    }

    const pollTimestamp = new Date(recentBulk.timestamp);
    let matched = 0;
    let updated = 0;

    for (const input of channels) {
      const identifier = (input.identifier || '').toLowerCase();
      const relayViewers = input.viewers ?? 0;
      if (relayViewers <= 0) continue;

      // Find all snapshots for this channel at the most recent poll timestamp
      const rows = await db('viewership_snapshots as vs')
        .join('channels as c', 'c.id', 'vs.channel_id')
        .whereRaw('LOWER(c.channel_identifier) = ?', [identifier])
        .where('c.platform', 'twitch')
        .where('vs.timestamp', pollTimestamp)
        .select('vs.id', 'vs.concurrent_viewers');

      if (rows.length === 0) continue;
      matched++;

      // Update rows where relay value is higher
      for (const row of rows) {
        if (relayViewers > row.concurrent_viewers) {
          await db('viewership_snapshots')
            .where('id', row.id)
            .update({ concurrent_viewers: relayViewers });
          updated++;
        }
      }
    }

    logger.info(`[Relay] Twitch: ${matched} channels matched, ${updated} snapshots updated (higher)`);
    res.json({ matched, updated });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/relay/twitch/channels
 *
 * Returns the list of active Twitch channel identifiers that the relay should poll.
 * Only returns channels from series with active (live) broadcast days.
 */
router.get('/twitch/channels', requireRelayToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const channels = await db('channels as c')
      .join('broadcast_days as bd', function () {
        this.on('bd.series_id', 'c.series_id').andOn('bd.status', db.raw("'live'"));
      })
      .where('c.platform', 'twitch')
      .where('c.is_active', true)
      .distinct('c.channel_identifier')
      .pluck('c.channel_identifier');

    res.json({ channels });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/relay/tiktok/channels
 *
 * Returns the list of active TikTok channel identifiers that the relay should track.
 * Only returns channels from series with active (live) broadcast days.
 */
router.get('/tiktok/channels', requireRelayToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const channels = await db('channels as c')
      .join('broadcast_days as bd', function () {
        this.on('bd.series_id', 'c.series_id').andOn('bd.status', db.raw("'live'"));
      })
      .where('c.platform', 'tiktok')
      .where('c.is_active', true)
      .distinct('c.channel_identifier', 'c.display_name')
      .select('c.channel_identifier', 'c.display_name');

    res.json({ channels });
  } catch (err) {
    next(err);
  }
});

export default router;
