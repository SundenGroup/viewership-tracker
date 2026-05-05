/**
 * Live Game Tracker service.
 *
 * Plan: docs/plans/2026-05-05-live-game-tracker.md (Phase 1).
 *
 * Continuously polls all currently-live streams of a configured game
 * (Twitch only in Phase 1; Kick added in Phase 2). Each cycle:
 *   1. Pulls the platform's full game-category listing (one HTTP call).
 *   2. Upserts a row per stream into channels + game_tracker_channels.
 *   3. Writes a viewership snapshot for every stream above
 *      min_ccv_threshold.
 *   4. For previously-active channels NOT in this cycle's results,
 *      bumps consecutive_mismatch_cycles. Streams that miss
 *      mismatch_threshold_cycles consecutive cycles are dropped.
 *
 * Runs independently of the tournament PollingOrchestrator. The two
 * share only the adapter layer + DB pool.
 */
import type { Knex } from 'knex';
import logger from '../utils/logger';
import type { AdapterRegistry } from '../adapters';
import type { TwitchAdapter } from '../adapters/twitch';
import type { DiscoveredStream } from '../adapters/types';
import * as GameTrackerModel from '../models/game-tracker';
import * as GameTrackerChannelModel from '../models/game-tracker-channel';
import * as GameTrackerSnapshotModel from '../models/game-tracker-snapshot';
import type { Channel } from '../models/channel';

interface CycleResult {
  trackerSlug: string;
  liveStreamsFound: number;
  snapshotsWritten: number;
  newChannels: number;
  resurfacedChannels: number;
  bumpedMismatch: number;
  dropped: number;
  durationMs: number;
}

export class GameTrackerService {
  private readonly registry: AdapterRegistry;
  private readonly db: Knex;
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastResults = new Map<string, CycleResult>();
  private running = false;

  constructor(registry: AdapterRegistry, db: Knex) {
    this.registry = registry;
    this.db = db;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const trackers = await GameTrackerModel.findActive();
    logger.info(`[GameTracker] Starting service (${trackers.length} active tracker(s))`);
    for (const tracker of trackers) {
      this.startTracker(tracker.id);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [trackerId, handle] of this.intervals) {
      clearInterval(handle);
      logger.debug(`[GameTracker] Stopped poll loop for tracker ${trackerId}`);
    }
    this.intervals.clear();
  }

  /**
   * Start the poll loop for one tracker. Idempotent — if already running,
   * does nothing. Reads the tracker config fresh from DB every call.
   */
  async startTracker(trackerId: string): Promise<void> {
    if (this.intervals.has(trackerId)) {
      logger.debug(`[GameTracker] Already running for ${trackerId}`);
      return;
    }

    const tracker = await GameTrackerModel.findById(trackerId);
    if (!tracker || tracker.status !== 'active') {
      logger.debug(`[GameTracker] Skipping ${trackerId} (not active)`);
      return;
    }

    const intervalMs = tracker.polling_interval_seconds * 1000;
    logger.info(`[GameTracker:${tracker.slug}] starting (every ${intervalMs / 1000}s)`);

    // First cycle immediately.
    this.runCycleSafe(trackerId);

    const handle = setInterval(() => this.runCycleSafe(trackerId), intervalMs);
    this.intervals.set(trackerId, handle);
  }

  stopTracker(trackerId: string): void {
    const handle = this.intervals.get(trackerId);
    if (!handle) return;
    clearInterval(handle);
    this.intervals.delete(trackerId);
    logger.info(`[GameTracker] stopped tracker ${trackerId}`);
  }

  getLastResult(trackerId: string): CycleResult | null {
    return this.lastResults.get(trackerId) ?? null;
  }

  // ── Per-cycle logic ───────────────────────────────────────────────────

  private async runCycleSafe(trackerId: string): Promise<void> {
    try {
      await this.runCycle(trackerId);
    } catch (err) {
      logger.error(`[GameTracker] cycle failed for ${trackerId}`, {
        error: (err as Error).message,
      });
    }
  }

