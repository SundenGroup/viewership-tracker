import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';
import * as TikTokDiscoveredModel from '../models/tiktok-discovered-stream';

/**
 * TikTok adapter.
 *
 * VIEWER COUNTS: stub — data arrives via the relay endpoint
 * (POST /api/relay/tiktok), pushed from the residential machine whose
 * Chrome can reach TikTok without datacenter-IP blocks.
 *
 * DISCOVERY: served from the tiktok_discovered_streams staging buffer.
 * The same residential Chrome captures TikTok's signed live-category
 * feed (tiktok.com/live/gaming/<Category> → webcast/feed) and relays
 * the rooms (scripts/tiktok-category-discovery.ts); rows fresher than
 * FRESH_WINDOW_MINUTES are treated as live-right-now. The discovery
 * pipeline applies keywords/thresholds/blocklists downstream, so this
 * adapter deliberately returns the whole fresh buffer.
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok';

  async getViewerCounts(usernames: string[]): Promise<ChannelSnapshot[]> {
    // Data comes via relay — return empty snapshots so the polling orchestrator
    // doesn't overwrite relay data with zeros.
    return [];
  }

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    try {
      const rows = await TikTokDiscoveredModel.freshStreams();
      if (rows.length === 0) return [];
      // The buffer can hold several categories; category name doubles as
      // the game name so downstream logs/UI say what the room was playing.
      const streams = rows.map((r): DiscoveredStream => ({
        // Bare username — matches how manually-added player channels are
        // stored, and discovery-service normalizes '@' on comparison.
        channelIdentifier: r.username,
        displayName: r.nickname || r.username,
        concurrentViewers: r.viewer_count,
        language: r.language,
        title: r.title ?? '',
        gameName: r.category.split('/').pop()?.replace(/_/g, ' ') ?? null,
        startedAt: null,
        streamId: r.room_id ?? undefined,
      }));
      logger.debug(`TikTok discovery: serving ${streams.length} staged room(s)`);
      return streams;
    } catch (err) {
      logger.warn(`TikTok discovery buffer read failed: ${(err as Error).message}`);
      return [];
    }
  }

  async shutdown(): Promise<void> {
    // No resources to clean up
  }
}
