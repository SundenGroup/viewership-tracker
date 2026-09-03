import type { Knex } from 'knex';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { normalizeLanguageCode } from '../utils/language';
import { keywordMatches } from '../utils/keyword-match';
import { soopStreamInCategory } from '../utils/soop-discovery-gate';
import type { AdapterRegistry, PlatformName } from '../adapters';
import type { DiscoveredStream } from '../adapters/types';
import type { TournamentSeries } from '../models/tournament-series';
import type { Channel, Platform } from '../models/channel';

// ── Result types ────────────────────────────────────────────────────────

export interface DiscoveryResult {
  seriesId: string;
  timestamp: Date;
  discovered: number;
  added: number;
  resurfaced: number;
  alreadyTracked: number;
  belowThreshold: number;
  blocked: number;
  errors: string[];
  duration: number;
}

export interface DiscoveryStatus {
  activeDiscoveries: string[];   // seriesIds with running intervals
  lastResults: Map<string, DiscoveryResult>;
}

// ── Callback types ──────────────────────────────────────────────────────

export type DiscoveryBroadcastFn = (result: DiscoveryResult) => void;

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_MIN_VIEWER_THRESHOLD = 5;
const PLATFORMS: PlatformName[] = ['twitch', 'youtube', 'kick', 'tiktok', 'steam', 'trovo', 'chzzk', 'soop'];

// ── DiscoveryService ────────────────────────────────────────────────────

export class DiscoveryService {
  private readonly registry: AdapterRegistry;
  private readonly db: Knex;
  private readonly minViewerThreshold: number;
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private lastResults = new Map<string, DiscoveryResult>();
  private discoveryBroadcast: DiscoveryBroadcastFn | null = null;

  constructor(
    registry: AdapterRegistry,
    db: Knex,
    minViewerThreshold: number = DEFAULT_MIN_VIEWER_THRESHOLD,
  ) {
    this.registry = registry;
    this.db = db;
    this.minViewerThreshold = minViewerThreshold;
  }

