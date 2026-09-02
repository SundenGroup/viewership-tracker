import type { Knex } from 'knex';
import logger from '../utils/logger';
import { assignMultiStreamSlots, type MultiStreamBindings } from '../utils/multi-stream-binding';
import { config } from '../utils/config';
import { AdapterRegistry } from '../adapters';
import type { MultiPlatformChannel } from '../adapters';
import type { ChannelSnapshot } from '../adapters/types';
import { YouTubeAdapter } from '../adapters/youtube';
import type { BroadcastDay } from '../models/broadcast-day';
import type { Channel } from '../models/channel';
import type { DiscoveryService } from './discovery-service';
import type { ReportAgent } from '../agent/report-agent';
import type { PushNotifier } from './push-notifier';
import { ccvAnomalyDetector } from './ccv-anomaly-detector';

// ── Callback types ──────────────────────────────────────────────────────

export type SnapshotBroadcastFn = (pollResult: PollCycleResult, seriesIds: string[]) => void;
export type StatusBroadcastFn = (
  seriesId: string,
  broadcastDayId: string,
  previousStatus: string,
  newStatus: string,
) => void;

// ── Result / Status types ───────────────────────────────────────────────

export interface PollCycleResult {
  timestamp: Date;
  channelsPolled: number;
  totalCCV: number;
  snapshotsCreated: number;
  errors: string[];
  duration: number;
}

export interface OrchestratorStatus {
  state: 'running' | 'stopped';
  activeBroadcastDays: number;
  lastPollTime: Date | null;
  lastPollResult: PollCycleResult | null;
}

// ── Constants ───────────────────────────────────────────────────────────

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 5;

/** Re-fire "polling stalled" push at most once per hour even if we stay stalled. */
const POLLING_STALL_PUSH_THROTTLE_MS = 60 * 60_000;

/** Window in which "broadcast about to end" fires (relative to broadcast_end). */
const BROADCAST_ENDING_LOOKAHEAD_MIN = 11;
const BROADCAST_ENDING_LOOKAHEAD_FLOOR_MIN = 9;

// ── PollingOrchestrator ─────────────────────────────────────────────────

export class PollingOrchestrator {
  private readonly registry: AdapterRegistry;
  private readonly db: Knex;
  private discoveryService: DiscoveryService | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeBroadcastDayCount = 0;
  private lastPollTime: Date | null = null;
  private lastPollResult: PollCycleResult | null = null;
  private consecutiveZeroResults = 0;
  private lastOrphanSweepTime = 0;
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000; // 10 minutes
  private activeSeriesIds = new Set<string>();
  private userStoppedDiscoveryIds = new Set<string>();
  private snapshotBroadcast: SnapshotBroadcastFn | null = null;
  private statusBroadcast: StatusBroadcastFn | null = null;
  private reportAgent: ReportAgent | null = null;
  private pushNotifier: PushNotifier | null = null;
  private lastStallPushAt = 0;
  private endingNotifiedDayIds = new Set<string>();

  // ── Anomaly sentry state ────────────────────────────────────────────
  // Detects the two crash signatures that cost data during PNC2026:
  // a sudden total-CCV collapse (tracking outage / broadcast crash) and
  // an official channel flatlining to 0 mid-broadcast.
  private prevTotalCCV: number | null = null;
  private officialZeroStreak = new Map<string, number>();
  private officialWasLive = new Set<string>();
  private lastAnomalyPushAt = new Map<string, number>();

  constructor(registry: AdapterRegistry, db: Knex) {
    this.registry = registry;
    this.db = db;
  }

  /** Adapter registry accessor — for API routes that need to probe
   *  platforms directly (e.g. the roster-liveness check). */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  /**
   * Attach a DiscoveryService for automatic lifecycle management.
   * When a broadcast day goes live, discovery starts for that series.
   * When all broadcast days for a series complete, discovery stops.
   */
  setDiscoveryService(service: DiscoveryService): void {
    this.discoveryService = service;
  }

  /**
   * Attach a callback to broadcast snapshot updates via WebSocket
   * after each successful poll cycle.
   */
  setSnapshotBroadcast(fn: SnapshotBroadcastFn): void {
    this.snapshotBroadcast = fn;
  }

  /**
   * Attach a callback to broadcast status updates via WebSocket
   * when broadcast day statuses transition.
   */
  setStatusBroadcast(fn: StatusBroadcastFn): void {
    this.statusBroadcast = fn;
  }

  /**
   * Attach a ReportAgent for auto-triggered report generation.
   * When broadcast days complete, the agent checks series metadata
   * for auto-report configuration and generates reports accordingly.
   */
  setReportAgent(agent: ReportAgent): void {
    this.reportAgent = agent;
  }

  /**
   * Attach a PushNotifier for Web Push fan-out (polling stalled,
   * broadcast about to end). The broadcast_started and discovery_candidate
   * events are wired in index.ts alongside the WS broadcast callbacks.
   */
  setPushNotifier(notifier: PushNotifier): void {
    this.pushNotifier = notifier;
  }

  /**
   * Mark a series as user-stopped so the orchestrator won't auto-restart discovery.
   */
  markDiscoveryUserStopped(seriesId: string): void {
    this.userStoppedDiscoveryIds.add(seriesId);
    this.activeSeriesIds.delete(seriesId);
  }

  /**
   * Clear the user-stopped flag when the user explicitly starts discovery.
   */
  markDiscoveryUserStarted(seriesId: string): void {
    this.userStoppedDiscoveryIds.delete(seriesId);
    this.activeSeriesIds.add(seriesId);
  }

