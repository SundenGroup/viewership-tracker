/**
 * NimoTV Adapter — scrapes live viewer counts from nimo.tv channel pages.
 *
 * NimoTV embeds stream metadata (including viewer count) in a `G_roomBaseInfo`
 * JavaScript object in the page HTML. Simple HTTP GET + JSON parse — no API key,
 * no quota, no browser needed.
 *
 * Used primarily for Vietnamese PUBG streams (PUBGVN channel).
 */

import axios, { AxiosInstance } from 'axios';
import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

const SCRAPE_TIMEOUT_MS = 8_000;
const SCRAPE_CONCURRENCY = 5;

interface NimoRoomInfo {
  roomId?: number;
  viewerNum?: number;
  liveStreamStatus?: number; // 0 = offline, 1 = live
  title?: string;
  nickname?: string;
  gameName?: string;
  language?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export class NimoTVAdapter implements PlatformAdapter {
  readonly platform = 'nimotv';

  private readonly scraper: AxiosInstance;

  constructor() {
    this.scraper = axios.create({
      timeout: SCRAPE_TIMEOUT_MS,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
    });
  }

  // ── getViewerCounts ──────────────────────────────────────────────────

  async getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]> {
    const results: ChannelSnapshot[] = [];
    const batches = chunk(channelIdentifiers, SCRAPE_CONCURRENCY);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((slug) => this.scrapeChannel(slug)),
      );
      results.push(...batchResults);

      // Small delay between batches to be respectful
      if (batches.length > 1) await sleep(200);
    }

    const liveCount = results.filter((r) => r.isLive).length;
    logger.debug(`NimoTV getViewerCounts: ${liveCount}/${channelIdentifiers.length} live`);

    return results;
  }

  // ── scrapeChannel ────────────────────────────────────────────────────

  private async scrapeChannel(slug: string): Promise<ChannelSnapshot> {
    const offline: ChannelSnapshot = {
      channelIdentifier: slug,
      displayName: slug,
      concurrentViewers: 0,
      isLive: false,
      language: null,
      gameName: null,
      title: null,
      startedAt: null,
    };

    try {
      const url = `https://www.nimo.tv/${slug}`;
      const { data: html } = await this.scraper.get<string>(url, {
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      if (typeof html !== 'string') return offline;

      // Extract G_roomBaseInfo JSON object from the page
      const roomInfo = this.extractRoomInfo(html);
      if (!roomInfo) {
        logger.debug(`NimoTV: could not extract G_roomBaseInfo for ${slug}`);
        return offline;
      }

      // Check if live (liveStreamStatus: 1 = live, 0 = offline)
      const isLive = roomInfo.liveStreamStatus === 1;
      if (!isLive) return offline;

      return {
        channelIdentifier: slug,
        displayName: roomInfo.nickname ?? slug,
        concurrentViewers: roomInfo.viewerNum ?? 0,
        isLive: true,
        language: roomInfo.language ?? null,
        gameName: roomInfo.gameName ?? null,
        title: roomInfo.title ?? null,
        startedAt: null,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('timeout') || msg.includes('ECONNRESET')) {
        logger.debug(`NimoTV: scrape timed out for ${slug}`);
      } else {
        logger.warn(`NimoTV: scrape failed for ${slug}`, { error: msg });
      }
      return offline;
    }
  }

  // ── extractRoomInfo ──────────────────────────────────────────────────

  private extractRoomInfo(html: string): NimoRoomInfo | null {
    // Strategy 1: Parse G_roomBaseInfo JSON object
    const match = html.match(/G_roomBaseInfo\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try {
        return JSON.parse(match[1]) as NimoRoomInfo;
      } catch {
        // JSON parse failed, try regex fallback
      }
    }

    // Strategy 2: Extract individual fields via regex
    const viewerMatch = html.match(/"viewerNum"\s*:\s*(\d+)/);
    const statusMatch = html.match(/"liveStreamStatus"\s*:\s*(\d+)/);
    const titleMatch = html.match(/"title"\s*:\s*"([^"]+)"/);
    const nicknameMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);

    if (viewerMatch && statusMatch) {
      return {
        viewerNum: parseInt(viewerMatch[1], 10),
        liveStreamStatus: parseInt(statusMatch[1], 10),
        title: titleMatch?.[1] ?? undefined,
        nickname: nicknameMatch?.[1] ?? undefined,
      };
    }

    return null;
  }

  // ── searchLiveStreams ─────────────────────────────────────────────────

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
    _categoryIds?: string[],
  ): Promise<DiscoveredStream[]> {
    // NimoTV has no public search API — discovery not supported.
    // Channels must be added manually.
    return [];
  }
}