  /**
   * Attach a callback to broadcast discovery results via WebSocket
   * after each discovery cycle that finds new channels.
   */
  setDiscoveryBroadcast(fn: DiscoveryBroadcastFn): void {
    this.discoveryBroadcast = fn;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start a discovery interval for the given series.
   * Only runs while the series has at least one broadcast day with status 'live'.
   */
  async startDiscovery(seriesId: string): Promise<void> {
    if (this.intervals.has(seriesId)) {
      logger.debug(`[Discovery] Already running for series ${seriesId}`);
      return;
    }

    // Persist the operator's choice so a deploy/restart resumes it (boot
    // calls resumeFlagged). Discovery START stays user-initiated — this
    // flag only survives restarts, it never decides on its own.
    try {
      await this.db('tournament_series').where('id', seriesId).update({
        metadata: this.db.raw(`COALESCE(metadata,'{}'::jsonb) || '{"discovery_active": true}'::jsonb`),
      });
    } catch (err) {
      logger.warn(`[Discovery] could not persist discovery_active for ${seriesId}`, {
        error: (err as Error).message,
      });
    }

    // Read per-series interval, fall back to global config
    let intervalMs = config.polling.discoveryIntervalMs;
    try {
      const series = await this.db('tournament_series')
        .where('id', seriesId)
        .select('discovery_interval_ms')
        .first();
      if (series?.discovery_interval_ms) {
        intervalMs = series.discovery_interval_ms;
      }
    } catch {
      // Fall back to global config
    }

    logger.info(`[Discovery] Starting discovery for series ${seriesId} (interval: ${intervalMs / 1000}s)`);

    // Run the first cycle immediately
    this.runCycleIfLive(seriesId);

    // Schedule subsequent cycles
    const handle = setInterval(() => this.runCycleIfLive(seriesId), intervalMs);
    this.intervals.set(seriesId, handle);
  }

  /**
   * Whether discovery is currently running (has a setInterval handle) for
   * the given series. Used by the series-update path to decide whether to
   * restart on a `discovery_interval_ms` change.
   */
  isRunning(seriesId: string): boolean {
    return this.intervals.has(seriesId);
  }

  /**
   * Stop the discovery interval for the given series.
   */
  stopDiscovery(seriesId: string): void {
    const handle = this.intervals.get(seriesId);
    if (handle) {
      clearInterval(handle);
      this.intervals.delete(seriesId);
      logger.info(`[Discovery] Stopped discovery for series ${seriesId}`);
    }
    // Clear the resume flag regardless — an explicit stop (user or
    // series-complete) must not come back after the next restart.
    this.db('tournament_series').where('id', seriesId).update({
      metadata: this.db.raw(`COALESCE(metadata,'{}'::jsonb) || '{"discovery_active": false}'::jsonb`),
    }).catch((err: Error) => {
      logger.warn(`[Discovery] could not clear discovery_active for ${seriesId}`, { error: err.message });
    });
  }

  /**
   * Boot-time resume: restart discovery for every series the operator
   * left running (discovery_active flag) that still has a live
   * broadcast day. Restores state across deploys — pressing Start once
   * now survives restarts instead of dying with the process.
   */
  async resumeFlagged(): Promise<number> {
    const rows = await this.db('tournament_series as ts')
      .whereRaw(`ts.metadata->>'discovery_active' = 'true'`)
      .whereExists(function () {
        this.select(1).from('broadcast_days')
          .whereRaw('broadcast_days.series_id = ts.id')
          .where('status', 'live');
      })
      .select('ts.id', 'ts.name');
    for (const row of rows) {
      logger.info(`[Discovery] Resuming discovery for "${row.name}" (flagged active before restart)`);
      await this.startDiscovery(row.id as string);
    }
    return rows.length;
  }

  /**
   * Stop all discovery intervals.
   */
  stopAll(): void {
    for (const [seriesId, handle] of this.intervals) {
      clearInterval(handle);
      logger.info(`[Discovery] Stopped discovery for series ${seriesId}`);
    }
    this.intervals.clear();
  }

  /**
   * Get discovery status for all active series.
   */
  getStatus(): { activeDiscoveries: string[]; lastResults: Record<string, DiscoveryResult> } {
    const lastResultsObj: Record<string, DiscoveryResult> = {};
    for (const [key, val] of this.lastResults) {
      lastResultsObj[key] = val;
    }
    return {
      activeDiscoveries: Array.from(this.intervals.keys()),
      lastResults: lastResultsObj,
    };
  }

  // ── Internal: run cycle only if the series has a live broadcast day ──

  private async runCycleIfLive(seriesId: string): Promise<void> {
    try {
      // Check if the series still has at least one live broadcast day
      const liveDays = await this.db('broadcast_days')
        .where('series_id', seriesId)
        .where('status', 'live')
        .limit(1);

      if (liveDays.length === 0) {
        logger.debug(`[Discovery] No live broadcast days for series ${seriesId} — skipping cycle`);
        return;
      }

      const result = await this.executeDiscoveryCycle(seriesId);
      this.lastResults.set(seriesId, result);
    } catch (err) {
      logger.error(`[Discovery] Unhandled error in discovery cycle for series ${seriesId}`, {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  }

  // ── Core discovery cycle ──────────────────────────────────────────────

  async executeDiscoveryCycle(seriesId: string): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const timestamp = new Date();
    const errors: string[] = [];

    // 1. Load series to get discovery_keywords and discovery_game_ids
    const series = await this.db<TournamentSeries>('tournament_series')
      .where('id', seriesId)
      .first();

    if (!series) {
      logger.warn(`[Discovery] Series ${seriesId} not found`);
      return {
        seriesId,
        timestamp,
        discovered: 0,
        added: 0,
        resurfaced: 0,
        alreadyTracked: 0,
        belowThreshold: 0,
        blocked: 0,
        errors: [`Series ${seriesId} not found`],
        duration: Date.now() - startTime,
      };
    }

    const keywords = series.discovery_keywords ?? [];
    const gameIds = series.discovery_game_ids ?? {};

    if (keywords.length === 0 && Object.keys(gameIds).length === 0) {
      logger.debug(`[Discovery] Series ${series.name} has no discovery_keywords or discovery_game_ids — skipping`);
      return {
        seriesId,
        timestamp,
        discovered: 0,
        added: 0,
        resurfaced: 0,
        alreadyTracked: 0,
        belowThreshold: 0,
        blocked: 0,
        errors: [],
        duration: Date.now() - startTime,
      };
    }

    // 2. Load existing ACTIVE channels for this series (for dedup check).
    //
    // Day-aware: a channel only counts as "already tracked today" (and is thus
    // skipped by discovery) if it is all-days (no day tags) OR pinned to a
    // currently-live broadcast day. An active channel pinned ONLY to other days
    // (e.g. a PNC watch party confirmed for the final day) is "off-schedule
    // eligible" — if it shows up streaming today and the title matches the
    // discovery keywords, we extend it onto today's live day so it gets polled,
    // rather than leaving it skipped. Falls back to the original "all active =
    // tracked" behavior when no day is live.
    const liveDayIds: string[] = await this.db('broadcast_days')
      .where('series_id', seriesId)
      .where('status', 'live')
      .pluck('id');
    const liveDaySet = new Set<string>(liveDayIds);

    const activeChannels = await this.db<Channel>('channels')
      .where('series_id', seriesId)
      .where('is_active', true)
      .select('id', 'platform', 'channel_identifier');

    const activeTagRows = activeChannels.length
      ? await this.db('channel_broadcast_days')
          .whereIn('channel_id', activeChannels.map((c) => c.id))
          .select('channel_id', 'broadcast_day_id')
      : [];
    const tagsByChannel = new Map<string, string[]>();
    for (const t of activeTagRows) {
      const arr = tagsByChannel.get(t.channel_id) ?? [];
      arr.push(t.broadcast_day_id);
      tagsByChannel.set(t.channel_id, arr);
    }

    // TikTok identifiers exist in the DB both as '@name' and bare 'name';
    // strip the '@' when building comparison keys so the two forms can
    // never dodge dedup. Harmless for every other platform (no '@' ids).
    const normIdent = (identifier: string): string => identifier.toLowerCase().replace(/^@/, '');

    const trackedSet = new Set<string>();
    const trackedIds = new Map<string, string>(); // lookupKey -> channel id
    const refreshedThisCycle = new Set<string>();
    const offScheduleActive = new Map<string, string>(); // lookupKey -> channel id
    for (const ch of activeChannels) {
      const key = `${ch.platform}:${normIdent(ch.channel_identifier)}`;
      const tags = tagsByChannel.get(ch.id);
      const trackedToday = !tags || tags.length === 0 || tags.some((d) => liveDaySet.has(d));
      if (trackedToday || liveDaySet.size === 0) {
        trackedSet.add(key);
        trackedIds.set(key, ch.id);
      } else {
        offScheduleActive.set(key, ch.id);
      }
    }

    // Also load disabled channels that can be re-surfaced:
    // - auto-discovered channels (original flow)
    // - any channel with auto_paused flag (day-scoped channels after day completion)
    const disabledChannels = await this.db<Channel>('channels')
      .where('series_id', seriesId)
      .where('is_active', false)
      .where(function () {
        this.where('source', 'auto_discovered')
          .orWhereRaw("metadata->'auto_paused' = 'true'::jsonb");
      })
      .select('id', 'platform', 'channel_identifier', 'display_name', 'tier');

    const disabledMap = new Map<string, { id: string; tier: string }>();
    for (const ch of disabledChannels) {
      disabledMap.set(`${ch.platform}:${normIdent(ch.channel_identifier)}`, {
        id: ch.id,
        tier: (ch as unknown as { tier: string }).tier,
      });
    }

    // 3. Load blocklist from series metadata
    const blocklist = this.getBlocklist(series);
    const blockSet = new Set<string>(
      blocklist.map((b) => normIdent(b)),
    );

    // 4. Search each platform in parallel
    const platformSearches = PLATFORMS.map(async (platform): Promise<{
      platform: PlatformName;
      streams: DiscoveredStream[];
    }> => {
      try {
        const adapter = this.registry.getAdapter(platform);
        const gameId = gameIds[platform] ?? undefined;
        // Pass YouTube category IDs from series metadata (default: Gaming + Entertainment)
        const categoryIds = platform === 'youtube'
          ? ((series.metadata as Record<string, unknown>)?.youtube_categories as string[] | undefined)
          : undefined;
        const streams = await adapter.searchLiveStreams(
          gameId,
          keywords.length > 0 ? keywords : undefined,
          categoryIds,
          series.partner,
        );
        return { platform, streams };
      } catch (err) {
        const msg = `${platform} search failed: ${(err as Error).message}`;
        logger.warn(`[Discovery] ${msg}`);
        errors.push(msg);
        return { platform, streams: [] };
      }
    });

    const searchResults = await Promise.all(platformSearches);

    // 5. Process all discovered streams
    let discovered = 0;
    let added = 0;
    let resurfaced = 0;
    let alreadyTracked = 0;
    let belowThreshold = 0;
    let blocked = 0;
    let soopOffCategory = 0;

    // Helper: check if a stream title/channel name matches any discovery keyword.
    // Used to avoid storing metadata from non-relevant concurrent streams
    // (e.g. a music stream on a channel that also streams PUBG).
    // Shared util: ASCII keywords get word boundaries, non-ASCII (Hangul
    // etc.) get substring semantics — see src/utils/keyword-match.ts.
    const matchesKeywords = (title: string | null, channelName?: string): boolean =>
      keywordMatches(keywords, title, channelName);

    for (const { platform, streams } of searchResults) {
      for (const stream of streams) {
        discovered++;

        // SOOP's keyword search spans every category on the platform, so a
        // hit only counts inside the series' configured SOOP category
        // (discovery_game_ids.soop). No category configured → no SOOP hits.
        if (platform === 'soop' && !soopStreamInCategory(stream, gameIds.soop)) {
          soopOffCategory++;
          continue;
        }

        const lookupKey = `${platform}:${normIdent(stream.channelIdentifier)}`;

        // Already tracked? Still refresh the sighting: the Scout feed shows
        // "last seen" and the live title, and an active channel that Scout
        // never touched again read "15h ago" while it was live on stage.
        if (trackedSet.has(lookupKey)) {
          alreadyTracked++;
          const trackedId = trackedIds.get(lookupKey);
          if (trackedId && !refreshedThisCycle.has(trackedId)) {
            refreshedThisCycle.add(trackedId);
            const seenMeta: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
            if (stream.title) seenMeta.stream_title = stream.title;
            if (stream.concurrentViewers > 0) seenMeta.discovered_ccv = stream.concurrentViewers;
            try {
              await this.db('channels')
                .where('id', trackedId)
                .where('source', 'auto_discovered')
                .update({ metadata: this.db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [JSON.stringify(seenMeta)]) });
            } catch (err) {
              logger.warn(`[Discovery] Failed to refresh sighting for ${stream.channelIdentifier}`, { error: (err as Error).message });
            }
          }
          continue;
        }

        // Active day-scoped channel streaming on a day it isn't pinned to.
        // If the title matches the discovery keywords, extend it onto today's
        // live day(s) so it's polled today (covers a roster streamer going live
        // off-schedule). Keyword-gated to avoid attributing non-event streams.
        const offScheduleId = offScheduleActive.get(lookupKey);
        if (offScheduleId) {
          if (!matchesKeywords(stream.title, stream.displayName)) {
            alreadyTracked++;
            continue;
          }
          try {
            for (const dayId of liveDaySet) {
              await this.db('channel_broadcast_days')
                .insert({ channel_id: offScheduleId, broadcast_day_id: dayId })
                .onConflict(['channel_id', 'broadcast_day_id'])
                .ignore();
            }
            await this.db('channels').where('id', offScheduleId).update({
              metadata: this.db.raw(
                `COALESCE(metadata, '{}'::jsonb) || ?::jsonb`,
                [JSON.stringify({ last_seen_at: new Date().toISOString(), off_schedule_extended_at: new Date().toISOString() })],
              ),
            });
            trackedSet.add(lookupKey);
            resurfaced++;
            logger.info(
              `[Discovery] Extended day-scoped channel ${stream.displayName} [${platform}] onto live day(s) — ` +
              `off-schedule stream matched keywords (${stream.concurrentViewers < 0 ? 'CCV hidden' : `${stream.concurrentViewers} viewers`})`,
            );
          } catch (err) {
            logger.warn(`[Discovery] Failed to extend day-scoped channel ${stream.channelIdentifier}`, { error: (err as Error).message });
          }
          continue;
        }

        // In blocklist?
        if (blockSet.has(normIdent(stream.channelIdentifier))) {
          blocked++;
          continue;
        }

        // Below minimum viewer threshold?
        // Special case: concurrentViewers === -1 means the broadcaster has
        // disabled YouTube's public live-viewer count. Don't drop those —
        // their title already matched the search keywords, which is a stronger
        // signal than a hidden viewer number. Add as 0 (visible) but let
        // them through.
        if (
          stream.concurrentViewers >= 0 &&
          stream.concurrentViewers < this.minViewerThreshold
        ) {
          belowThreshold++;
          continue;
        }

        // Check if this is a disabled channel that's streaming again
        const disabledEntry = disabledMap.get(lookupKey);
        if (disabledEntry) {
          try {
            const relevant = matchesKeywords(stream.title, stream.displayName);

            // Skip re-surfacing if the stream title doesn't match keywords
            // (e.g., streamer switched from PGL to "Just Chatting" — not relevant anymore)
            if (!relevant) {
              trackedSet.add(lookupKey);
              alreadyTracked++;
              continue;
            }

            const freshMeta: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
            if (stream.title) freshMeta.stream_title = stream.title;
            if (stream.concurrentViewers > 0) freshMeta.discovered_ccv = stream.concurrentViewers;
            await this.db('channels').where('id', disabledEntry.id)
              .update({ metadata: this.db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [JSON.stringify(freshMeta)]) });

            // Auto-heal: a HUMAN-approved channel (tier beyond the default
            // community) going live with a matching title on a live day
            // needs no second approval — reactivate and pin so its data
            // flows immediately instead of queueing for a manual click
            // (500BROS lost three broadcast hours to that queue).
            if (disabledEntry.tier !== 'community' && liveDaySet.size > 0) {
              await this.db('channels').where('id', disabledEntry.id).update({
                is_active: true,
                // Clear the pause bookkeeping — a healed channel wearing a
                // stale AUTO-PAUSED chip confuses the feed into showing no
                // actions at all.
                metadata: this.db.raw(
                  `COALESCE(metadata,'{}'::jsonb) - 'auto_paused' - 'auto_paused_reason' - 'paused_at'`,
                ),
              });
              for (const dayId of liveDaySet) {
                await this.db('channel_broadcast_days')
                  .insert({ channel_id: disabledEntry.id, broadcast_day_id: dayId })
                  .onConflict(['channel_id', 'broadcast_day_id'])
                  .ignore();
              }
              logger.info(
                `[Discovery] Auto-reactivated approved channel ${stream.displayName} [${platform}] onto live day(s)`,
              );
            }
            trackedSet.add(lookupKey);
            resurfaced++;
            logger.info(
              `[Discovery] Re-surfaced disabled channel ${stream.displayName} [${platform}] ` +
              `(${stream.concurrentViewers < 0 ? 'CCV hidden' : `${stream.concurrentViewers} viewers`})`,
            );
          } catch (err) {
            logger.warn(`[Discovery] Failed to re-surface ${stream.channelIdentifier}`, { error: (err as Error).message });
          }
          continue;
        }

        // New channel — insert as inactive (pending approval via Discovery Feed)
        try {
          // Seed last_seen_at so the channel is immediately visible in the
          // Discovery Feed UI on the same cycle it was added. Without this,
          // the dashboard filter (DiscoveryFeedPanel) hides inactive channels
          // that lack last_seen_at, and the channel only appears on the NEXT
          // cycle (via the resurfaced branch above).
          const channelMetadata: Record<string, unknown> = {
            last_seen_at: new Date().toISOString(),
          };
          const relevantNew = matchesKeywords(stream.title, stream.displayName);
          if (stream.title && relevantNew) channelMetadata.stream_title = stream.title;
          if (stream.concurrentViewers > 0) channelMetadata.discovered_ccv = stream.concurrentViewers;

          await this.db('channels').insert({
            series_id: seriesId,
            platform,
            channel_identifier: stream.channelIdentifier,
            display_name: stream.displayName,
            language: normalizeLanguageCode(stream.language),
            tier: 'community',
            source: 'auto_discovered',
            is_active: false,
            metadata: JSON.stringify(channelMetadata),
          });

          // Add to tracked set so we don't try to insert again this cycle
          trackedSet.add(lookupKey);
          added++;

          logger.info(
            `[Discovery] Added ${stream.displayName} [${platform}] ` +
            `(${stream.concurrentViewers < 0 ? 'CCV hidden' : `${stream.concurrentViewers} viewers`}) ` +
            `to series ${series.name}`,
          );
        } catch (err) {
          // Unique constraint violation is expected if channel was added concurrently
          const errMsg = (err as Error).message;
          if (errMsg.includes('unique') || errMsg.includes('duplicate')) {
            alreadyTracked++;
          } else {
            errors.push(`Failed to insert ${stream.channelIdentifier} on ${platform}: ${errMsg}`);
            logger.error(`[Discovery] Insert failed for ${stream.channelIdentifier}`, {
              error: errMsg,
            });
          }
        }
      }
    }

    // 6. Direct live-check for disabled channels not found via search
    // Search APIs have result limits and may miss smaller channels.
    // Blocklisted channels are excluded — this path bypasses the search
    // loop's blocklist gate, and its keyword test also matches CHANNEL
    // NAMES, so a channel literally named after the event ("PGS is
    // Live") would otherwise re-surface every cycle forever.
    const uncheckedDisabled = disabledChannels.filter(
      (ch) =>
        !trackedSet.has(`${ch.platform}:${normIdent(ch.channel_identifier)}`) &&
        !blockSet.has(normIdent(ch.channel_identifier)),
    );
    if (uncheckedDisabled.length > 0) {
      // Group by platform for batch checking
      const byPlatform = new Map<string, typeof uncheckedDisabled>();
      for (const ch of uncheckedDisabled) {
        const list = byPlatform.get(ch.platform) ?? [];
        list.push(ch);
        byPlatform.set(ch.platform, list);
      }

      for (const [platform, channels] of byPlatform) {
        try {
          const adapter = this.registry.getAdapter(platform as PlatformName);
          const identifiers = channels.map((ch) => ch.channel_identifier);
          const snapshots = await adapter.getViewerCounts(identifiers);

          for (const snap of snapshots) {
            if (snap.isLive && snap.concurrentViewers > 0) {
              const ch = channels.find(
                (c) => normIdent(c.channel_identifier) === normIdent(snap.channelIdentifier),
              );
              if (ch) {
                // Defense-in-depth: if the scraper returned a snapshot
                // with a different displayName than what we have stored,
                // it almost certainly attributed a foreign channel's
                // data to ours (the scrape's channel-mismatch guard
                // failed). Drop the snapshot rather than poisoning the
                // record. This caught the MortaL ↔ 8bit Binks69
                // mis-attribution on PEC discovery 2026-05-01.
                const storedName = (ch.display_name ?? '').trim().toLowerCase();
                const scrapedName = (snap.displayName ?? '').trim().toLowerCase();
                if (storedName && scrapedName && storedName !== scrapedName) {
                  logger.warn(
                    `[Discovery] Skipping snapshot for ${ch.channel_identifier} [${platform}] — ` +
                    `scraped displayName "${snap.displayName}" does not match stored "${ch.display_name}". ` +
                    `Likely cross-channel attribution (foreign /live redirect).`,
                  );
                  continue;
                }

                // Skip if stream title doesn't match keywords
                // (streamer may have switched to a non-relevant game/topic)
                const relevant = matchesKeywords(snap.title, snap.displayName ?? undefined);
                if (!relevant) continue;

                const freshMeta: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
                if (snap.title) freshMeta.stream_title = snap.title;
                if (snap.concurrentViewers > 0) freshMeta.discovered_ccv = snap.concurrentViewers;
                await this.db('channels').where('id', ch.id)
                  .update({ metadata: this.db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [JSON.stringify(freshMeta)]) });
                // Same auto-heal as the search path: approved channels
                // rejoin live days without waiting for a manual click.
                const chTier = (ch as unknown as { tier?: string }).tier;
                if (chTier && chTier !== 'community' && liveDaySet.size > 0) {
                  await this.db('channels').where('id', ch.id).update({
                    is_active: true,
                    metadata: this.db.raw(
                      `COALESCE(metadata,'{}'::jsonb) - 'auto_paused' - 'auto_paused_reason' - 'paused_at'`,
                    ),
                  });
                  for (const dayId of liveDaySet) {
                    await this.db('channel_broadcast_days')
                      .insert({ channel_id: ch.id, broadcast_day_id: dayId })
                      .onConflict(['channel_id', 'broadcast_day_id'])
                      .ignore();
                  }
                  logger.info(
                    `[Discovery] Auto-reactivated approved channel ${snap.channelIdentifier} [${platform}] onto live day(s)`,
                  );
                }
                resurfaced++;
                logger.info(
                  `[Discovery] Re-surfaced disabled channel ${snap.channelIdentifier} [${platform}] via direct check (${snap.concurrentViewers} viewers)`,
                );
              }
            }
          }
        } catch (err) {
          logger.debug(`[Discovery] Direct live-check failed for ${platform}`, { error: (err as Error).message });
        }
      }
    }

    const duration = Date.now() - startTime;

    logger.info(
      `[Discovery] Cycle for ${series.name}: ${discovered} discovered, ${added} added, ${resurfaced} resurfaced, ` +
      `${alreadyTracked} already tracked, ${belowThreshold} below threshold, ${blocked} blocked, ${soopOffCategory} SOOP off-category, ${duration}ms`,
    );

    const result: DiscoveryResult = {
      seriesId,
      timestamp,
      discovered,
      added,
      resurfaced,
      alreadyTracked,
      belowThreshold,
      blocked,
      errors,
      duration,
    };

    this.lastResults.set(seriesId, result);

    // Broadcast discovery result via WebSocket (trigger on new or resurfaced channels)
    if (this.discoveryBroadcast && (added > 0 || resurfaced > 0)) {
      try {
        this.discoveryBroadcast(result);
      } catch (err) {
        logger.error('[Discovery] Discovery broadcast failed', { error: (err as Error).message });
      }
    }

    return result;
  }

