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
import { getPushNotifier } from '../../services/push-notifier';
import * as TikTokDiscoveredModel from '../../models/tiktok-discovered-stream';
import { TikTokIngestGuard } from '../../services/tiktok-ingest-guard';

/** One guard for the process — state must persist across pushes. */
const tiktokGuard = new TikTokIngestGuard();

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
import { normalizeRelayViewers, detectBleedIdentifiers, MAX_PLAUSIBLE_RELAY_CCV } from '../../utils/relay-values';
const cohostSuspects = new Map<string, number>(); // identifier(lower) -> expiry epoch ms

/** Returns true when this is a NEW suspect (not already active). */
function markCohostSuspect(identifier: string): boolean {
  const key = identifier.toLowerCase();
  const isNew = (cohostSuspects.get(key) ?? 0) <= Date.now();
  cohostSuspects.set(key, Date.now() + COHOST_SUSPECT_TTL_MS);
  return isNew;
}

// Tab-bleed detection: several channels reporting the IDENTICAL viewer
// count in one push is the scraper's wrong-tab signature. Throttled push.
let lastBleedPushAt = 0;

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

// ── Relay health (observability) ─────────────────────────────────────────
//
// In-memory counters exposed via GET /api/relay-health (JWT-auth'd router
// below, mounted separately in server.ts). "DB freshness ≠ relay healthy"
// — this makes the relay's actual push activity visible in the dashboard
// instead of requiring an SSH + log grep.
interface RelayPlatformStats {
  lastPushAt: string | null;
  lastMatched: number;
  lastWritten: number; // updated (twitch) / inserted+updated (tiktok)
  lastSuspected: number;
  totalPushes: number;
}
const relayStats: Record<'twitch' | 'tiktok', RelayPlatformStats> = {
  twitch: { lastPushAt: null, lastMatched: 0, lastWritten: 0, lastSuspected: 0, totalPushes: 0 },
  tiktok: { lastPushAt: null, lastMatched: 0, lastWritten: 0, lastSuspected: 0, totalPushes: 0 },
};

function recordRelayPush(
  platform: 'twitch' | 'tiktok',
  matched: number,
  written: number,
  suspected = 0,
): void {
  const s = relayStats[platform];
  s.lastPushAt = new Date().toISOString();
  s.lastMatched = matched;
  s.lastWritten = written;
  s.lastSuspected = suspected;
  s.totalPushes++;
}

