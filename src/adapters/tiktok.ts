import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

/**
 * TikTok adapter using tiktok-live-connector (WebSocket-based).
 *
 * No browser needed — connects directly to TikTok's Webcast API
 * to fetch room info including viewer counts.
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok';

  // ── Single channel fetch ───────────────────────────────────────────────

  private async fetchRoomInfo(username: string): Promise<ChannelSnapshot> {
    const offlineResult: ChannelSnapshot = {
      channelIdentifier: username,
      displayName: username,
      concurrentViewers: 0,
      isLive: false,
      language: null,
      gameName: null,
      title: null,
      startedAt: null,
    };

    try {
      // Dynamic import — the package is CJS
      const { WebcastPushConnection } = await import('tiktok-live-connector');

      const connection = new WebcastPushConnection(username.replace(/^@/, ''), {
        fetchRoomInfoOnConnect: false,
        enableExtendedGiftInfo: false,
      });

      // Only fetch room info via HTTP — no WebSocket needed for viewer counts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const roomInfo = await connection.fetchRoomInfo() as Record<string, any>;
      const data = roomInfo?.data;

      if (!data) {
        return offlineResult;
      }

      const viewerCount = data.user_count ?? 0;
      const title = data.title || null;
      const displayName = data.owner?.nickname || username;
      const createTime = data.create_time ? new Date(data.create_time * 1000).toISOString() : null;

      return {
        channelIdentifier: username,
        displayName,
        concurrentViewers: viewerCount,
        isLive: true,
        language: null,
        gameName: null,
        title,
        startedAt: createTime,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);

      // UserOfflineError means the user is not currently live
      if (
        message.includes('offline') ||
        message.includes('UserOffline') ||
        message.includes('not found') ||
        (err as Error).constructor?.name === 'UserOfflineError'
      ) {
        logger.debug(`TikTok: "${username}" is not live`);
        return offlineResult;
      }

      logger.warn(`TikTok: error fetching "${username}"`, { error: message });
      return offlineResult;
    }
  }

  // ── Core methods (PlatformAdapter) ────────────────────────────────────

  async getViewerCounts(usernames: string[]): Promise<ChannelSnapshot[]> {
    if (usernames.length === 0) return [];

    // Fetch all channels concurrently (each creates its own short-lived WebSocket)
    const results = await Promise.all(
      usernames.map((username) => this.fetchRoomInfo(username))
    );

    const liveCount = results.filter((r) => r.isLive).length;
    logger.debug(`TikTok getViewerCounts: ${liveCount}/${usernames.length} live`);
    return results;
  }

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    // TikTok has no public search API — discovery requires manual channel input
    logger.debug('TikTok: discovery not supported (no public search API)');
    return [];
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    logger.info('TikTok: shutdown (no persistent resources to clean up)');
  }
}
