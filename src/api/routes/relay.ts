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
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import db from '../../utils/db';
import logger from '../../utils/logger';

const router = Router();

// Per-IP rate limit on relay endpoints. Legitimate relays hit each route at
// most every 30 s, so 120/min leaves comfortable headroom for retries and
// occasional bursts while a leaked RELAY_SECRET can't be used to flood the
// DB. Applied to every route in this router via `router.use` below.
const relayLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many relay requests, slow down.' },
});
router.use(relayLimiter);

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

// ── Cohost (Stream Together) auto-detection ─────────────────────────────
//
// When a channel co-streams, the browser scraper's page badge shows the
// COMBINED total across all participants, while the orchestrator's Helix
// value (the row the relay is about to overwrite) is the channel's own,
// correct slice. Historically this had to be prevented by hand-listing
// channels in COHOST_CHANNELS on the scraper PC — every miss wrote days
// of inflated data (qqdoya/ko0416, assentw, krapycoco, the GeoGuessr
// watch parties...).
//
// The guard below makes detection automatic: a relay value wildly above
// the Helix slice it would replace is refused (Helix stands) and the
// channel is flagged as a cohost suspect for a TTL. The browser-channels
// endpoint returns the suspect list, and the scraper switches those
// channels to its Shared-Viewership popover extractor (exact per-channel
// slice) on its next channel-list refresh. Manual override remains via
// channels.metadata.is_cohosted or the scraper's COHOST_CHANNELS env.
//
// Threshold note: 2x + absolute slack. A real raid can spike a channel
// fast, but Helix catches up within its 3–5 min step — worst case we
// suppress the browser overlay for a couple of minutes on a legit spike,
// vs. writing hours of combined-badge inflation. Every inflation case
// we've repaired was 2–10x the slice.
const COHOST_SUSPECT_TTL_MS = 30 * 60_000;
const MAX_PLAUSIBLE_RELAY_CCV = 500_000;
const cohostSuspects = new Map<string, number>(); // identifier(lower) -> expiry epoch ms

function markCohostSuspect(identifier: string): void {
  cohostSuspects.set(identifier.toLowerCase(), Date.now() + COHOST_SUSPECT_TTL_MS);
}

function activeCohostSuspects(): string[] {
  const now = Date.now();
  for (const [k, exp] of cohostSuspects) {
    if (exp <= now) cohostSuspects.delete(k);
  }
  return [...cohostSuspects.keys()];
}

function looksLikeCombinedBadge(relayViewers: number, helixViewers: number): boolean {
  return relayViewers > Math.max(helixViewers * 2, helixViewers + 500);
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

    // Insert or update snapshots — one per channel per minute.
    // If a row already exists for this minute, update it ONLY if the new value is higher.
    // This allows multiple TikTok relays (scraper + WS tracker) to both contribute,
    // with the highest viewer count winning.
    let snapshotsInserted = 0;
    let snapshotsUpdated = 0;
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
        } else if ((row.concurrent_viewers as number) > existsInMinute.concurrent_viewers) {
          // New value is higher — update existing row
          await db('viewership_snapshots')
            .where('id', existsInMinute.id)
            .update({ concurrent_viewers: row.concurrent_viewers });
          snapshotsUpdated++;
        }
      }
    }

    logger.info(`[Relay] TikTok: ${matched} matched, ${snapshotsInserted} inserted, ${snapshotsUpdated} updated (higher)`);

    // Trigger WebSocket broadcast so dashboard gets updated TikTok numbers
    if ((snapshotsInserted > 0 || snapshotsUpdated > 0) && relayBroadcast) {
      const affectedSeriesIds = [...new Set(insertRows.map((r) => r.series_id as string))];
      try {
        relayBroadcast(affectedSeriesIds);
      } catch (err) {
        logger.debug('[Relay] TikTok broadcast callback failed', { error: (err as Error).message });
      }
    }

    res.json({ matched, snapshotsInserted, snapshotsUpdated });
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
    let suspected = 0;

    for (const input of channels) {
      const identifier = (input.identifier || '').toLowerCase();
      const relayViewers = input.viewers ?? 0;
      if (relayViewers <= 0) continue;
      if (relayViewers > MAX_PLAUSIBLE_RELAY_CCV) {
        logger.warn(
          `[Relay] Twitch: ignoring implausible value for ${identifier}: ${relayViewers}`,
        );
        continue;
      }

      // Find all snapshots for this channel at the most recent poll timestamp
      const rows = await db('viewership_snapshots as vs')
        .join('channels as c', 'c.id', 'vs.channel_id')
        .whereRaw('LOWER(c.channel_identifier) = ?', [identifier])
        .where('c.platform', 'twitch')
        .where('vs.timestamp', pollTimestamp)
        .select('vs.id', 'vs.concurrent_viewers');

      if (rows.length === 0) continue;
      matched++;

      // Browser scraper data is real per-minute — more accurate than the API's
      // 3-5 minute stepped cache. Always use the scraper value (replace, not max)
      // — UNLESS it looks like a Stream Together combined badge (far above the
      // Helix slice it would replace). Then keep Helix and flag the channel so
      // the scraper switches it to the per-channel popover extractor.
      for (const row of rows) {
        const helixViewers = Number(row.concurrent_viewers) || 0;
        if (looksLikeCombinedBadge(relayViewers, helixViewers)) {
          markCohostSuspect(identifier);
          suspected++;
          logger.warn(
            `[Relay] Twitch: ${identifier} relay=${relayViewers} vs helix=${helixViewers} — combined-badge suspect, keeping Helix value`,
          );
          continue;
        }
        if (relayViewers !== row.concurrent_viewers) {
          await db('viewership_snapshots')
            .where('id', row.id)
            .update({ concurrent_viewers: relayViewers });
          updated++;
        }
      }
    }

    logger.info(
      `[Relay] Twitch: ${matched} matched, ${updated} replaced with browser data` +
        (suspected > 0 ? `, ${suspected} cohost-suspect (kept Helix)` : ''),
    );
    res.json({ matched, updated, suspected });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/relay/twitch/debug?label=xxx
 *
 * Diagnostic sink — accepts an arbitrary JSON body from a relay machine
 * and writes it to /tmp/cvt-debug/<label>.json so it can be inspected
 * server-side (e.g. live cohost DOM captures pushed from the PC scraper,
 * which can't be read directly). Token-gated; overwrites the previous
 * capture for that label.
 */
router.post('/twitch/debug', requireRelayToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawLabel = (req.query.label ?? 'capture').toString();
    const label = rawLabel.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'capture';
    const dir = '/tmp/cvt-debug';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), body: req.body }, null, 2));
    logger.info(`[Relay] debug capture saved → ${file}`);
    res.json({ ok: true, file });
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
 * GET /api/relay/twitch/browser-channels
 *
 * Returns the top Twitch channels for browser-based scraping.
 * Officials first, then top channels by historical avg CCV.
 *
 * Capped at BROWSER_CHANNELS_LIMIT (default 20). Raise it via the env
 * var on a higher-capacity relay host (e.g. the dedicated PC) to track
 * more channels; keep it low for a thermally-constrained box (2019 MBP).
 */
