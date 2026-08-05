import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';
import * as TikTokDiscoveredModel from '../models/tiktok-discovered-stream';
import type { TikTokDiscoveredStream } from '../models/tiktok-discovered-stream';
import { keywordMatches } from '../utils/keyword-match';

/**
 * The staged buffer is a whole CATEGORY (every live PUBG room on
 * TikTok), so unlike Twitch — whose adapter searches by game AND
 * keywords upstream — the event scoping has to happen here. Without a
 * keyword hit on title/nickname/username the room is dropped; with no
 * keywords configured at all, nothing is returned, because "every PUBG
 * stream on TikTok" is never what an event series wants to discover.
 * Exported for tests.
 */
export function selectDiscoverable(
  rows: TikTokDiscoveredStream[],
  keywords: string[] | undefined,
): TikTokDiscoveredStream[] {
  if (!keywords || keywords.length === 0) return [];
  return rows.filter((r) =>
    keywordMatches(keywords, r.title, `${r.nickname ?? ''} ${r.username}`),
  );
}

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
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    try {
      const fresh = await TikTokDiscoveredModel.freshStreams();
      const rows = selectDiscoverable(fresh, keywords);
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
      logger.debug(
        `TikTok discovery: ${streams.length}/${fresh.length} staged room(s) match keywords`,
      );
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
