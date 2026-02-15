export type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';
export { TwitchAdapter } from './twitch';
export { YouTubeAdapter } from './youtube';
export { KickAdapter } from './kick';
export { TikTokAdapter } from './tiktok';
export type { QuotaUsage } from './youtube';

import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot } from './types';
import { TwitchAdapter } from './twitch';
import { YouTubeAdapter } from './youtube';
import { KickAdapter } from './kick';
import { TikTokAdapter } from './tiktok';

// ── Types ────────────────────────────────────────────────────────────────

export type PlatformName = 'twitch' | 'youtube' | 'kick' | 'tiktok';

export interface MultiPlatformChannel {
  platform: PlatformName;
  channelIdentifier: string;
}

export interface PlatformHealthStatus {
  platform: string;
  available: boolean;
}

// ── AdapterRegistry ──────────────────────────────────────────────────────

export class AdapterRegistry {
  private adapters = new Map<PlatformName, PlatformAdapter>();

  /**
   * Returns the adapter for the given platform, creating it lazily on first request.
   */
  getAdapter(platform: PlatformName): PlatformAdapter {
    const existing = this.adapters.get(platform);
    if (existing) return existing;

    const adapter = this.createAdapter(platform);
    this.adapters.set(platform, adapter);
    logger.info(`AdapterRegistry: initialized ${platform} adapter`);
    return adapter;
  }

  private createAdapter(platform: PlatformName): PlatformAdapter {
    switch (platform) {
      case 'twitch':
        return new TwitchAdapter();
      case 'youtube':
        return new YouTubeAdapter();
      case 'kick':
        return new KickAdapter();
      case 'tiktok':
        return new TikTokAdapter();
      default: {
        const _exhaustive: never = platform;
        throw new Error(`Unknown platform: ${_exhaustive}`);
      }
    }
  }

  /**
   * Fetches viewer counts across multiple platforms in parallel.
   *
   * Groups the input by platform, calls each adapter concurrently,
   * and merges results into a single flat array. If any adapter fails,
   * channels for that platform are returned as offline (partial success).
   */
  async getViewerCountsMultiPlatform(
    channels: MultiPlatformChannel[],
  ): Promise<ChannelSnapshot[]> {
    if (channels.length === 0) return [];

    // Group channels by platform
    const grouped = new Map<PlatformName, string[]>();
    for (const ch of channels) {
      const list = grouped.get(ch.platform) ?? [];
      list.push(ch.channelIdentifier);
      grouped.set(ch.platform, list);
    }

    // Call each platform adapter in parallel
    const platformPromises = Array.from(grouped.entries()).map(
      async ([platform, identifiers]): Promise<{ platform: PlatformName; results: ChannelSnapshot[] }> => {
        try {
          const adapter = this.getAdapter(platform);
          const results = await adapter.getViewerCounts(identifiers);
          return { platform, results };
        } catch (err) {
          logger.error(`AdapterRegistry: ${platform} adapter threw during getViewerCounts`, {
            error: (err as Error).message,
            channelCount: identifiers.length,
          });

          // Return offline snapshots for all channels on this platform
          const offlineResults: ChannelSnapshot[] = identifiers.map((id) => ({
            channelIdentifier: id,
            displayName: id,
            concurrentViewers: 0,
            isLive: false,
            language: null,
            gameName: null,
            title: null,
            startedAt: null,
          }));
          return { platform, results: offlineResults };
        }
      },
    );

    const settled = await Promise.all(platformPromises);

    // Build a lookup: platform+channelIdentifier → ChannelSnapshot
    const resultMap = new Map<string, ChannelSnapshot>();
    for (const { platform, results } of settled) {
      for (const snapshot of results) {
        resultMap.set(`${platform}:${snapshot.channelIdentifier}`, snapshot);
      }
    }

    // Return results in the same order as the input
    return channels.map((ch) => {
      const key = `${ch.platform}:${ch.channelIdentifier}`;
      return resultMap.get(key) ?? {
        channelIdentifier: ch.channelIdentifier,
        displayName: ch.channelIdentifier,
        concurrentViewers: 0,
        isLive: false,
        language: null,
        gameName: null,
        title: null,
        startedAt: null,
      };
    });
  }

  /**
   * Checks availability of all initialized adapters.
   *
   * For Kick, calls isAPIAvailable(). For others, performs a lightweight
   * getViewerCounts with a known channel to verify connectivity.
   */
  async healthCheck(): Promise<PlatformHealthStatus[]> {
    const platforms: PlatformName[] = ['twitch', 'youtube', 'kick', 'tiktok'];

    const checks = platforms.map(async (platform): Promise<PlatformHealthStatus> => {
      try {
        const adapter = this.getAdapter(platform);

        if (platform === 'kick') {
          const kickAdapter = adapter as KickAdapter;
          const available = await kickAdapter.isAPIAvailable();
          return { platform, available };
        }

        // For other platforms: try a lightweight call with a known channel
        const testChannels: Record<PlatformName, string> = {
          twitch: 'twitch',
          youtube: 'UCYfdidRxbB8Qhf0Nx7ioOYw', // YouTube "NBC News" — always exists
          kick: '', // handled above
          tiktok: 'tiktok',
        };

        const results = await adapter.getViewerCounts([testChannels[platform]]);
        // If we get a result back (even offline), the API is reachable
        const available = results.length === 1 && typeof results[0].isLive === 'boolean';
        return { platform, available };
      } catch (err) {
        logger.warn(`AdapterRegistry: health check failed for ${platform}`, {
          error: (err as Error).message,
        });
        return { platform, available: false };
      }
    });

    return Promise.all(checks);
  }

  /**
   * Cleanly shuts down all initialized adapters.
   * Currently only TikTok requires explicit shutdown (browser pool).
   */
  async shutdown(): Promise<void> {
    const tiktokAdapter = this.adapters.get('tiktok');
    if (tiktokAdapter) {
      logger.info('AdapterRegistry: shutting down TikTok adapter');
      await (tiktokAdapter as TikTokAdapter).shutdown();
    }

    this.adapters.clear();
    logger.info('AdapterRegistry: all adapters shut down');
  }
}