  // ── Channel management ────────────────────────────────────────────────

  /**
   * Block a channel for a given series.
   * Adds the channel identifier to the series metadata blocklist and deactivates it.
   */
  async blockChannel(seriesId: string, channelId: string): Promise<void> {
    // Look up the channel to get its identifier
    const channel = await this.db<Channel>('channels')
      .where('id', channelId)
      .first();

    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    // Load the series
    const series = await this.db<TournamentSeries>('tournament_series')
      .where('id', seriesId)
      .first();

    if (!series) {
      throw new Error(`Series ${seriesId} not found`);
    }

    // Add to blocklist in metadata
    const metadata = { ...(series.metadata ?? {}) };
    const blocklist: string[] = Array.isArray(metadata.blocklist) ? [...metadata.blocklist] : [];

    const identifier = channel.channel_identifier.toLowerCase();
    if (!blocklist.includes(identifier)) {
      blocklist.push(identifier);
    }
    metadata.blocklist = blocklist;

    // Update series metadata
    await this.db('tournament_series')
      .where('id', seriesId)
      .update({ metadata: JSON.stringify(metadata), updated_at: this.db.fn.now() });

    // Deactivate the channel
    await this.db('channels')
      .where('id', channelId)
      .update({ is_active: false });

    logger.info(
      `[Discovery] Blocked channel ${channel.display_name} (${channel.channel_identifier}) for series ${series.name}`,
    );
  }