  /**
   * One discovery + poll cycle for a single tracker. Pulls the full live
   * stream list for the configured game on each platform, then reconciles
   * with the active channel set: upsert matches, bump or drop misses.
   */
  async runCycle(trackerId: string): Promise<CycleResult> {
    const start = Date.now();
    const tracker = await GameTrackerModel.findById(trackerId);
    if (!tracker) {
      throw new Error(`tracker ${trackerId} not found`);
    }

    const slug = tracker.slug;
    const liveStreams: DiscoveredStream[] = [];

    // Phase 1: Twitch only. Phase 2 will add Kick here.
    if (tracker.twitch_game_id) {
      try {
        const twitch = this.registry.getAdapter('twitch') as TwitchAdapter;
        const streams = await twitch.searchLiveStreams(tracker.twitch_game_id);
        for (const s of streams) {
          // Twitch returns the canonical category name on every row, so
          // streams that switched away from the target game won't appear
          // in this list at all. We tag the snapshots with platform
          // 'twitch' downstream.
          liveStreams.push({ ...s, gameName: s.gameName ?? tracker.twitch_game_name });
        }
      } catch (err) {
        logger.warn(`[GameTracker:${slug}] Twitch fetch failed`, {
          error: (err as Error).message,
        });
      }
    }

    // Cap at max_active_channels to protect against runaway growth.
    const eligible = liveStreams
      .filter((s) => s.concurrentViewers >= tracker.min_ccv_threshold)
      .sort((a, b) => b.concurrentViewers - a.concurrentViewers)
      .slice(0, tracker.max_active_channels);

    const cycleTimestamp = new Date();
    const eligibleByKey = new Map<string, DiscoveredStream>();
    for (const s of eligible) {
      eligibleByKey.set(this.channelKey('twitch', s.channelIdentifier), s);
    }

    // ── Resolve channels (insert if new, reuse if known) ──────────────
    const result: CycleResult = {
      trackerSlug: slug,
      liveStreamsFound: liveStreams.length,
      snapshotsWritten: 0,
      newChannels: 0,
      resurfacedChannels: 0,
      bumpedMismatch: 0,
      dropped: 0,
      durationMs: 0,
    };

    // Bulk-load existing channels matching this cycle's identifiers.
    const identifiersByPlatform = new Map<string, string[]>();
    for (const s of eligible) {
      const list = identifiersByPlatform.get('twitch') ?? [];
      list.push(s.channelIdentifier.toLowerCase());
      identifiersByPlatform.set('twitch', list);
    }

    const existingChannels = new Map<string, Channel>();
    for (const [platform, idents] of identifiersByPlatform) {
      if (idents.length === 0) continue;
      const rows = await this.db<Channel>('channels')
        .where('platform', platform)
        .whereRaw('LOWER(channel_identifier) = ANY(?)', [idents])
        .select('*');
      for (const r of rows) {
        existingChannels.set(this.channelKey(platform, r.channel_identifier), r);
      }
    }

    // game_tracker_channels rows currently active for this tracker.
    const activeAssignments = await GameTrackerChannelModel.listActive(tracker.id);
    const assignmentByChannelId = new Map<string, GameTrackerChannelModel.GameTrackerChannel>();
    for (const a of activeAssignments) {
      assignmentByChannelId.set(a.channel_id, a);
    }

    const snapshotsToInsert: GameTrackerSnapshotModel.InsertSnapshot[] = [];
    const matchedChannelIds = new Set<string>();

    for (const stream of eligible) {
      const key = this.channelKey('twitch', stream.channelIdentifier);
      let channel = existingChannels.get(key);

      // Insert a new channels row for previously-unseen streamers. The
      // game tracker uses series_id = NULL — which is allowed by the
      // schema (channels has a NOT NULL series_id today, so we need a
      // workaround: use the dedicated tracker pseudo-series mechanism).
      //
      // To keep Phase 1 simple AND the schema clean, we adopt a small
      // convention: every game_tracker has an associated series_id stub
      // generated on first need. We store that pseudo-series-id in
      // tracker.metadata.bound_series_id so existing channels-table
      // constraints still apply.
      if (!channel) {
        const seriesId = await this.ensureBoundSeries(tracker);
        try {
          const [created] = await this.db('channels')
            .insert({
              series_id: seriesId,
              platform: 'twitch',
              channel_identifier: stream.channelIdentifier,
              display_name: stream.displayName,
              language: stream.language ? stream.language.split('-')[0].toLowerCase() : null,
              tier: 'community',
              source: 'auto_discovered',
              is_active: true,
              metadata: JSON.stringify({
                game_tracker_managed: true,
                game_tracker_id: tracker.id,
                last_seen_at: new Date().toISOString(),
              }),
            })
            .returning('*') as Channel[];
          channel = created;
          existingChannels.set(key, channel);
          result.newChannels++;
        } catch (err) {
          // Another concurrent cycle inserted this channel — refetch.
          const refetch = await this.db<Channel>('channels')
            .where('platform', 'twitch')
            .whereRaw('LOWER(channel_identifier) = ?', [stream.channelIdentifier.toLowerCase()])
            .first();
          if (!refetch) {
            logger.warn(`[GameTracker:${slug}] failed to insert/find channel for ${stream.channelIdentifier}`, {
              error: (err as Error).message,
            });
            continue;
          }
          channel = refetch;
          existingChannels.set(key, channel);
        }
      }

      // Upsert the game_tracker_channels assignment.
      const existingAssignment = assignmentByChannelId.get(channel.id);
      if (existingAssignment) {
        await GameTrackerChannelModel.recordMatch(existingAssignment.id);
      } else {
        await GameTrackerChannelModel.upsert(tracker.id, channel.id, 'auto_discovered');
        result.resurfacedChannels++;
      }
      matchedChannelIds.add(channel.id);

      // Build the snapshot row.
      snapshotsToInsert.push({
        game_tracker_id: tracker.id,
        channel_id: channel.id,
        timestamp: cycleTimestamp,
        concurrent_viewers: stream.concurrentViewers,
        platform: 'twitch',
        language: stream.language ? stream.language.split('-')[0].toLowerCase() : null,
        region: null,
        stream_id: stream.streamId ?? null,
        stream_title: stream.title ?? null,
        game_name: stream.gameName ?? tracker.twitch_game_name ?? null,
        started_at: stream.startedAt ? new Date(stream.startedAt) : null,
      });
    }

    // ── Bump mismatch / drop streams that disappeared this cycle ──────
    for (const assignment of activeAssignments) {
      if (matchedChannelIds.has(assignment.channel_id)) continue;
      const newCount = await GameTrackerChannelModel.bumpMismatch(assignment.id);
      result.bumpedMismatch++;
      if (newCount >= tracker.mismatch_threshold_cycles) {
        await GameTrackerChannelModel.softDrop(assignment.id, 'mismatch');
        result.dropped++;
      }
    }

    // ── Persist snapshots ─────────────────────────────────────────────
    if (snapshotsToInsert.length > 0) {
      result.snapshotsWritten = await GameTrackerSnapshotModel.bulkInsert(snapshotsToInsert);
    }

    result.durationMs = Date.now() - start;
    this.lastResults.set(trackerId, result);

    logger.info(
      `[GameTracker:${slug}] cycle: ${result.snapshotsWritten} snapshots, ` +
        `${result.newChannels} new, ${result.resurfacedChannels} resurfaced, ` +
        `${result.bumpedMismatch} bumped, ${result.dropped} dropped (${result.durationMs}ms)`,
    );
    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private channelKey(platform: string, identifier: string): string {
    return `${platform}:${identifier.toLowerCase()}`;
  }

  /**
   * channels.series_id is NOT NULL today. Game-tracker-managed channels
   * don't belong to a tournament, so we lazily create one stub series
   * per tracker and reuse its id. Identified by metadata.is_game_tracker_stub.
   * The stub never appears in the tournament UI (filtered by status or
   * is_public depending on the surface).
   */
  private async ensureBoundSeries(tracker: GameTrackerModel.GameTracker): Promise<string> {
    const stored = (tracker.metadata as Record<string, unknown>)?.bound_series_id;
    if (typeof stored === 'string' && stored.length > 0) return stored;

    const stubName = `[game-tracker] ${tracker.name}`;
    const [series] = await this.db('tournament_series')
      .insert({
        name: stubName,
        short_name: `gt-${tracker.slug}`,
        status: 'active',
        timezone: 'UTC',
        auto_start_polling: false,
        is_public: false,
        metadata: JSON.stringify({
          is_game_tracker_stub: true,
          game_tracker_id: tracker.id,
        }),
      })
      .returning('id');

    const seriesId = series.id as string;
    const nextMeta = { ...tracker.metadata, bound_series_id: seriesId };
    await GameTrackerModel.update(tracker.id, { metadata: nextMeta });
    return seriesId;
  }
}
