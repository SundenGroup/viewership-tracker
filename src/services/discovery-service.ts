import type { Knex } from 'knex';
import logger from '../utils/logger';
import { config } from '../utils/config';
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
const PLATFORMS: PlatformName[] = ['twitch', 'youtube', 'kick', 'tiktok', 'steam'];

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
  startDiscovery(seriesId: string): void {
    if (this.intervals.has(seriesId)) {
      logger.debug(`[Discovery] Already running for series ${seriesId}`);
      return;
    }

    const intervalMs = config.polling.discoveryIntervalMs;
    logger.info(`[Discovery] Starting discovery for series ${seriesId} (interval: ${intervalMs}ms)`);

    // Run the first cycle immediately
    this.runCycleIfLive(seriesId);

    // Schedule subsequent cycles
    const handle = setInterval(() => this.runCycleIfLive(seriesId), intervalMs);
    this.intervals.set(seriesId, handle);
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
        alreadyTracked: 0,
        belowThreshold: 0,
        blocked: 0,
        errors: [],
        duration: Date.now() - startTime,
      };
    }

    // 2. Load existing ACTIVE channels for this series (for dedup check)
    const existingChannels = await this.db<Channel>('channels')
      .where('series_id', seriesId)
      .where('is_active', true)
      .select('platform', 'channel_identifier');

    const trackedSet = new Set<string>(
      existingChannels.map((ch) => `${ch.platform}:${ch.channel_identifier.toLowerCase()}`),
    );

    // Also load disabled auto-discovered channels so we can re-surface them
    const disabledChannels = await this.db<Channel>('channels')
      .where('series_id', seriesId)
      .where('source', 'auto_discovered')
      .where('is_active', false)
      .select('id', 'platform', 'channel_identifier');

    const disabledMap = new Map<string, string>();
    for (const ch of disabledChannels) {
      disabledMap.set(`${ch.platform}:${ch.channel_identifier.toLowerCase()}`, ch.id);
    }

    // 3. Load blocklist from series metadata
    const blocklist = this.getBlocklist(series);
    const blockSet = new Set<string>(
      blocklist.map((b) => b.toLowerCase()),
    );

    // 4. Search each platform in parallel
    const platformSearches = PLATFORMS.map(async (platform): Promise<{
      platform: PlatformName;
      streams: DiscoveredStream[];
    }> => {
      try {
        const adapter = this.registry.getAdapter(platform);
        const gameId = gameIds[platform] ?? undefined;
        const streams = await adapter.searchLiveStreams(gameId, keywords.length > 0 ? keywords : undefined);
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
    let alreadyTracked = 0;
    let belowThreshold = 0;
    let blocked = 0;

    for (const { platform, streams } of searchResults) {
      for (const stream of streams) {
        discovered++;

        const lookupKey = `${platform}:${stream.channelIdentifier.toLowerCase()}`;

        // Already tracked?
        if (trackedSet.has(lookupKey)) {
          alreadyTracked++;
          continue;
        }

        // In blocklist?
        if (blockSet.has(stream.channelIdentifier.toLowerCase())) {
          blocked++;
          continue;
        }

        // Below minimum viewer threshold?
        if (stream.concurrentViewers < this.minViewerThreshold) {
          belowThreshold++;
          continue;
        }

        // Check if this is a disabled channel that's streaming again
        const disabledId = disabledMap.get(lookupKey);
        if (disabledId) {
          try {
            const freshMeta: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
            if (stream.title) freshMeta.stream_title = stream.title;
            if (stream.concurrentViewers > 0) freshMeta.discovered_ccv = stream.concurrentViewers;
            await this.db('channels').where('id', disabledId)
              .update({ metadata: this.db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [JSON.stringify(freshMeta)]) });
            trackedSet.add(lookupKey);
            logger.info(
              `[Discovery] Re-surfaced disabled channel ${stream.displayName} [${platform}] (${stream.concurrentViewers} viewers)`,
            );
          } catch (err) {
            logger.warn(`[Discovery] Failed to re-surface ${stream.channelIdentifier}`, { error: (err as Error).message });
          }
          continue;
        }

        // New channel — insert as inactive (pending approval via Discovery Feed)
        try {
          const channelMetadata: Record<string, unknown> = {};
          if (stream.title) channelMetadata.stream_title = stream.title;
          if (stream.concurrentViewers > 0) channelMetadata.discovered_ccv = stream.concurrentViewers;

          await this.db('channels').insert({
            series_id: seriesId,
            platform,
            channel_identifier: stream.channelIdentifier,
            display_name: stream.displayName,
            language: stream.language ? stream.language.split('-')[0].toLowerCase() : null,
            tier: 'community',
            source: 'auto_discovered',
            is_active: false,
            metadata: JSON.stringify(channelMetadata),
          });

          // Add to tracked set so we don't try to insert again this cycle
          trackedSet.add(lookupKey);
          added++;

          logger.info(
            `[Discovery] Added ${stream.displayName} [${platform}] (${stream.concurrentViewers} viewers) to series ${series.name}`,
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

    const duration = Date.now() - startTime;

    logger.info(
      `[Discovery] Cycle for ${series.name}: ${discovered} discovered, ${added} added, ` +
      `${alreadyTracked} already tracked, ${belowThreshold} below threshold, ${blocked} blocked, ${duration}ms`,
    );

    const result: DiscoveryResult = {
      seriesId,
      timestamp,
      discovered,
      added,
      alreadyTracked,
      belowThreshold,
      blocked,
      errors,
      duration,
    };

    this.lastResults.set(seriesId, result);

    // Broadcast discovery result via WebSocket
    if (this.discoveryBroadcast && added > 0) {
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
      .update({ tier, is_active: true });

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