/** JWT-authenticated health router — mounted at /api/relay-health. */
export const relayHealthRouter = Router();
relayHealthRouter.get('/', (_req: Request, res: Response) => {
  const now = Date.now();
  const withAge = (s: RelayPlatformStats) => ({
    ...s,
    secondsSincePush: s.lastPushAt
      ? Math.round((now - new Date(s.lastPushAt).getTime()) / 1000)
      : null,
  });
  res.json({
    twitch: withAge(relayStats.twitch),
    tiktok: withAge(relayStats.tiktok),
    cohostSuspects: activeCohostSuspects(),
  });
});

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

    let deferred = 0;
    let released = 0;
    const buildRows = (key: string, viewers: number, title: string | null, ts: Date) => {
      const matches = channelMap.get(key);
      if (!matches) return false;
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
            timestamp: ts,
            concurrent_viewers: viewers,
            platform: 'tiktok',
            language: ch.language,
            region: ch.region,
            stream_id: null,
            stream_title: title,
          });
        }
        matched++;
      }
      return true;
    };

    let invalid = 0;
    for (const input of channels) {
      const key = (input.identifier || '').toLowerCase().replace(/^@/, '');
      if (!channelMap.has(key)) continue;

      // Validate before anything touches the DB: a non-numeric / negative /
      // implausible value must not fail the whole batch (which would lose
      // every channel in this push).
      const viewers = normalizeRelayViewers(input.viewers);
      if (viewers === null) { invalid++; continue; }

      // Ingest guard: a sudden plunge (stale relay re-emit / disconnect
      // zero) is held one cycle for a second opinion — see the guard's
      // header for the exact semantics.
      const verdict = tiktokGuard.assess(key, viewers, timestamp);
      if (verdict.action === 'defer') {
        deferred++;
        continue;
      }
      if (verdict.release) {
        // Confirmed real decline: backfill the held reading at its
        // original timestamp so the record has no hole.
        buildRows(key, verdict.release.viewers, input.title ?? null, verdict.release.timestamp);
        released++;
      }
      buildRows(key, viewers, input.title ?? null, timestamp);
    }
    if (invalid > 0) logger.warn(`[Relay] TikTok: ${invalid} entr${invalid === 1 ? 'y' : 'ies'} with invalid viewer values skipped`);
    if (deferred > 0 || released > 0) {
      logger.info(`[Relay] TikTok guard: ${deferred} plunge(s) held, ${released} released as real`);
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
    recordRelayPush('tiktok', matched, snapshotsInserted + snapshotsUpdated);

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
    const newSuspects: string[] = [];

    // Tab-bleed signature: ≥3 channels pushing the IDENTICAL value (>100)
    // in one batch means the scraper read the same tab for all of them.
    // Those values are NOT written (Helix keeps its value for the minute);
    // previously the signature only raised an alert while the bled values
    // overwrote correct rows.
    const normalized = channels.map((input) => ({
      identifier: (input.identifier || '').toLowerCase(),
      viewers: normalizeRelayViewers(input.viewers),
    }));
    const bleedSet = detectBleedIdentifiers(normalized);
    const valueGroups = new Map<number, string[]>();
    for (const e of normalized) {
      if (e.viewers !== null && e.viewers > 100 && bleedSet.has(e.identifier)) {
        const list = valueGroups.get(e.viewers) ?? [];
        list.push(e.identifier);
        valueGroups.set(e.viewers, list);
      }
    }
    const bleedGroups = [...valueGroups.entries()];
    if (bleedGroups.length > 0 && Date.now() - lastBleedPushAt > 10 * 60_000) {
      lastBleedPushAt = Date.now();
      const desc = bleedGroups
        .map(([v, ids]) => `${ids.join(', ')} all @ ${v}`)
        .join(' | ');
      logger.warn(`[Relay] Twitch: tab-bleed signature — ${desc} (values skipped, Helix kept)`);
      getPushNotifier()
        .notify('data_anomaly', {
          title: 'Browser scraper tab-bleed suspected',
          body: `Identical viewer counts across channels: ${desc}`,
          tag: 'anomaly-tab-bleed',
        })
        .catch(() => {});
    }

    let bled = 0;
    for (const input of channels) {
      const identifier = (input.identifier || '').toLowerCase();
      const relayViewers = normalizeRelayViewers(input.viewers);
      if (relayViewers === null) {
        logger.warn(`[Relay] Twitch: ignoring invalid/implausible value for ${identifier}: ${String(input.viewers)}`);
        continue;
      }
      if (relayViewers <= 0) continue;
      if (bleedSet.has(identifier)) { bled++; continue; }

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
          if (markCohostSuspect(identifier)) {
            newSuspects.push(`${identifier} (${relayViewers} vs helix ${helixViewers})`);
          }
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
        (suspected > 0 ? `, ${suspected} cohost-suspect (kept Helix)` : '') +
        (bled > 0 ? `, ${bled} tab-bleed (kept Helix)` : ''),
    );
    if (newSuspects.length > 0) {
      getPushNotifier()
        .notify('data_anomaly', {
          title: 'Stream Together detected: overlay suppressed',
          body:
            `${newSuspects.join('; ')}. Helix values kept; the scraper switches ` +
            'these channels to the per-channel popover extractor automatically.',
          tag: 'anomaly-cohost-suspect',
        })
        .catch(() => {});
    }
    recordRelayPush('twitch', matched, updated, suspected);
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

// ── TikTok live-category discovery via residential relay ─────────────────
//
// TikTok's category feed (webcast.tiktok.com/webcast/feed/, the data
// behind tiktok.com/live/gaming/<Category>) rejects unsigned requests,
// and the signing runs only inside a real browser session. So the
// tracking machine's Chrome captures the feed and relays the rooms here
// (scripts/tiktok-category-discovery.ts); the TikTok adapter serves the
// fresh buffer to the discovery pipeline, where keywords/thresholds/
// blocklists apply exactly as for any other platform.

/**
 * GET /api/relay/tiktok/discover-config
 * Category pages the relay box should capture: every active game
 * tracker's tiktok_category_slug (so enabling TikTok on a tracker
 * starts capture automatically), plus any env extras
 * (TIKTOK_DISCOVER_CATEGORIES="slug|slug").
 */
router.get('/tiktok/discover-config', requireRelayToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db('game_trackers')
      .where('status', 'active')
      .whereNotNull('tiktok_category_slug')
      .pluck('tiktok_category_slug');
    const extra = (process.env.TIKTOK_DISCOVER_CATEGORIES ?? '')
      .split('|').map((s) => s.trim()).filter(Boolean);
    const categories = [...new Set([...rows, ...extra])];
    res.json({ categories, intervalSeconds: 300 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/relay/tiktok/discovered
 * Body: { category: "gaming/PUBG:_BATTLEGROUNDS",
 *         rooms: [{ username, nickname?, roomId?, title?, viewerCount, language? }] }
 */
router.post('/tiktok/discovered', requireRelayToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
    const roomsIn = req.body?.rooms;
    if (!category || !Array.isArray(roomsIn)) {
      res.status(400).json({ error: 'category and rooms[] required' });
      return;
    }
    const rooms = (roomsIn as Array<Record<string, unknown>>)
      .map((r) => ({
        username: typeof r.username === 'string' ? r.username.trim() : '',
        nickname: typeof r.nickname === 'string' && r.nickname ? r.nickname : null,
        roomId: typeof r.roomId === 'string' && r.roomId ? r.roomId : null,
        title: typeof r.title === 'string' && r.title ? r.title : null,
        viewerCount: Number.isFinite(Number(r.viewerCount)) ? Math.max(0, Math.round(Number(r.viewerCount))) : 0,
        language: typeof r.language === 'string' && r.language ? r.language : null,
      }))
      .filter((r) => /^[a-z0-9_.]{2,64}$/i.test(r.username.replace(/^@/, '')));

    const stored = await TikTokDiscoveredModel.upsertBatch(category, rooms);
    const swept = await TikTokDiscoveredModel.sweep();
    logger.info(
      `[Relay] TikTok discovery: ${stored} room(s) staged for ${category}` +
        (swept > 0 ? `, swept ${swept} stale` : ''),
    );
    res.json({ stored, swept });
  } catch (err) {
    next(err);
  }
});

// ── Kick chatroom-id resolution via residential relay ────────────────────
//
// Kick's unofficial API (the only source of chatroom ids, which the chat
// collector needs for Pusher subscriptions) hard-403s datacenter IPs, and
// the official OAuth API doesn't expose chatroom ids at all. Chatroom ids
// are STATIC per channel, so the residential relay box resolves each one
// exactly once and pushes it here; the collector picks cached ids up on
// its next selection cycle automatically.

/**
 * GET /api/relay/kick/chatroom-pending
 * Kick channels attached to active game trackers, seen live in the last
 * 7 days, still missing metadata.kick_chatroom_id. Limit 50 per call.
 */
router.get('/kick/chatroom-pending', requireRelayToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Ordered by recent peak so the channels whose chat the collector will
    // actually subscribe to resolve first — the 5-viewer long tail waits.
    const rows = await db.raw<{ rows: Array<{ slug: string }> }>(
      `
      SELECT LOWER(c.channel_identifier) AS slug, MAX(s.concurrent_viewers) AS recent_peak
      FROM channels c
      JOIN game_tracker_snapshots s ON s.channel_id = c.id
        AND s.timestamp > now() - interval '7 days'
      JOIN game_trackers t ON t.id = s.game_tracker_id AND t.status = 'active'
      WHERE c.platform = 'kick'
        AND (c.metadata->>'kick_chatroom_id') IS NULL
      GROUP BY LOWER(c.channel_identifier)
      ORDER BY MAX(s.concurrent_viewers) DESC
      LIMIT 50
      `,
    );
    res.json({ slugs: rows.rows.map((r) => r.slug) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/relay/kick/chatroom-ids
 * Body: { ids: [{ slug, chatroomId }] } — caches each id on EVERY kick
 * channel row sharing that slug (cross-series duplicates included).
 */
router.post('/kick/chatroom-ids', requireRelayToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = (req.body?.ids ?? []) as Array<{ slug?: string; chatroomId?: number }>;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' });
      return;
    }
    let updated = 0;
    for (const entry of ids.slice(0, 100)) {
      const slug = (entry.slug ?? '').toLowerCase().trim();
      const chatroomId = Number(entry.chatroomId);
      if (!/^[a-z0-9_-]+$/.test(slug) || !Number.isInteger(chatroomId) || chatroomId <= 0) continue;
      const result = await db.raw(
        `
        UPDATE channels
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('kick_chatroom_id', ?::int)
        WHERE platform = 'kick' AND LOWER(channel_identifier) = ?
        `,
        [chatroomId, slug],
      );
      updated += (result as { rowCount?: number }).rowCount ?? 0;
    }
    logger.info(`[Relay] Kick chatroom ids: cached ${ids.length} slug(s) onto ${updated} channel row(s)`);
    res.json({ received: ids.length, updatedRows: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
