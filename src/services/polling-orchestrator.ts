import type { Knex } from 'knex';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { AdapterRegistry } from '../adapters';
import type { MultiPlatformChannel } from '../adapters';
import type { ChannelSnapshot } from '../adapters/types';
import { YouTubeAdapter } from '../adapters/youtube';
import type { BroadcastDay } from '../models/broadcast-day';
import type { Channel } from '../models/channel';
import type { DiscoveryService } from './discovery-service';
import type { ReportAgent } from '../agent/report-agent';

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

  constructor(registry: AdapterRegistry, db: Knex) {
    this.registry = registry;
    this.db = db;
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

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.intervalHandle) {
      logger.warn('[Poll] Orchestrator already running — ignoring start()');
      return;
    }

    const intervalMs = config.polling.intervalMs;
    logger.info(`[Poll] Starting polling orchestrator (interval: ${intervalMs}ms)`);

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

    const insertRows: SnapshotInsertRow[] = [];
    let totalCCV = 0;

    for (const channel of channelList) {
      // Skip channels handled by relay (they write their own snapshots)
      if (relayHandlesTikTok && channel.platform === 'tiktok') continue;

      const key = `${channel.platform}:${channel.channel_identifier.toLowerCase()}`;
      const channelSnapshots = snapshotMap.get(key) ?? [{
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
            stream_title: snap.streamTitle ?? null,
          });
        }

        // Sum CCV across all streams for this channel
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

    return result;
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
      }
    } else {
      if (this.consecutiveZeroResults > 0) {
        logger.info(
          `[Poll] Recovery: successful cycle after ${this.consecutiveZeroResults} consecutive failures`,
        );
      }
      this.consecutiveZeroResults = 0;
    }
  }
}
