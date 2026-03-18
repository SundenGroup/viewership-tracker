import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

/**
 * TikTok adapter — stub that returns offline for all channels.
 *
 * Actual data comes via the relay endpoint (POST /api/relay/tiktok),
 * pushed from a residential Mac that can reach TikTok's API without
 * data-center IP blocks.
 *
 * The relay script uses tiktok-live-connector to fetch room info and
 * POSTs viewer counts to the server every 60 seconds.
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok';

  async getViewerCounts(usernames: string[]): Promise<ChannelSnapshot[]> {
    // Data comes via relay — return empty snapshots so the polling orchestrator
    // doesn't overwrite relay data with zeros.
    // Return nothing — the orchestrator will skip creating snapshots for this platform.
    return [];
  }

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    logger.debug('TikTok: discovery not supported (no public search API)');
    return [];
  }

  async shutdown(): Promise<void> {
    // No resources to clean up
  }
}