  /**
   * Generate a display name for a multi-stream child channel.
   */
  private generateMultiStreamChildName(
    parentName: string,
    streamTitle: string | null,
    streamIndex: number,
  ): string {
    if (!streamTitle) return `${parentName} (Stream ${streamIndex})`;

    const titleLower = streamTitle.toLowerCase();

    // Known patterns
    if (titleLower.includes('map')) return `${parentName} Map`;
    if (titleLower.includes('secondary')) return `${parentName} Secondary`;
    if (titleLower.includes('companion')) return `${parentName} Companion`;

    // If title is just a number (round/match number), use generic name
    if (/^\d{1,3}$/.test(streamTitle.trim())) return `${parentName} (Stream ${streamIndex})`;

    // If title is very short or seems like a number, use generic
    if (streamTitle.trim().length <= 3) return `${parentName} (Stream ${streamIndex})`;

    // Otherwise use the stream title itself (truncated)
    const cleanTitle = streamTitle.trim().slice(0, 50);
    return cleanTitle;
  }

  /**
   * Get YouTube quota usage (for admin dashboard display).
   */
  getYouTubeQuota(): { used: number; limit: number } {
    try {
      const ytAdapter = this.registry.getAdapter('youtube') as import('../adapters/youtube').YouTubeAdapter;
      return ytAdapter.getQuotaUsage();
    } catch {
      return { used: 0, limit: 0 };
    }
  }

