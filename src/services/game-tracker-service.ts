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
import axios from 'axios';
import type { Knex } from 'knex';
import logger from '../utils/logger';
import type { AdapterRegistry } from '../adapters';
import type { TwitchAdapter } from '../adapters/twitch';
import type { KickAdapter } from '../adapters/kick';
import type { DiscoveredStream } from '../adapters/types';

type TrackedPlatform = 'twitch' | 'kick';

interface PlatformStream {
  platform: TrackedPlatform;
  stream: DiscoveredStream;
}
import * as GameTrackerModel from '../models/game-tracker';
import * as GameTrackerChannelModel from '../models/game-tracker-channel';
import * as GameTrackerSnapshotModel from '../models/game-tracker-snapshot';
import * as StreamSessionModel from '../models/stream-session';
import * as ChannelFollowerSnapshotModel from '../models/channel-follower-snapshot';
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
    const liveStreams: PlatformStream[] = [];

    // Twitch + Kick run in parallel; either platform can be left
    // unconfigured (null game/category id = skip this platform).
    const fetches: Array<Promise<void>> = [];
    if (tracker.twitch_game_id) {
      fetches.push(
        (async () => {
          try {
            const twitch = this.registry.getAdapter('twitch') as TwitchAdapter;
            const streams = await twitch.searchLiveStreams(tracker.twitch_game_id!);
            for (const s of streams) {
              liveStreams.push({
                platform: 'twitch',
                stream: { ...s, gameName: s.gameName ?? tracker.twitch_game_name },
              });
            }
          } catch (err) {
            logger.warn(`[GameTracker:${slug}] Twitch fetch failed`, {
              error: (err as Error).message,
            });
          }
        })(),
      );
    }
    if (tracker.kick_category_id) {
      fetches.push(
        (async () => {
          try {
            const kick = this.registry.getAdapter('kick') as KickAdapter;
            const streams = await kick.searchLiveStreams(String(tracker.kick_category_id));
            for (const s of streams) {
              liveStreams.push({
                platform: 'kick',
                stream: { ...s, gameName: s.gameName ?? tracker.kick_category_slug ?? null },
              });
            }
          } catch (err) {
            logger.warn(`[GameTracker:${slug}] Kick fetch failed`, {
              error: (err as Error).message,
            });
          }
        })(),
      );
    }
    await Promise.all(fetches);

    // Cap at max_active_channels to protect against runaway growth. Sort
    // by CCV across platforms so the top of each tracker's set is the
    // platform-agnostic top streams.
    const eligible = liveStreams
      .filter((p) => p.stream.concurrentViewers >= tracker.min_ccv_threshold)
      .sort((a, b) => b.stream.concurrentViewers - a.stream.concurrentViewers)
      .slice(0, tracker.max_active_channels);

    const cycleTimestamp = new Date();

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

    // Bulk-load existing channels matching this cycle's identifiers,
    // grouped by platform.
    const identifiersByPlatform = new Map<TrackedPlatform, string[]>();
    for (const p of eligible) {
      const list = identifiersByPlatform.get(p.platform) ?? [];
      list.push(p.stream.channelIdentifier.toLowerCase());
      identifiersByPlatform.set(p.platform, list);
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

    for (const { platform, stream } of eligible) {
      const key = this.channelKey(platform, stream.channelIdentifier);
      let channel = existingChannels.get(key);

      // Insert a new channels row for previously-unseen streamers.
      // channels.series_id is NOT NULL today, so we lazily mint a stub
      // series per tracker (see ensureBoundSeries) to satisfy the
      // constraint without polluting the tournament UI.
      if (!channel) {
        const seriesId = await this.ensureBoundSeries(tracker);
        try {
          const [created] = await this.db('channels')
            .insert({
              series_id: seriesId,
              platform,
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
            .where('platform', platform)
            .whereRaw('LOWER(channel_identifier) = ?', [stream.channelIdentifier.toLowerCase()])
            .first();
          if (!refetch) {
            logger.warn(
              `[GameTracker:${slug}] failed to insert/find ${platform} channel for ${stream.channelIdentifier}`,
              { error: (err as Error).message },
            );
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
        platform,
        language: stream.language ? stream.language.split('-')[0].toLowerCase() : null,
        region: null,
        stream_id: stream.streamId ?? null,
        stream_title: stream.title ?? null,
        game_name:
          stream.gameName ??
          (platform === 'twitch'
            ? tracker.twitch_game_name
            : tracker.kick_category_slug) ??
          null,
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

    // ── Follower polling (throttled; must never break polling) ────────
    // Runs before the session upsert so a channel's very first session
    // row can capture followers_start from a same-cycle snapshot.
    await this.pollFollowersSafe(slug, eligible, existingChannels);

    // ── Stream session lifecycle (upsert live rows, close stale) ──────
    await this.updateStreamSessionsSafe(slug, tracker.id, snapshotsToInsert);

    // ── Cache streamer profile pics on first sighting ─────────────────
    // Twitch only — Kick's public API doesn't expose user profile pics
    // without scraping their unauthenticated v2 endpoint. Initials
    // fallback handles Kick streamers in the leaderboard.
    await this.refreshProfilePics(eligible, existingChannels);

    result.durationMs = Date.now() - start;
    this.lastResults.set(trackerId, result);

    logger.info(
      `[GameTracker:${slug}] cycle: ${result.snapshotsWritten} snapshots, ` +
        `${result.newChannels} new, ${result.resurfacedChannels} resurfaced, ` +
        `${result.bumpedMismatch} bumped, ${result.dropped} dropped (${result.durationMs}ms)`,
    );
    return result;
  }

  /**
   * For every Twitch channel in this cycle that's missing a cached
   * profile picture in metadata, batch-fetch via Helix /users and
   * persist. Existing pics are left alone — they almost never change
   * and refetching every cycle would burn Helix budget unnecessarily.
   */
  private async refreshProfilePics(
    streams: PlatformStream[],
    channelMap: Map<string, import('../models/channel').Channel>,
  ): Promise<void> {
    type Ch = import('../models/channel').Channel;
    const twitchNeed: Array<{ login: string; channel: Ch }> = [];
    const kickNeed: Array<{ slug: string; channel: Ch }> = [];
    for (const { platform, stream } of streams) {
      const ch = channelMap.get(this.channelKey(platform, stream.channelIdentifier));
      if (!ch) continue;
      const meta = (ch.metadata as Record<string, unknown>) ?? {};
      if (typeof meta.profile_image_url === 'string' && meta.profile_image_url.length > 0) continue;
      if (platform === 'twitch') twitchNeed.push({ login: stream.channelIdentifier, channel: ch });
      else if (platform === 'kick') kickNeed.push({ slug: stream.channelIdentifier, channel: ch });
    }

    const persist = async (channel: Ch, patch: Record<string, unknown>) => {
      const updated = { ...(channel.metadata as Record<string, unknown>), ...patch };
      await this.db('channels').where('id', channel.id).update({ metadata: JSON.stringify(updated) });
      channel.metadata = updated; // keep in-memory copy fresh for this cycle
    };

    // Twitch — Helix /users
    if (twitchNeed.length > 0) {
      try {
        const twitch = this.registry.getAdapter('twitch') as TwitchAdapter;
        const profiles = await twitch.getUsersByLogin(twitchNeed.map((n) => n.login));
        const byLogin = new Map<string, (typeof profiles)[number]>();
        for (const p of profiles) byLogin.set(p.login.toLowerCase(), p);
        for (const { login, channel } of twitchNeed) {
          const p = byLogin.get(login.toLowerCase());
          if (!p) continue;
          await persist(channel, { profile_image_url: p.profileImageUrl, twitch_display_name: p.displayName });
        }
        logger.debug(`[GameTracker] cached twitch pics for ${profiles.length}/${twitchNeed.length}`);
      } catch (err) {
        logger.warn('[GameTracker] twitch profile pic fetch failed', { error: (err as Error).message });
      }
    }

    // Kick — official API (channels → broadcaster_user_id → users → profile_picture)
    if (kickNeed.length > 0) {
      try {
        const kick = this.registry.getAdapter('kick') as KickAdapter;
        const pics = await kick.getProfilePics(kickNeed.map((n) => n.slug));
        let n = 0;
        for (const { slug, channel } of kickNeed) {
          const url = pics.get(slug.toLowerCase());
          if (!url) continue;
          await persist(channel, { profile_image_url: url });
          n++;
        }
        logger.debug(`[GameTracker] cached kick pics for ${n}/${kickNeed.length}`);
      } catch (err) {
        logger.warn('[GameTracker] kick profile pic fetch failed', { error: (err as Error).message });
      }
    }
  }

  // ── Stream sessions ───────────────────────────────────────────────────

  /**
   * Promote this cycle's snapshots into stream_sessions: upsert a live
   * row per (channel, stream_id) sighting, then close sessions silent
   * for >10 minutes and compute their finals. Wrapped so a session bug
   * can never take down snapshot polling.
   */
  private async updateStreamSessionsSafe(
    slug: string,
    trackerId: string,
    snapshots: GameTrackerSnapshotModel.InsertSnapshot[],
  ): Promise<void> {
    try {
      const withStream = snapshots.filter((s) => s.stream_id);
      if (withStream.length > 0) {
        await StreamSessionModel.upsertLiveBatch(
          withStream.map((s) => ({
            game_tracker_id: s.game_tracker_id,
            channel_id: s.channel_id,
            stream_id: s.stream_id as string,
            timestamp: s.timestamp,
            concurrent_viewers: s.concurrent_viewers,
            stream_title: s.stream_title ?? null,
            game_name: s.game_name ?? null,
            started_at: s.started_at ?? null,
          })),
        );
      }
      const closedIds = await StreamSessionModel.closeStale(trackerId);
      if (closedIds.length > 0) {
        await StreamSessionModel.finalizeSessions(closedIds);
        logger.info(`[GameTracker:${slug}] closed ${closedIds.length} stream session(s)`);
      }
    } catch (err) {
      logger.warn(`[GameTracker:${slug}] stream session pass failed`, {
        error: (err as Error).message,
      });
    }
  }

  // ── Follower polling ──────────────────────────────────────────────────

  private static readonly FOLLOWER_TOP_N = 150;
  private static readonly FOLLOWER_REFRESH_MS = 10 * 60_000;
  private static readonly FOLLOWER_FETCH_CONCURRENCY = 8;
  /** channel_id → epoch ms of the last follower fetch (in-memory throttle). */
  private readonly followerLastFetched = new Map<string, number>();

  private async pollFollowersSafe(
    slug: string,
    streams: PlatformStream[],
    channelMap: Map<string, Channel>,
  ): Promise<void> {
    if (process.env.GT_FOLLOWERS === '0') return; // kill switch (default on)
    try {
      await this.pollFollowers(slug, streams, channelMap);
    } catch (err) {
      logger.warn(`[GameTracker:${slug}] follower pass failed`, {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Fetch follower counts for the top live channels of this cycle (by
   * current CCV), at most once per 10 minutes per channel. Kick uses
   * the unofficial v2 channel endpoint (may 403 from datacenter IPs —
   * skip silently, log a per-cycle failure count). Twitch resolves
   * broadcaster ids via Helix /users (cached in
   * channels.metadata.twitch_user_id), then reads the followers total.
   */
  private async pollFollowers(
    slug: string,
    streams: PlatformStream[],
    channelMap: Map<string, Channel>,
  ): Promise<void> {
    // `streams` arrives CCV-sorted desc (see runCycle) — top N is a slice.
    const now = Date.now();
    const due: Array<{ platform: TrackedPlatform; identifier: string; channel: Channel }> = [];
    for (const { platform, stream } of streams.slice(0, GameTrackerService.FOLLOWER_TOP_N)) {
      const channel = channelMap.get(this.channelKey(platform, stream.channelIdentifier));
      if (!channel || due.some((d) => d.channel.id === channel.id)) continue;
      const last = this.followerLastFetched.get(channel.id);
      if (last !== undefined && now - last < GameTrackerService.FOLLOWER_REFRESH_MS) continue;
      // Mark up front so an overlapping cycle can't double-fetch.
      this.followerLastFetched.set(channel.id, now);
      due.push({ platform, identifier: stream.channelIdentifier, channel });
    }
    if (due.length === 0) return;

    const rows: ChannelFollowerSnapshotModel.ChannelFollowerSnapshot[] = [];
    const ts = new Date();

    // Kick — one call per channel, small parallel batches.
    const kickDue = due.filter((d) => d.platform === 'kick');
    let kickFailures = 0;
    for (const batch of chunkArray(kickDue, GameTrackerService.FOLLOWER_FETCH_CONCURRENCY)) {
      await Promise.all(
        batch.map(async ({ identifier, channel }) => {
          const followers = await this.fetchKickFollowers(identifier);
          if (followers === null) {
            kickFailures++;
            return;
          }
          rows.push({ channel_id: channel.id, ts, followers });
        }),
      );
    }
    if (kickFailures > 0) {
      logger.info(
        `[GameTracker:${slug}] follower pass: ${kickFailures}/${kickDue.length} kick fetches failed (endpoint may block datacenter IPs)`,
      );
    }

    // Twitch — resolve broadcaster ids in batch, then Helix followers total.
    const twitchDue = due.filter((d) => d.platform === 'twitch');
    if (twitchDue.length > 0) {
      try {
        const twitch = this.registry.getAdapter('twitch') as TwitchAdapter;
        const idByChannel = await this.resolveTwitchUserIds(twitch, twitchDue);
        for (const batch of chunkArray(twitchDue, GameTrackerService.FOLLOWER_FETCH_CONCURRENCY)) {
          await Promise.all(
            batch.map(async ({ channel }) => {
              const broadcasterId = idByChannel.get(channel.id);
              if (!broadcasterId) return;
              const total = await twitch.getChannelFollowerTotal(broadcasterId);
              if (total === null) return;
              rows.push({ channel_id: channel.id, ts, followers: total });
            }),
          );
        }
      } catch (err) {
        logger.warn(`[GameTracker:${slug}] twitch follower fetch failed`, {
          error: (err as Error).message,
        });
      }
    }

    if (rows.length > 0) {
      await ChannelFollowerSnapshotModel.insertMany(rows);
      logger.debug(`[GameTracker:${slug}] follower pass: stored ${rows.length}/${due.length} counts`);
    }
  }

  /** kick.com/api/v2/channels/{slug} → followers_count. Null on any failure. */
  private async fetchKickFollowers(slug: string): Promise<number | null> {
    try {
      const { data } = await axios.get<{ followers_count?: number }>(
        `https://kick.com/api/v2/channels/${encodeURIComponent(slug.toLowerCase())}`,
        {
          timeout: 8_000,
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
        },
      );
      return typeof data?.followers_count === 'number' ? data.followers_count : null;
    } catch {
      return null; // 403s expected from datacenter IPs — counted by caller
    }
  }

  /**
   * channel_id → Twitch broadcaster id for a set of due channels, using
   * channels.metadata.twitch_user_id and resolving + caching missing
   * ids via Helix /users (login → id).
   */
  private async resolveTwitchUserIds(
    twitch: TwitchAdapter,
    due: Array<{ identifier: string; channel: Channel }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const need: Array<{ login: string; channel: Channel }> = [];
    for (const { identifier, channel } of due) {
      const meta = (channel.metadata as Record<string, unknown>) ?? {};
      if (typeof meta.twitch_user_id === 'string' && meta.twitch_user_id.length > 0) {
        out.set(channel.id, meta.twitch_user_id);
      } else {
        need.push({ login: identifier, channel });
      }
    }
    if (need.length === 0) return out;

    const profiles = await twitch.getUsersByLogin(need.map((n) => n.login));
    const byLogin = new Map(profiles.map((p) => [p.login.toLowerCase(), p]));
    for (const { login, channel } of need) {
      const profile = byLogin.get(login.toLowerCase());
      if (!profile) continue;
      out.set(channel.id, profile.id);
      const updated = { ...(channel.metadata as Record<string, unknown>), twitch_user_id: profile.id };
      await this.db('channels').where('id', channel.id).update({ metadata: JSON.stringify(updated) });
      channel.metadata = updated; // keep in-memory copy fresh for this cycle
    }
    return out;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private channelKey(platform: string, identifier: string): string {
    return `${platform}:${identifier.toLowerCase()}`;
  }

  /**
   * channels.series_id is NOT NULL today. Game-tracker-managed channels
   * don't belong to a tournament, so we lazily create one stub series
   * per tracker and reuse its id. Identified by metadata.is_game_tracker_stub.
   * The stub never appears in the tournament UI (the /api/series list
   * filters out is_game_tracker_stub).
   *
   * Race protection: 100+ channels in the first cycle of a fresh
   * tracker would all hit this method with the same in-memory tracker
   * snapshot (metadata.bound_series_id unset), each spawning a stub
   * row. Two layers of dedup now:
   *   1. A per-process Map<trackerId, Promise<seriesId>> so concurrent
   *      callers within one cycle await the same insert.
   *   2. Persisted DB lookup by metadata short_name (gt-<slug>) before
   *      inserting, so even across processes / restarts we'd reuse an
   *      existing stub.
   * After resolving, the result is mirrored back into tracker.metadata
   * (in-memory + DB) so subsequent cycles short-circuit on the cheap
   * field check.
   */
  private boundSeriesCache = new Map<string, string>();
  private boundSeriesPending = new Map<string, Promise<string>>();

  private async ensureBoundSeries(tracker: GameTrackerModel.GameTracker): Promise<string> {
    const cached = this.boundSeriesCache.get(tracker.id);
    if (cached) return cached;
    const stored = (tracker.metadata as Record<string, unknown>)?.bound_series_id;
    if (typeof stored === 'string' && stored.length > 0) {
      this.boundSeriesCache.set(tracker.id, stored);
      return stored;
    }

    const inflight = this.boundSeriesPending.get(tracker.id);
    if (inflight) return inflight;

    const promise = (async () => {
      const stubShortName = `gt-${tracker.slug}`;
      // First: see if a stub already exists for this tracker (e.g. from
      // a previous deploy / pod). Reuse it.
      const existing = await this.db('tournament_series')
        .where('short_name', stubShortName)
        .where(this.db.raw(`metadata->>'is_game_tracker_stub' = 'true'`))
        .select('id')
        .first();
      let seriesId: string;
      if (existing) {
        seriesId = existing.id as string;
      } else {
        const [created] = await this.db('tournament_series')
          .insert({
            name: `[game-tracker] ${tracker.name}`,
            short_name: stubShortName,
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
        seriesId = created.id as string;
      }

      // Mirror back to tracker.metadata so subsequent cycles avoid the
      // DB roundtrip entirely. Mutate the passed-in tracker too so
      // remaining iterations of THIS cycle see it.
      const nextMeta = { ...tracker.metadata, bound_series_id: seriesId };
      await GameTrackerModel.update(tracker.id, { metadata: nextMeta });
      tracker.metadata = nextMeta;
      this.boundSeriesCache.set(tracker.id, seriesId);
      return seriesId;
    })();
    this.boundSeriesPending.set(tracker.id, promise);
    try {
      return await promise;
    } finally {
      this.boundSeriesPending.delete(tracker.id);
    }
  }
}

// ── Module helpers ────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
