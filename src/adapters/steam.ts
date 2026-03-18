import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

const STEAM_API_BASE = 'https://api.steampowered.com';
const STEAM_COMMUNITY_BASE = 'https://steamcommunity.com';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const PLAYER_SUMMARIES_BATCH = 100; // Steam API limit

// Steam64 ID: 17-digit number starting with 7656119
const STEAM64_ID_RE = /^7656119\d{10}$/;

// ── Types ────────────────────────────────────────────────────────────────

interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
}

interface SteamBroadcastViewerStats {
  response?: {
    viewer_stats?: Array<{
      count_viewers: number;
      time: number;
    }>;
  };
}

interface SteamBroadcastUploadStats {
  response?: {
    upload_stats?: Array<{
      upload_id: string;
      upload_result: number;
      duration: number;
      viewer_count: number;
      resolution_x: number;
      resolution_y: number;
    }>;
  };
}

// ── SteamAdapter ─────────────────────────────────────────────────────────

export class SteamAdapter implements PlatformAdapter {
  readonly platform = 'steam';

  private readonly apiKey: string;
  private readonly client: AxiosInstance;
  private readonly scraper: AxiosInstance;
  private readonly vanityCache = new Map<string, string>(); // vanity → steam64
  private readonly nameCache = new Map<string, string>(); // steam64 → personaName

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.steam.apiKey;

    this.client = axios.create({
      baseURL: STEAM_API_BASE,
      timeout: 10_000,
    });

    this.scraper = axios.create({
      timeout: 10_000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  }

  // ── PlatformAdapter: getViewerCounts ──────────────────────────────────

  async getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]> {
    if (channelIdentifiers.length === 0) return [];

    // 1. Resolve all identifiers to Steam64 IDs
    const resolved = await Promise.all(
      channelIdentifiers.map(async (id) => ({
        original: id,
        steam64: await this.resolveToSteam64(id),
      })),
    );

    // 2. Batch-fetch display names for resolved IDs
    const steam64Ids = resolved
      .map((r) => r.steam64)
      .filter((id): id is string => id !== null);
    if (steam64Ids.length > 0) {
      await this.batchFetchDisplayNames(steam64Ids);
    }

    // 3. Fetch broadcast data for each channel
    const results: ChannelSnapshot[] = [];
    for (const { original, steam64 } of resolved) {
      if (!steam64) {
        logger.warn('[Steam] Could not resolve identifier', { identifier: original });
        results.push(this.offlineSnapshot(original));
        continue;
      }

      const displayName = this.nameCache.get(steam64) ?? original;

      try {
        const broadcastData = await this.fetchBroadcastData(steam64);
        if (broadcastData && broadcastData.isLive) {
          results.push({
            channelIdentifier: original,
            displayName,
            concurrentViewers: broadcastData.viewers,
            isLive: true,
            language: null,
            gameName: broadcastData.gameName,
            title: broadcastData.title,
            startedAt: null,
          });
        } else {
          results.push(this.offlineSnapshot(original, displayName));
        }
      } catch (err) {
        logger.warn('[Steam] Error fetching broadcast data', {
          steamId: steam64,
          error: (err as Error).message,
        });
        results.push(this.offlineSnapshot(original, displayName));
      }
    }

    return results;
  }