  /**
   * Per-key usage map for the discovery key pool. Keyed by youtube_api_keys.id.
   * Combined with the keys table, the admin UI renders per-key + per-partner
   * usage breakdowns.
   */
  getYouTubePoolQuota(): Record<string, number> {
    try {
      const ytAdapter = this.registry.getAdapter('youtube') as import('../adapters/youtube').YouTubeAdapter;
      return ytAdapter.getPoolQuotaUsage().perKey;
    } catch {
      return {};
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** See start(): restore sticky multi-stream ids for API-mode channels. */
  private async seedYouTubeStickyIds(): Promise<void> {
    try {
      const ytAdapter = this.registry.getAdapter('youtube') as import('../adapters/youtube').YouTubeAdapter;
      const rows: Array<{ root: string; ids: string[] }> = await this.db
        .raw(
          `SELECT SPLIT_PART(c.channel_identifier, ':stream-', 1) AS root,
                  array_agg(DISTINCT vs.stream_id) AS ids
           FROM viewership_snapshots vs
           JOIN channels c ON c.id = vs.channel_id
           WHERE vs.platform = 'youtube'
             AND vs.stream_id IS NOT NULL
             AND vs."timestamp" > NOW() - INTERVAL '10 minutes'
             AND EXISTS (
               SELECT 1 FROM channels p
               WHERE p.channel_identifier = SPLIT_PART(c.channel_identifier, ':stream-', 1)
                 AND p.platform = 'youtube'
                 AND COALESCE(p.metadata->>'multi_stream_via_api', '') = 'true'
             )
           GROUP BY 1`,
        )
        .then((r: { rows: Array<{ root: string; ids: string[] }> }) => r.rows);
      if (rows.length > 0) {
        ytAdapter.seedApiStickyIds(rows.map((r) => ({ channelId: r.root, videoIds: r.ids })));
      }
    } catch (err) {
      logger.warn('[Poll] Could not seed YouTube sticky ids', { error: (err as Error).message });
    }
  }

  start(): void {
    if (this.intervalHandle) {
      logger.warn('[Poll] Orchestrator already running — ignoring start()');
      return;
    }

    const intervalMs = config.polling.intervalMs;
    logger.info(`[Poll] Starting polling orchestrator (interval: ${intervalMs}ms)`);

    // Seed the YouTube API-path sticky ids from the last 10 minutes of
    // snapshots so a restart mid-broadcast doesn't forget a stream that
    // search.list omits in the first cycles after boot.
    void this.seedYouTubeStickyIds();

    // Run the first cycle immediately
    this.tick();

    // Schedule subsequent cycles
    this.intervalHandle = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // Also stop all discovery intervals
    if (this.discoveryService) {
      this.discoveryService.stopAll();
    }
    this.activeSeriesIds.clear();
    logger.info('[Poll] Polling orchestrator stopped');
  }

  getStatus(): OrchestratorStatus {
    return {
      state: this.intervalHandle ? 'running' : 'stopped',
      activeBroadcastDays: this.activeBroadcastDayCount,
      lastPollTime: this.lastPollTime,
      lastPollResult: this.lastPollResult,
    };
  }

  // ── Tick (wraps executePollCycle with lifecycle management) ────────────

  private async tick(): Promise<void> {
    try {
      await this.executePollCycle();
      // Fire "broadcast about to end" pushes for live days within the
      // 9-11 minute lookahead window. Cheap one-row-or-empty query each tick.
      await this.checkBroadcastEndingSoon();
      // GC stale anomaly-detector state once per tick (~30 s). The detector
      // only retains entries for 10 minutes anyway, so this is a small
      // bookkeeping no-op most of the time.
      ccvAnomalyDetector.gc();
    } catch (err) {
      logger.error('[Poll] Unhandled error in tick', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  }

  // ── Broadcast day status transitions ──────────────────────────────────

  private async transitionBroadcastDayStatuses(): Promise<void> {
    const now = new Date();

    try {
      // Identify days about to go live — only for series with auto_start_polling enabled
      const goingLive = await this.db<BroadcastDay>('broadcast_days')
        .where('broadcast_days.status', 'scheduled')
        .whereNotNull('broadcast_start')
        .where('broadcast_start', '<=', now)
        .whereIn('series_id', function () {
          this.select('id').from('tournament_series').where('auto_start_polling', true);
        })
        .select('id', 'series_id');

      if (goingLive.length > 0) {
        // Scheduled → Live: broadcast_start has passed
        await this.db('broadcast_days')
          .whereIn('id', goingLive.map((d) => d.id))
          .update({ status: 'live', updated_at: this.db.fn.now() });

        logger.info(`[Poll] Auto-transitioned ${goingLive.length} broadcast day(s) from scheduled → live`);

        // Broadcast status updates via WebSocket
        if (this.statusBroadcast) {
          for (const day of goingLive) {
            this.statusBroadcast(day.series_id, day.id, 'scheduled', 'live');
          }
        }

        // Discovery is user-initiated only — no auto-start here

        // Auto-purge unapproved discovery feed for affected series (fresh slate for new broadcast day)
        if (this.discoveryService) {
          const affectedSeriesIds = [...new Set(goingLive.map((d) => d.series_id))];
          for (const sid of affectedSeriesIds) {
            try {
              const purged = await this.discoveryService.purgeDiscoveredChannels(sid);
              if (purged > 0) {
                logger.info(`[Poll] Auto-purged discovery feed for series ${sid} (new broadcast day going live)`);
              }
            } catch (err) {
              logger.warn(`[Poll] Failed to auto-purge discovery feed for series ${sid}`, {
                error: (err as Error).message,
              });
            }
          }
        }
      }

      // Identify days about to complete (so we can check if all days for that series are done)
      // Safety: only complete if broadcast_end > broadcast_start (valid window).
      // This prevents instant-completion when cross-midnight end times are misconfigured.
      const goingCompleted = await this.db<BroadcastDay>('broadcast_days')
        .where('status', 'live')
        .whereNotNull('broadcast_end')
        .where('broadcast_end', '<=', now)
        .whereRaw('broadcast_end > broadcast_start')
        .select('id', 'series_id');

      if (goingCompleted.length > 0) {
        // Live → Completed: broadcast_end has passed
        await this.db('broadcast_days')
          .whereIn('id', goingCompleted.map((d) => d.id))
          .update({ status: 'completed', updated_at: this.db.fn.now() });

        logger.info(`[Poll] Auto-transitioned ${goingCompleted.length} broadcast day(s) from live → completed`);

        // Broadcast status updates via WebSocket
        if (this.statusBroadcast) {
          for (const day of goingCompleted) {
            this.statusBroadcast(day.series_id, day.id, 'live', 'completed');
          }
        }

        // Auto-pause day-scoped channels that have no remaining scheduled/live days
        const affectedSeriesIds = [...new Set(goingCompleted.map((d) => d.series_id))];
        for (const sid of affectedSeriesIds) {
          try {
            const channelsToPause = await this.db('channel_broadcast_days as cbd')
              .join('channels as c', 'c.id', 'cbd.channel_id')
              .where('c.series_id', sid)
              .where('c.is_active', true)
              .where('c.source', 'auto_discovered')
              .whereNotExists(
                this.db('channel_broadcast_days as cbd2')
                  .join('broadcast_days as bd', 'bd.id', 'cbd2.broadcast_day_id')
                  .whereRaw('cbd2.channel_id = cbd.channel_id')
                  .whereIn('bd.status', ['scheduled', 'live']),
              )
              .distinct('cbd.channel_id');

            if (channelsToPause.length > 0) {
              const pauseIds = channelsToPause.map((r: { channel_id: string }) => r.channel_id);
              await this.db('channels')
                .whereIn('id', pauseIds)
                .update({
                  is_active: false,
                  metadata: this.db.raw(
                    `COALESCE(metadata, '{}'::jsonb) || ?::jsonb`,
                    [JSON.stringify({ auto_paused: true, auto_paused_at: new Date().toISOString() })],
                  ),
                });
              logger.info(`[Poll] Auto-paused ${pauseIds.length} day-scoped channel(s) for series ${sid}`);
            }
          } catch (err) {
            logger.error(`[Poll] Failed to auto-pause channels for series ${sid}`, {
              error: (err as Error).message,
            });
          }
        }

        // Check if all broadcast days for each affected series are now completed
        const completedSeriesIds = [...new Set(goingCompleted.map((d) => d.series_id))];
        for (const sid of completedSeriesIds) {
          const remainingLive = await this.db('broadcast_days')
            .where('series_id', sid)
            .where('status', 'live')
            .count('* as count')
            .first();

          const liveCount = parseInt((remainingLive as { count: string })?.count ?? '0', 10);
          if (liveCount === 0 && this.discoveryService) {
            this.discoveryService.stopDiscovery(sid);
            this.activeSeriesIds.delete(sid);
          }
        }

        // Auto-trigger report generation for completed broadcast days
        if (this.reportAgent) {
          // Fire-and-forget: don't block the poll cycle on report generation
          for (const day of goingCompleted) {
            this.reportAgent.onBroadcastDayCompleted(day.id, day.series_id).catch((err) => {
              logger.error('[Poll] Auto daily recap trigger failed', {
                broadcastDayId: day.id,
                error: (err as Error).message,
              });
            });
          }

          // Check for completed stages (all days in stage are completed)
          const completedStageIds = new Set<string>();
          for (const day of goingCompleted) {
            const stageDay = await this.db<BroadcastDay>('broadcast_days')
              .where('id', day.id)
              .select('stage_id')
              .first();
            if (stageDay?.stage_id) {
              const remainingInStage = await this.db('broadcast_days')
                .where('stage_id', stageDay.stage_id)
                .whereNot('status', 'completed')
                .count('* as count')
                .first();
              const remaining = parseInt((remainingInStage as { count: string })?.count ?? '0', 10);
              if (remaining === 0 && !completedStageIds.has(stageDay.stage_id)) {
                completedStageIds.add(stageDay.stage_id);
                this.reportAgent.onStageCompleted(stageDay.stage_id, day.series_id).catch((err) => {
                  logger.error('[Poll] Auto stage report trigger failed', {
                    stageId: stageDay.stage_id,
                    error: (err as Error).message,
                  });
                });
              }
            }
          }

          // Check for completed series (all stages/days are completed)
          for (const sid of completedSeriesIds) {
            const remainingScheduledOrLive = await this.db('broadcast_days')
              .where('series_id', sid)
              .whereNot('status', 'completed')
              .count('* as count')
              .first();
            const remaining = parseInt((remainingScheduledOrLive as { count: string })?.count ?? '0', 10);
            if (remaining === 0) {
              this.reportAgent.onSeriesCompleted(sid).catch((err) => {
                logger.error('[Poll] Auto series report trigger failed', {
                  seriesId: sid,
                  error: (err as Error).message,
                });
              });
            }
          }
        }
      }

      // ── Periodic sweep: catch orphaned auto-discovered channels ──────
      // Runs every 10 minutes (not every cycle) to reduce DB load.
      // Catches channels that missed the transition auto-pause
      // (e.g. due to deploy, restart, or race condition)
      const sweepNow = Date.now();
      if (sweepNow - this.lastOrphanSweepTime < PollingOrchestrator.ORPHAN_SWEEP_INTERVAL_MS) {
        // Skip sweep this cycle
      } else {
      this.lastOrphanSweepTime = sweepNow;
      const orphaned = await this.db('channels')
        .where('is_active', true)
        .where('source', 'auto_discovered')
        .whereExists(
          this.db('channel_broadcast_days')
            .whereRaw('channel_broadcast_days.channel_id = channels.id'),
        )
        .whereNotExists(
          this.db('channel_broadcast_days as cbd2')
            .join('broadcast_days as bd', 'bd.id', 'cbd2.broadcast_day_id')
            .whereRaw('cbd2.channel_id = channels.id')
            .whereIn('bd.status', ['scheduled', 'live']),
        )
        .select('id');

      if (orphaned.length > 0) {
        const orphanIds = orphaned.map((r: { id: string }) => r.id);
        await this.db('channels')
          .whereIn('id', orphanIds)
          .update({
            is_active: false,
            metadata: this.db.raw(
              `COALESCE(metadata, '{}'::jsonb) || ?::jsonb`,
              [JSON.stringify({ auto_paused: true, auto_paused_at: new Date().toISOString() })],
            ),
          });
        logger.info(`[Poll] Periodic sweep: auto-paused ${orphanIds.length} orphaned auto-discovered channel(s)`);
      }
      } // end orphan sweep interval check
    } catch (err) {
      logger.error('[Poll] Failed to transition broadcast day statuses', {
        error: (err as Error).message,
      });
    }
  }

  // ── Core poll cycle ───────────────────────────────────────────────────

  async executePollCycle(): Promise<PollCycleResult> {
    const startTime = Date.now();
    const timestamp = new Date();
    const errors: string[] = [];

    // 0. Auto-transition broadcast day statuses before querying
    await this.transitionBroadcastDayStatuses();

    // 1. Find all active (live) broadcast days
    const activeDays = await this.db<BroadcastDay>('broadcast_days')
      .where('status', 'live')
      .select('*');

    this.activeBroadcastDayCount = activeDays.length;

    // Discovery is user-initiated only — no auto-start in poll cycle

    if (activeDays.length === 0) {
      logger.debug('[Poll] No active broadcast days — idle cycle');
      const result: PollCycleResult = {
        timestamp,
        channelsPolled: 0,
        totalCCV: 0,
        snapshotsCreated: 0,
        errors: [],
        duration: Date.now() - startTime,
      };
      this.lastPollResult = result;
      this.lastPollTime = result.timestamp;
      return result;
    }

    logger.debug(`[Poll] ${activeDays.length} active broadcast day(s)`);

    // 2. Collect all active channels for each broadcast day's series
    //    Deduplicate by channel ID (same channel may appear across overlapping days)
    const seriesIds = [...new Set(activeDays.map((d) => d.series_id))];

    const channels = await this.db<Channel>('channels')
      .whereIn('series_id', seriesIds)
      .where('is_active', true)
      .select('*');

    if (channels.length === 0) {
      logger.debug('[Poll] No active channels found for live broadcast days');
      const result: PollCycleResult = {
        timestamp,
        channelsPolled: 0,
        totalCCV: 0,
        snapshotsCreated: 0,
        errors: [],
        duration: Date.now() - startTime,
      };
      this.lastPollResult = result;
      this.lastPollTime = result.timestamp;
      return result;
    }

    // Deduplicate channels by id (a channel belongs to one series, but we want unique set)
    const uniqueChannels = new Map<string, Channel>();
    for (const ch of channels) {
      uniqueChannels.set(ch.id, ch);
    }

    const channelList = Array.from(uniqueChannels.values());

    // 2b. Load per-day channel assignments (channel_broadcast_days junction table)
    //     Channels with no entries are series-wide (apply to all days).
    //     Channels with entries are restricted to only those specific days.
    const channelDayAssignments = await this.db('channel_broadcast_days')
      .whereIn('channel_id', channelList.map((ch) => ch.id))
      .select('channel_id', 'broadcast_day_id');

    const channelDayMap = new Map<string, Set<string>>();
    for (const a of channelDayAssignments) {
      if (!channelDayMap.has(a.channel_id)) {
        channelDayMap.set(a.channel_id, new Set());
      }
      channelDayMap.get(a.channel_id)!.add(a.broadcast_day_id);
    }

    // 3. Build multi-platform request (deduplicate by platform:identifier
    //    so channels shared across series are only fetched once)
    //    Skip TikTok channels when relay is configured (relay handles TikTok polling)
    const relayHandlesTikTok = !!process.env.RELAY_SECRET;
    const seenPlatformIds = new Set<string>();
    const multiPlatformChannels: MultiPlatformChannel[] = [];
    for (const ch of channelList) {
      if (relayHandlesTikTok && ch.platform === 'tiktok') continue;
      const dedupKey = `${ch.platform}:${ch.channel_identifier.toLowerCase()}`;
      if (seenPlatformIds.has(dedupKey)) continue;
      seenPlatformIds.add(dedupKey);
      multiPlatformChannels.push({
        platform: ch.platform as MultiPlatformChannel['platform'],
        channelIdentifier: ch.channel_identifier,
      });
    }

    // 3b. Pass multi-stream flags to YouTube adapter (channels with metadata.multi_stream)
    try {
      const ytAdapter = this.registry.getAdapter('youtube') as YouTubeAdapter;
      const multiStreamIds = channelList
        .filter((ch) => ch.platform === 'youtube' && (ch.metadata as Record<string, unknown>)?.multi_stream === true)
        .map((ch) => ch.channel_identifier);
      ytAdapter.setMultiStreamChannels(multiStreamIds);
      // Channels opted into the API-based multi-stream path. Independent
      // flag — a channel can have multi_stream=true without via_api, in
      // which case it stays on the scrape path. This is the rollout knob.
      const multiStreamApiIds = channelList
        .filter((ch) => ch.platform === 'youtube' && (ch.metadata as Record<string, unknown>)?.multi_stream_via_api === true)
        .map((ch) => ch.channel_identifier);
      ytAdapter.setMultiStreamApiChannels(multiStreamApiIds);
    } catch {
      // YouTube adapter not available — no multi-stream detection
    }

    // 4. Fetch viewer counts from all platforms in parallel
    let snapshots: ChannelSnapshot[];
    try {
      snapshots = await this.registry.getViewerCountsMultiPlatform(multiPlatformChannels);
    } catch (err) {
      const errMsg = `All adapters failed: ${(err as Error).message}`;
      logger.error(`[Poll] ${errMsg}`);
      errors.push(errMsg);
      this.trackConsecutiveFailure(true);
      const result: PollCycleResult = {
        timestamp,
        channelsPolled: channelList.length,
        totalCCV: 0,
        snapshotsCreated: 0,
        errors,
        duration: Date.now() - startTime,
      };
      this.lastPollResult = result;
      this.lastPollTime = result.timestamp;
      return result;
    }

    // 5. Build broadcast day lookup: series_id → broadcast_day(s)
    const seriesToDays = new Map<string, BroadcastDay[]>();
    for (const day of activeDays) {
      const list = seriesToDays.get(day.series_id) ?? [];
      list.push(day);
      seriesToDays.set(day.series_id, list);
    }

    // 6. Build snapshot insert rows
    //    Each channel gets one or more snapshots (multi-stream YouTube channels
    //    produce multiple ChannelSnapshot entries with different streamId values).
    //    We use identifier-based matching via a multimap to support this 1-to-many mapping.
    interface SnapshotInsertRow {
      channel_id: string;
      broadcast_day_id: string;
      stage_id: string;
      series_id: string;
      timestamp: Date;
      concurrent_viewers: number;
      platform: string;
      language: string | null;
      region: string | null;
      stream_id: string | null;
      stream_title: string | null;
    }

    // Build multimap: platform:identifier → ChannelSnapshot[]
    // Each snapshot is tagged with its source platform by the registry,
    // so we can correctly separate channels that share the same identifier
    // across different platforms (e.g. "pubg_battlegroundstr" on both Kick and Twitch).
    const snapshotMap = new Map<string, ChannelSnapshot[]>();
    for (const snap of snapshots) {
      if (!snap.platform) continue;
      const key = `${snap.platform}:${snap.channelIdentifier.toLowerCase()}`;
      const list = snapshotMap.get(key) ?? [];
      list.push(snap);
      snapshotMap.set(key, list);
    }

    // ── 6b. Auto-split multi-stream YouTube channels ──────────────────
    // For channels with multi_stream=true and 2+ snapshots, create/find
    // child channel entries so each stream is tracked separately.
    // Highest-viewer stream stays with parent; others get child channels.
    const multiStreamParents = channelList.filter(
      (ch) => ch.platform === 'youtube' && (ch.metadata as Record<string, unknown>)?.multi_stream === true,
    );

    // Cache of child channels per parent (loaded once, reused across poll cycles)
    const childChannelCache = new Map<string, Array<{ id: string; metadata: Record<string, unknown>; display_name: string }>>();

    // Slot binding: which video id lives on the parent row and on each
    // ":stream-N" child. Bound by VIDEO ID (persisted in the parent's
    // metadata.multi_stream_binding), not by viewer rank — see
    // utils/multi-stream-binding.ts for the two incidents this prevents.
    // A bound slot whose stream is missing this cycle gets NO row (an
    // empty snapshot list), never another stream's numbers.
    const BIND_TTL_MS = 15 * 60_000;
    const BIND_PERSIST_MS = 5 * 60_000;
    const readBinding = (meta: Record<string, unknown>): MultiStreamBindings => {
      const raw = meta.multi_stream_binding as
        | {
            parent?: { videoId?: string | null; seenAt?: number | null };
            children?: Record<string, { videoId?: string | null; seenAt?: number | null }>;
          }
        | undefined;
      const children = new Map<number, { videoId: string | null; seenAt: number | null }>();
      for (const [k, v] of Object.entries(raw?.children ?? {})) {
        const idx = Number(k);
        if (Number.isFinite(idx)) children.set(idx, { videoId: v?.videoId ?? null, seenAt: v?.seenAt ?? null });
      }
      return { parent: { videoId: raw?.parent?.videoId ?? null, seenAt: raw?.parent?.seenAt ?? null }, children };
    };
    const serializeBinding = (b: MultiStreamBindings) => ({
      parent: b.parent,
      children: Object.fromEntries([...b.children.entries()].map(([k, v]) => [String(k), v])),
    });

    for (const parent of multiStreamParents) {
      const key = `${parent.platform}:${parent.channel_identifier.toLowerCase()}`;
      const parentSnapshots = snapshotMap.get(key);
      if (!parentSnapshots || parentSnapshots.length === 0) continue;

      // Every candidate must carry a stream id to be bindable. If any
      // doesn't (legacy scrape result), keep the old behaviour for this
      // parent: single snapshot → parent, several → highest viewers wins.
      const withIds = parentSnapshots.filter((s) => !!s.streamId);
      if (withIds.length !== parentSnapshots.length) {
        if (parentSnapshots.length > 1) {
          const sorted = [...parentSnapshots].sort(
            (a, b) => (b.concurrentViewers ?? 0) - (a.concurrentViewers ?? 0),
          );
          snapshotMap.set(key, [sorted[0]]);
        }
        continue;
      }

      const parentMeta = (parent.metadata ?? {}) as Record<string, unknown>;
      const nowMs = Date.now();
      const assignment = assignMultiStreamSlots(
        withIds.map((s) => ({ videoId: s.streamId as string, viewers: s.concurrentViewers ?? 0 })),
        readBinding(parentMeta),
        nowMs,
        BIND_TTL_MS,
      );
      const byId = new Map(withIds.map((s) => [s.streamId as string, s]));

      // Load existing children for this parent
      if (!childChannelCache.has(parent.id)) {
        const children = await this.db('channels')
          .where('series_id', parent.series_id)
          .whereRaw("metadata->>'multi_stream_parent' = ?", [parent.id])
          .select('id', 'metadata', 'display_name');
        childChannelCache.set(parent.id, children);
      }
      const existingChildren = childChannelCache.get(parent.id)!;

      const ensureChild = async (streamIndex: number, snap: ChannelSnapshot) => {
        let child = existingChildren.find(
          (c) => (c.metadata as Record<string, unknown>)?.multi_stream_index === streamIndex,
        );
        if (child) return child;
        const childName = this.generateMultiStreamChildName(
          parent.display_name,
          snap.streamTitle ?? snap.title,
          streamIndex,
        );
        try {
          const [created] = await this.db('channels').insert({
            series_id: parent.series_id,
            platform: 'youtube',
            channel_identifier: `${parent.channel_identifier}:stream-${streamIndex}`,
            display_name: childName,
            language: parent.language,
            region: parent.region,
            tier: parent.tier,
            source: 'auto_discovered',
            is_active: true,
            metadata: JSON.stringify({
              multi_stream_parent: parent.id,
              multi_stream_index: streamIndex,
            }),
          }).returning('*');
          child = { id: created.id, metadata: created.metadata, display_name: created.display_name };
          existingChildren.push(child);
          // Also add to channelList so it gets day assignments
          channelList.push(created);
          logger.info(`[Poll] Multi-stream: auto-created child "${childName}" for parent ${parent.display_name}`);
          return child;
        } catch (err) {
          // Unique constraint — child already exists (race condition)
          const existing = await this.db('channels')
            .where('series_id', parent.series_id)
            .where('channel_identifier', `${parent.channel_identifier}:stream-${streamIndex}`)
            .first();
          if (existing) {
            child = { id: existing.id, metadata: existing.metadata, display_name: existing.display_name };
            existingChildren.push(child);
            return child;
          }
          logger.warn(`[Poll] Multi-stream: failed to create child for ${parent.display_name}`, {
            error: (err as Error).message,
          });
          return null;
        }
      };

      // Parent slot: its bound stream, or nothing this cycle.
      if (assignment.parentVideoId) {
        snapshotMap.set(key, [byId.get(assignment.parentVideoId)!]);
      } else {
        snapshotMap.set(key, []); // bound main stream missing → no row (see insert loop)
        logger.info(`[Poll] Multi-stream: ${parent.display_name} main stream absent this cycle — parent row left empty`);
      }

      // Child slots.
      for (const [streamIndex, videoId] of assignment.childAssignments) {
        const snap = byId.get(videoId)!;
        const child = await ensureChild(streamIndex, snap);
        if (!child) continue;
        const childKey = `youtube:${parent.channel_identifier.toLowerCase()}:stream-${streamIndex}`;
        snapshotMap.set(childKey, [snap]);
        if (!channelList.find((c) => c.id === child!.id)) {
          channelList.push({
            ...parent,
            id: child.id,
            channel_identifier: `${parent.channel_identifier}:stream-${streamIndex}`,
            display_name: child.display_name,
            source: 'auto_discovered',
            metadata: child.metadata,
          } as typeof parent);
        }
      }

      // Persist bindings when they changed, or periodically so a restart
      // resumes with fresh seenAt values.
      const persistedAt = Number(parentMeta.multi_stream_binding_persisted_at ?? 0);
      if (assignment.changed || nowMs - persistedAt > BIND_PERSIST_MS) {
        try {
          await this.db('channels')
            .where('id', parent.id)
            .update({
              metadata: this.db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [
                JSON.stringify({
                  multi_stream_binding: serializeBinding(assignment.bindings),
                  multi_stream_binding_persisted_at: nowMs,
                }),
              ]),
            });
        } catch (err) {
          logger.warn(`[Poll] Multi-stream: failed to persist binding for ${parent.display_name}`, {
            error: (err as Error).message,
          });
        }
      }
    }

    const insertRows: SnapshotInsertRow[] = [];
    let totalCCV = 0;

    for (const channel of channelList) {
      // Skip channels handled by relay (they write their own snapshots)
      if (relayHandlesTikTok && channel.platform === 'tiktok') continue;

      const key = `${channel.platform}:${channel.channel_identifier.toLowerCase()}`;
      const existingSnapshots = snapshotMap.get(key);

      // An explicitly EMPTY list means a bound multi-stream slot whose
      // stream is missing this cycle: write nothing rather than a zero.
      if (existingSnapshots && existingSnapshots.length === 0) continue;

      // Auto-discovered multi-stream children (channel_identifier ending in
      // ":stream-N") only get rows when their parent's auto-split fired this
      // cycle. Without a snapshot, the child is offline — skip rather than
      // synthesizing CCV=0 (which pollutes the timeline with fake zero rows
      // during periods when only the main stream is live, e.g. before the
      // alternate camera comes online or after it ends).
      if (!existingSnapshots && channel.source === 'auto_discovered') continue;

      const channelSnapshots = existingSnapshots ?? [{
        channelIdentifier: channel.channel_identifier,
        displayName: channel.channel_identifier,
        concurrentViewers: 0,
        isLive: false,
        language: null,
        gameName: null,
        title: null,
        startedAt: null,
      }];

      // Each channel's series may have multiple active broadcast days
      const days = seriesToDays.get(channel.series_id) ?? [];
      const assignedDays = channelDayMap.get(channel.id);

      for (const snap of channelSnapshots) {
        const viewers = snap.concurrentViewers ?? 0;

        // Anomaly check — drop a sample where CCV crashed >90 % (cliff)
        // or surged >5× (spike) from the previous accepted value on the
        // same (channel, stream) within the last 90 seconds. After two
        // rejections in a row, the third is accepted (real raid / host /
        // broadcast end). See ccv-anomaly-detector.ts for full reasoning.
        // Applied to YouTube and Twitch where both artefacts have been
        // observed in the wild; Steam / Kick / Soop / Chzzk / Trovo /
        // TikTok report stable platform-side CCVs and are skipped.
        if (
          (channel.platform === 'youtube' || channel.platform === 'twitch') &&
          ccvAnomalyDetector.shouldReject(channel.id, snap.streamId ?? null, viewers)
        ) {
          continue;
        }

        for (const day of days) {
          // If channel has specific day assignments, only create snapshots for those days
          if (assignedDays && assignedDays.size > 0 && !assignedDays.has(day.id)) {
            continue;
          }
          insertRows.push({
            channel_id: channel.id,
            broadcast_day_id: day.id,
            stage_id: day.stage_id,
            series_id: day.series_id,
            timestamp,
            concurrent_viewers: viewers,
            platform: channel.platform,
            language: channel.language,
            region: channel.region,
            stream_id: snap.streamId ?? null,
            // streamTitle is the per-stream field (YouTube multi-stream);
            // every other adapter reports the broadcast title in `title`.
            stream_title: snap.streamTitle ?? snap.title ?? null,
          });
        }

        totalCCV += viewers;
      }
    }

    // 8. Batch insert in a single transaction
    let snapshotsCreated = 0;
    if (insertRows.length > 0) {
      try {
        await this.db.transaction(async (trx) => {
          // Knex batch insert in chunks of 500 to avoid query size limits
          const BATCH_SIZE = 500;
          for (let i = 0; i < insertRows.length; i += BATCH_SIZE) {
            const batch = insertRows.slice(i, i + BATCH_SIZE);
            await trx('viewership_snapshots').insert(batch);
          }
        });
        snapshotsCreated = insertRows.length;
      } catch (err) {
        const errMsg = `Database insert failed: ${(err as Error).message}`;
        logger.error(`[Poll] ${errMsg}`);
        errors.push(errMsg);
      }
    }

    // 9. Track consecutive failures
    const hasResults = snapshotsCreated > 0;
    this.trackConsecutiveFailure(!hasResults);

    const duration = Date.now() - startTime;

    logger.info(
      `[Poll] Cycle complete: ${channelList.length} channels, ${totalCCV} total CCV, ${snapshotsCreated} snapshots, ${duration}ms`,
    );

    const result: PollCycleResult = {
      timestamp,
      channelsPolled: channelList.length,
      totalCCV,
      snapshotsCreated,
      errors,
      duration,
    };

    this.lastPollResult = result;
    this.lastPollTime = result.timestamp;

    // Broadcast snapshot update via WebSocket
    if (this.snapshotBroadcast && snapshotsCreated > 0) {
      try {
        this.snapshotBroadcast(result, seriesIds);
      } catch (err) {
        logger.error('[Poll] Snapshot broadcast failed', { error: (err as Error).message });
      }
    }

    // Anomaly sentry — after the cycle is fully accounted for.
    try {
      this.checkDataAnomalies(channelList, insertRows, totalCCV);
    } catch (err) {
      logger.warn('[Poll] Anomaly check failed', { error: (err as Error).message });
    }

    return result;
  }

  // ── Anomaly sentry ────────────────────────────────────────────────────

  /** Throttled data_anomaly push (10 min per anomaly key). */
  private pushAnomaly(key: string, title: string, body: string): void {
    const THROTTLE_MS = 10 * 60_000;
    const last = this.lastAnomalyPushAt.get(key) ?? 0;
    if (Date.now() - last < THROTTLE_MS) return;
    this.lastAnomalyPushAt.set(key, Date.now());
    logger.warn(`[Anomaly] ${title}: ${body}`);
    this.pushNotifier
      ?.notify('data_anomaly', { title, body, tag: `anomaly-${key}` })
      .catch((err) => logger.warn('[Anomaly] push failed', { error: (err as Error).message }));
  }

  private checkDataAnomalies(
    channelList: Channel[],
    insertRows: Array<{ channel_id: string; concurrent_viewers: number }>,
    totalCCV: number,
  ): void {
    // A. Total-CCV collapse: >40% loss in one cycle from a meaningful base.
    //    (The Jun 26 PNC crash looked exactly like this: 113k → 49k → 11k.)
    if (
      this.prevTotalCCV !== null &&
      this.prevTotalCCV >= 5000 &&
      totalCCV < this.prevTotalCCV * 0.6
    ) {
      this.pushAnomaly(
        'total-drop',
        'Total CCV dropped sharply',
        `${this.prevTotalCCV.toLocaleString()} → ${totalCCV.toLocaleString()} in one poll cycle. Possible tracking outage or broadcast crash.`,
      );
    }
    this.prevTotalCCV = totalCCV;

    // B. Official flatline: an official channel that WAS live (≥200 CCV)
    //    reports 0 for 3 consecutive cycles while its day is still live.
    const maxByChannel = new Map<string, number>();
    for (const r of insertRows) {
      maxByChannel.set(
        r.channel_id,
        Math.max(maxByChannel.get(r.channel_id) ?? 0, r.concurrent_viewers),
      );
    }
    for (const ch of channelList) {
      if (ch.tier !== 'official') continue;
      const v = maxByChannel.get(ch.id) ?? 0;
      if (v >= 200) {
        this.officialWasLive.add(ch.id);
        this.officialZeroStreak.delete(ch.id);
        continue;
      }
      if (v === 0 && this.officialWasLive.has(ch.id)) {
        const streak = (this.officialZeroStreak.get(ch.id) ?? 0) + 1;
        this.officialZeroStreak.set(ch.id, streak);
        if (streak === 3) {
          this.pushAnomaly(
            `flatline-${ch.id}`,
            'Official channel flatlined',
            `${ch.display_name} (${ch.platform}) has reported 0 viewers for 3 consecutive cycles while the broadcast day is live.`,
          );
          // Require it to come back live before it can alert again.
          this.officialWasLive.delete(ch.id);
          this.officialZeroStreak.delete(ch.id);
        }
      }
    }
  }

  // ── Consecutive failure tracking ──────────────────────────────────────

  private trackConsecutiveFailure(failed: boolean): void {
    if (failed) {
      this.consecutiveZeroResults++;
      if (this.consecutiveZeroResults >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
        logger.error(
          `[Poll] CRITICAL: ${this.consecutiveZeroResults} consecutive cycles with zero results. ` +
          `Check adapter health and database connectivity.`,
        );

        // Push fan-out — throttled to at most once per hour while stalled
        if (this.pushNotifier) {
          const now = Date.now();
          if (now - this.lastStallPushAt >= POLLING_STALL_PUSH_THROTTLE_MS) {
            this.lastStallPushAt = now;
            void this.pushNotifier
              .notify('polling_stalled', {
                title: 'Polling stalled',
                body: `${this.consecutiveZeroResults} consecutive cycles returned zero results. Check adapter health.`,
                url: '/',
                tag: 'polling_stalled',
                urgent: true,
              })
              .catch((err) => logger.warn('[Push] polling_stalled fan-out failed', { error: (err as Error).message }));
          }
        }
      }
    } else {
      if (this.consecutiveZeroResults > 0) {
        logger.info(
          `[Poll] Recovery: successful cycle after ${this.consecutiveZeroResults} consecutive failures`,
        );
      }
      this.consecutiveZeroResults = 0;
      this.lastStallPushAt = 0; // reset so the next stall re-fires immediately
    }
  }

  // ── Broadcast-ending push check ───────────────────────────────────────
  // Called from each tick. Looks for live broadcast_days whose broadcast_end
  // is between 9 and 11 minutes from now and fires `broadcast_ending` push
  // exactly once per broadcast_day_id.
  private async checkBroadcastEndingSoon(): Promise<void> {
    if (!this.pushNotifier) return;
    try {
      const now = new Date();
      const floor = new Date(now.getTime() + BROADCAST_ENDING_LOOKAHEAD_FLOOR_MIN * 60_000);
      const ceil = new Date(now.getTime() + BROADCAST_ENDING_LOOKAHEAD_MIN * 60_000);

      const ending = await this.db<BroadcastDay>('broadcast_days')
        .where('status', 'live')
        .whereNotNull('broadcast_end')
        .where('broadcast_end', '>=', floor)
        .where('broadcast_end', '<=', ceil)
        .select('id', 'series_id', 'label', 'broadcast_end');

      for (const day of ending) {
        if (this.endingNotifiedDayIds.has(day.id)) continue;
        this.endingNotifiedDayIds.add(day.id);
        await this.pushNotifier.notify('broadcast_ending', {
          title: 'Broadcast ending in ~10 min',
          body: `${day.label || 'A broadcast'} is scheduled to end soon. Extend the end time if needed.`,
          url: `/${day.series_id}`,
          tag: `broadcast-ending-${day.id}`,
          urgent: true,
        });
      }

      // Garbage-collect the in-memory set so it doesn't grow forever:
      // drop ids whose broadcast_end is more than an hour in the past.
      if (this.endingNotifiedDayIds.size > 100) {
        const cutoff = new Date(now.getTime() - 60 * 60_000);
        const stale = await this.db<BroadcastDay>('broadcast_days')
          .whereIn('id', Array.from(this.endingNotifiedDayIds))
          .andWhere('broadcast_end', '<', cutoff)
          .pluck('id');
        for (const id of stale) this.endingNotifiedDayIds.delete(id);
      }
    } catch (err) {
      logger.warn('[Push] broadcast_ending check failed', { error: (err as Error).message });
    }
  }
}