  /**
   * Undo a block: remove the identifier from the series blocklist,
   * reactivate the channel, and pin it to the currently-live day(s) so
   * polling resumes immediately instead of waiting for re-discovery
   * (day-scoped rows without a pin have their snapshots dropped).
   */
  async unblockChannel(seriesId: string, channelId: string): Promise<void> {
    const channel = await this.db<Channel>('channels')
      .where('id', channelId)
      .first();
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const series = await this.db<TournamentSeries>('tournament_series')
      .where('id', seriesId)
      .first();
    if (!series) {
      throw new Error(`Series ${seriesId} not found`);
    }

    const metadata = { ...(series.metadata ?? {}) };
    const identifier = channel.channel_identifier.toLowerCase();
    const blocklist: string[] = Array.isArray(metadata.blocklist) ? [...metadata.blocklist] : [];
    metadata.blocklist = blocklist.filter((b) => b !== identifier);

    await this.db('tournament_series')
      .where('id', seriesId)
      .update({ metadata: JSON.stringify(metadata), updated_at: this.db.fn.now() });

    await this.db('channels').where('id', channelId).update({ is_active: true });

    const liveDayIds = await this.db('broadcast_days')
      .where({ series_id: seriesId, status: 'live' })
      .pluck('id');
    for (const dayId of liveDayIds) {
      await this.db('channel_broadcast_days')
        .insert({ channel_id: channelId, broadcast_day_id: dayId })
        .onConflict(['channel_id', 'broadcast_day_id'])
        .ignore();
    }

    logger.info(
      `[Discovery] Unblocked channel ${channel.display_name} (${channel.channel_identifier}) for series ${series.name}` +
        (liveDayIds.length > 0 ? ` — pinned to ${liveDayIds.length} live day(s)` : ''),
    );
  }