router.get('/twitch/browser-channels', requireRelayToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.max(
      1,
      parseInt(process.env.BROWSER_CHANNELS_LIMIT || '20', 10) || 20,
    );

    // Get all active Twitch channels from series with live broadcast days.
    //
    // Day-aware: a channel with NO channel_broadcast_days rows is
    // series-wide (tracked every day its series is live); a channel WITH
    // day-tags is tracked ONLY on its tagged days. Mirrors the orchestrator
    // convention. Without this filter the scraper opens a Chrome tab for
    // every official / top-CCV channel in a live series even when that
    // channel isn't scheduled to broadcast today.
    const activeChannels = await db('channels as c')
      .join('broadcast_days as bd', function () {
        this.on('bd.series_id', 'c.series_id').andOn('bd.status', db.raw("'live'"));
      })
      .where('c.platform', 'twitch')
      .where('c.is_active', true)
      .where(function () {
        this.whereNotExists(
          db('channel_broadcast_days as cbd').whereRaw('cbd.channel_id = c.id'),
        ).orWhereExists(
          db('channel_broadcast_days as cbd2')
            .join('broadcast_days as bd2', 'bd2.id', 'cbd2.broadcast_day_id')
            .whereRaw('cbd2.channel_id = c.id')
            .where('bd2.status', 'live'),
        );
      })
      .distinct('c.channel_identifier', 'c.tier')
      .select('c.channel_identifier', 'c.tier');

    // Split into officials and others
    const officials = activeChannels.filter((c: { tier: string }) => c.tier === 'official');
    const others = activeChannels.filter((c: { tier: string }) => c.tier !== 'official');

    // For non-officials, get avg CCV to rank them
    const channelIds = others.map((c: { channel_identifier: string }) => c.channel_identifier);
    let ranked: Array<{ channel_identifier: string }> = [];

    if (channelIds.length > 0) {
      ranked = await db('viewership_snapshots as vs')
        .join('channels as c', 'c.id', 'vs.channel_id')
        .where('c.platform', 'twitch')
        .whereIn('c.channel_identifier', channelIds)
        .where('vs.concurrent_viewers', '>', 0)
        .groupBy('c.channel_identifier')
        .orderByRaw('AVG(vs.concurrent_viewers) DESC')
        .limit(Math.max(0, limit - officials.length))
        .select('c.channel_identifier');
    }

    const result = [
      ...officials.map((c: { channel_identifier: string }) => c.channel_identifier),
      ...ranked.map((c) => c.channel_identifier),
    ].slice(0, limit);

    // Channels the scraper must treat as cohost (Stream Together): manual
    // flags on the channel row (metadata.is_cohosted) + relay auto-detected
    // suspects. For these the scraper reads the per-channel slice from the
    // Shared Viewership popover (or abstains to Helix) — never the combined
    // page badge.
    const flagged = await db('channels as c')
      .join('broadcast_days as bd', function () {
        this.on('bd.series_id', 'c.series_id').andOn('bd.status', db.raw("'live'"));
      })
      .where('c.platform', 'twitch')
      .where('c.is_active', true)
      .whereRaw("(c.metadata->>'is_cohosted')::boolean IS TRUE")
      .distinct('c.channel_identifier')
      .pluck('c.channel_identifier');
    const cohost = [
      ...new Set([
        ...flagged.map((s: string) => s.toLowerCase()),
        ...activeCohostSuspects(),
      ]),
    ];

    res.json({ channels: result, cohost });
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