  // ── PlatformAdapter: searchLiveStreams ─────────────────────────────────

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    logger.debug('[Steam] Discovery not supported — no public search API');
    return [];
  }

  // ── Private: Broadcast data fetching (multi-strategy) ─────────────────

  /**
   * Attempts to get broadcast viewer data via multiple strategies:
   * 1. getbroadcastmpd public endpoint (most reliable, no auth needed)
   * 2. IBroadcastService API (requires Publisher key)
   * 3. Steam Community broadcast page scraping (last resort)
   */
  private async fetchBroadcastData(
    steamId: string,
  ): Promise<{ isLive: boolean; viewers: number; title: string | null; gameName: string | null } | null> {
    // Strategy A: Public getbroadcastmpd endpoint (no API key required)
    const mpdResult = await this.tryBroadcastMPD(steamId);
    if (mpdResult) return mpdResult;

    // Strategy B: Try the broadcast API (requires Publisher key)
    const apiResult = await this.tryBroadcastAPI(steamId);
    if (apiResult) return apiResult;

    // Strategy C: Scrape the Steam Community broadcast page
    const scrapeResult = await this.scrapeBroadcastPage(steamId);
    if (scrapeResult) return scrapeResult;

    return null;
  }

  /**
   * Strategy A: Use the public getbroadcastmpd endpoint.
   * Returns num_viewers and title without any API key.
   */
  private async tryBroadcastMPD(
    steamId: string,
  ): Promise<{ isLive: boolean; viewers: number; title: string | null; gameName: string | null } | null> {
    try {
      const res = await this.scraper.get<{
        success: string;
        num_viewers?: number;
        title?: string;
      }>(`${STEAM_COMMUNITY_BASE}/broadcast/getbroadcastmpd`, {
        params: { steamid: steamId, broadcastid: 0, viewertoken: 0 },
        timeout: 8000,
      });

      if (res.data?.success === 'ready' && typeof res.data.num_viewers === 'number') {
        logger.debug('[Steam] Got viewer count from getbroadcastmpd', {
          steamId,
          viewers: res.data.num_viewers,
          title: res.data.title ?? null,
        });
        return {
          isLive: true,
          viewers: res.data.num_viewers,
          title: res.data.title ?? null,
          gameName: null,
        };
      }

      // success !== 'ready' means not broadcasting
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Strategy A: Use IBroadcastService undocumented endpoints.
   */
  private async tryBroadcastAPI(
    steamId: string,
  ): Promise<{ isLive: boolean; viewers: number; title: string | null; gameName: string | null } | null> {
    try {
      // Try GetBroadcastViewerStats first
      const viewerRes = await this.requestWithRetry(
        () =>
          this.client.get<SteamBroadcastViewerStats>(
            '/IBroadcastService/GetBroadcastViewerStats/v1/',
            { params: { key: this.apiKey, steamid: steamId } },
          ),
        'GetBroadcastViewerStats',
      );

      if (viewerRes?.data?.response?.viewer_stats && viewerRes.data.response.viewer_stats.length > 0) {
        // Get the most recent viewer stat entry
        const stats = viewerRes.data.response.viewer_stats;
        const latest = stats[stats.length - 1];
        if (latest && latest.count_viewers > 0) {
          logger.debug('[Steam] Got viewer count from API', {
            steamId,
            viewers: latest.count_viewers,
          });
          return {
            isLive: true,
            viewers: latest.count_viewers,
            title: null,
            gameName: null,
          };
        }
      }

      // Also try GetBroadcastUploadStats to check for active broadcasts
      const uploadRes = await this.requestWithRetry(
        () =>
          this.client.get<SteamBroadcastUploadStats>(
            '/IBroadcastService/GetBroadcastUploadStats/v1/',
            { params: { key: this.apiKey, steamid: steamId } },
          ),
        'GetBroadcastUploadStats',
      );

      if (uploadRes?.data?.response?.upload_stats && uploadRes.data.response.upload_stats.length > 0) {
        const uploads = uploadRes.data.response.upload_stats;
        const latest = uploads[uploads.length - 1];
        if (latest && latest.viewer_count > 0) {
          logger.debug('[Steam] Got viewer count from upload stats', {
            steamId,
            viewers: latest.viewer_count,
          });
          return {
            isLive: true,
            viewers: latest.viewer_count,
            title: null,
            gameName: null,
          };
        }
      }
    } catch (err) {
      logger.debug('[Steam] Broadcast API returned no data (may be undocumented/unavailable)', {
        steamId,
        error: (err as Error).message,
      });
    }

    return null;
  }

  /**
   * Strategy B: Scrape the Steam Community broadcast watch page.
   * The page embeds viewer count data in the HTML/JS.
   */
  private async scrapeBroadcastPage(
    steamId: string,
  ): Promise<{ isLive: boolean; viewers: number; title: string | null; gameName: string | null } | null> {
    try {
      const url = `${STEAM_COMMUNITY_BASE}/broadcast/watch/${steamId}`;
      const res = await this.scraper.get<string>(url);
      const html = res.data;

      if (!html || typeof html !== 'string') return null;

      // Check if the page indicates a live broadcast
      // Steam broadcasts embed viewer data in various JS variables
      const viewerMatch =
        html.match(/m_nViewerCount\s*=\s*(\d+)/) ||
        html.match(/"viewer_count"\s*:\s*(\d+)/) ||
        html.match(/data-viewer-count="(\d+)"/) ||
        html.match(/viewers?["']?\s*:\s*(\d+)/i);

      if (viewerMatch) {
        const viewers = parseInt(viewerMatch[1], 10);
        if (!isNaN(viewers) && viewers > 0) {
          // Try to extract game name
          const gameMatch = html.match(/data-game-name="([^"]+)"/) ||
            html.match(/"game_name"\s*:\s*"([^"]+)"/);
          const gameName = gameMatch ? gameMatch[1] : null;

          // Try to extract title
          const titleMatch = html.match(/<title>([^<]+)<\/title>/);
          const title = titleMatch ? titleMatch[1].replace(/ - Steam Community$/, '').trim() : null;

          logger.debug('[Steam] Got viewer count from scraping', {
            steamId,
            viewers,
            gameName,
          });
          return { isLive: true, viewers, title, gameName };
        }
      }

      // Check if the page says "not broadcasting"
      if (
        html.includes('is not currently broadcasting') ||
        html.includes('is not streaming') ||
        html.includes('BroadcastNotAvailable')
      ) {
        return null;
      }
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      if (status !== 404) {
        logger.debug('[Steam] Broadcast page scrape failed', {
          steamId,
          error: (err as Error).message,
        });
      }
    }

    return null;
  }

  // ── Private: Identifier resolution ────────────────────────────────────

  /**
   * Resolves a Steam identifier (Steam64 ID, vanity name, or profile URL)
   * to a Steam64 ID.
   */
  async resolveToSteam64(identifier: string): Promise<string | null> {
    const trimmed = identifier.trim();

    // Already a Steam64 ID
    if (STEAM64_ID_RE.test(trimmed)) return trimmed;

    // Check vanity cache
    const cached = this.vanityCache.get(trimmed.toLowerCase());
    if (cached) return cached;

    // Extract from profile URL
    const urlMatch = trimmed.match(
      /steamcommunity\.com\/(?:profiles\/(\d+)|id\/([a-zA-Z0-9_-]+))/,
    );
    if (urlMatch) {
      if (urlMatch[1] && STEAM64_ID_RE.test(urlMatch[1])) return urlMatch[1];
      if (urlMatch[2]) return this.resolveVanityUrl(urlMatch[2]);
    }

    // Treat as vanity name
    return this.resolveVanityUrl(trimmed);
  }

  /**
   * Resolves a Steam vanity URL name to a Steam64 ID via the official API.
   */
  private async resolveVanityUrl(vanityName: string): Promise<string | null> {
    const cacheKey = vanityName.toLowerCase();
    const cached = this.vanityCache.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await this.client.get('/ISteamUser/ResolveVanityURL/v1/', {
        params: { key: this.apiKey, vanityurl: vanityName },
      });

      if (res.data?.response?.success === 1 && res.data.response.steamid) {
        const steamId = res.data.response.steamid;
        this.vanityCache.set(cacheKey, steamId);
        logger.debug('[Steam] Resolved vanity URL', { vanityName, steamId });
        return steamId;
      }

      logger.warn('[Steam] Vanity URL not found', { vanityName });
      return null;
    } catch (err) {
      logger.warn('[Steam] Failed to resolve vanity URL', {
        vanityName,
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ── Private: Display name resolution ──────────────────────────────────

  /**
   * Batch-fetches display names (persona names) for Steam64 IDs.
   * Results are cached in nameCache.
   */
  private async batchFetchDisplayNames(steamIds: string[]): Promise<void> {
    // Filter out already-cached
    const uncached = steamIds.filter((id) => !this.nameCache.has(id));
    if (uncached.length === 0) return;

    // Chunk into batches of 100
    for (let i = 0; i < uncached.length; i += PLAYER_SUMMARIES_BATCH) {
      const batch = uncached.slice(i, i + PLAYER_SUMMARIES_BATCH);
      try {
        const res = await this.client.get('/ISteamUser/GetPlayerSummaries/v2/', {
          params: { key: this.apiKey, steamids: batch.join(',') },
        });

        const players: SteamPlayerSummary[] = res.data?.response?.players ?? [];
        for (const player of players) {
          this.nameCache.set(player.steamid, player.personaname);
        }
      } catch (err) {
        logger.warn('[Steam] Failed to fetch player summaries', {
          batchSize: batch.length,
          error: (err as Error).message,
        });
      }
    }
  }

  // ── Private: Helpers ──────────────────────────────────────────────────

  private offlineSnapshot(channelIdentifier: string, displayName?: string): ChannelSnapshot {
    return {
      channelIdentifier,
      displayName: displayName ?? channelIdentifier,
      concurrentViewers: 0,
      isLive: false,
      language: null,
      gameName: null,
      title: null,
      startedAt: null,
    };
  }

  /**
   * Retry wrapper with exponential backoff for transient failures.
   */
  private async requestWithRetry<T>(
    fn: () => Promise<T>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        // Don't retry on client errors (except 429)
        if (status && status >= 400 && status < 500 && status !== 429) {
          return null;
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.debug(`[Steam] ${context}: retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, {
            status,
            error: axiosErr.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    logger.warn(`[Steam] ${context}: all retries exhausted`);
    return null;
  }
}