  /**
   * Promote a channel to a new tier.
   */
  async promoteChannel(channelId: string, tier: string): Promise<void> {
    const validTiers = ['official', 'partner', 'community', 'player', 'watch_party'];
    if (!validTiers.includes(tier)) {
      throw new Error(`Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    }

    const channel = await this.db<Channel>('channels')
      .where('id', channelId)
      .first();

    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    await this.db('channels')
      .where('id', channelId)
      .update({
        tier,
        is_active: true,
        metadata: this.db.raw("COALESCE(metadata, '{}'::jsonb) - 'auto_paused' - 'auto_paused_at'"),
      });

    // Auto-assign current live broadcast day(s)
    const liveDays = await this.db('broadcast_days')
      .where('series_id', channel.series_id)
      .where('status', 'live')
      .select('id');
    if (liveDays.length > 0) {
      const liveDayIds = liveDays.map((d: { id: string }) => d.id);
      // Add current live day(s) — preserves existing historical day tags
      await this.db('channel_broadcast_days')
        .insert(liveDayIds.map((dayId: string) => ({ channel_id: channelId, broadcast_day_id: dayId })))
        .onConflict(['channel_id', 'broadcast_day_id'])
        .ignore();
    }

    logger.info(
      `[Discovery] Approved & promoted channel ${channel.display_name} from ${channel.tier} to ${tier}`,
    );
  }

  /**
   * Purge unapproved auto-discovered channels for a series.
   * Only deletes channels with source='auto_discovered' AND is_active=false
   * that have NO viewership snapshots (i.e. truly pending/unapproved).
   * Channels with historical data (blocked after collecting data) are preserved.
   */
  async purgeDiscoveredChannels(seriesId: string): Promise<number> {
    // Find channels that have viewership data — these must be preserved
    const channelsWithData = await this.db('viewership_snapshots')
      .where('series_id', seriesId)
      .distinct('channel_id');
    const protectedIds = new Set(
      channelsWithData.map((r: { channel_id: string }) => r.channel_id),
    );

    // Get candidates for purge
    const candidates = await this.db('channels')
      .where('series_id', seriesId)
      .where('source', 'auto_discovered')
      .where('is_active', false)
      .select('id');

    // Only purge channels that have NO historical data
    const toPurge = candidates
      .filter((c: { id: string }) => !protectedIds.has(c.id))
      .map((c: { id: string }) => c.id);

    let count = 0;
    if (toPurge.length > 0) {
      count = await this.db('channels')
        .whereIn('id', toPurge)
        .delete();
    }

    // For protected channels (have viewership data), clear last_seen_at so
    // they disappear from the discovery feed until re-discovered streaming
    const toHide = candidates
      .filter((c: { id: string }) => protectedIds.has(c.id))
      .map((c: { id: string }) => c.id);
    if (toHide.length > 0) {
      await this.db('channels')
        .whereIn('id', toHide)
        .update({ metadata: this.db.raw("metadata - 'last_seen_at'") });
    }

    if (count > 0 || toHide.length > 0) {
      logger.info(`[Discovery] Purged ${count} channel(s), hid ${toHide.length} with data for series ${seriesId}`);
    }

    return count + toHide.length;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private getBlocklist(series: TournamentSeries): string[] {
    const metadata = series.metadata ?? {};
    if (Array.isArray(metadata.blocklist)) {
      return metadata.blocklist as string[];
    }
    return [];
  }
}
