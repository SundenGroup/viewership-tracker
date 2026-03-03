import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_VIDEO_IDS_PER_REQUEST = 50;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const LIVE_VIDEO_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_DAILY_QUOTA = 10_000;
const QUOTA_WARNING_THRESHOLD = 0.8;

// ── Scraping constants ────────────────────────────────────────────────
const SCRAPE_CONCURRENCY = 10; // max parallel scrape requests
const SCRAPE_TIMEOUT_MS = 8_000;
const SCRAPE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// YouTube Data API v3 quota costs
const QUOTA_COST = {
  search: 100,
  videosList: 1,
} as const;

// ── YouTube API response types ──────────────────────────────────────────

interface YouTubeSearchItem {
  id: { kind: string; videoId: string };
  snippet: {
    channelId: string;
    channelTitle: string;
    title: string;
    liveBroadcastContent: string;
  };
}

interface YouTubeVideoItem {
  id: string;
  snippet: {
    channelId: string;
    channelTitle: string;
    title: string;
    defaultAudioLanguage?: string;
    liveBroadcastContent: string;
  };
  liveStreamingDetails?: {
    concurrentViewers?: string;
    actualStartTime?: string;
    scheduledStartTime?: string;
  };
}

interface YouTubeListResponse<T> {
  items: T[];
  pageInfo: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}

interface CachedLiveVideo {
  videoId: string;
  cachedAt: number;
}

/**
 * Rich data extracted from scraping a YouTube channel's /live page.
 * This gives us everything we need without consuming API quota.
 */
interface ScrapedLiveData {
  videoId: string;
  title: string | null;
  channelName: string | null;
  concurrentViewers: number;
  startedAt: string | null;
  language: string | null;
}

export interface QuotaUsage {
  used: number;
  limit: number;
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube';

  private readonly apiKey: string;
  private readonly client: AxiosInstance;
  private readonly scraper: AxiosInstance;
  private readonly liveVideoCache = new Map<string, CachedLiveVideo>();
  private quotaUsed = 0;
  private quotaResetDate: string = todayDateString();
  private readonly quotaLimit: number;

  constructor(apiKey?: string, quotaLimit?: number) {
    this.apiKey = apiKey ?? config.youtube.apiKey;
    this.quotaLimit = quotaLimit ?? DEFAULT_DAILY_QUOTA;

    this.client = axios.create({
      baseURL: API_BASE,
      params: { key: this.apiKey },
    });

    // Separate axios instance for scraping YouTube pages (no API key needed)
    this.scraper = axios.create({
      timeout: SCRAPE_TIMEOUT_MS,
      headers: {
        'User-Agent': SCRAPE_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });
  }

  // ── Quota tracking ────────────────────────────────────────────────────

  getQuotaUsage(): QuotaUsage {
    this.resetQuotaIfNewDay();
    return { used: this.quotaUsed, limit: this.quotaLimit };
  }

  private resetQuotaIfNewDay(): void {
    const today = todayDateString();
    if (today !== this.quotaResetDate) {
      logger.info('YouTube quota counter reset for new day', {
        previousUsed: this.quotaUsed,
      });
      this.quotaUsed = 0;
      this.quotaResetDate = today;
    }
  }

  private consumeQuota(cost: number, context: string): boolean {
    this.resetQuotaIfNewDay();
    if (this.quotaUsed + cost > this.quotaLimit) {
      logger.error(`YouTube quota exhausted: ${this.quotaUsed}/${this.quotaLimit} used, need ${cost} for ${context}`);
      return false;
    }

    this.quotaUsed += cost;

    if (this.quotaUsed >= this.quotaLimit * QUOTA_WARNING_THRESHOLD) {
      logger.warn(`YouTube quota at ${((this.quotaUsed / this.quotaLimit) * 100).toFixed(1)}%: ${this.quotaUsed}/${this.quotaLimit}`);
    }

    return true;
  }

  // ── Retry wrapper ─────────────────────────────────────────────────────

  private async requestWithRetry<T>(
    fn: () => Promise<T>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const axErr = err as AxiosError;
        const status = axErr.response?.status;
        const retryable = status === 429 || (status !== undefined && status >= 500);

        if (!retryable || attempt === MAX_RETRIES) {
          logger.warn(`YouTube API ${context} failed after ${attempt + 1} attempt(s)`, {
            status,
            message: axErr.message,
          });
          return null;
        }

        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`YouTube API ${context} returned ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
      }
    }
    return null;
  }

  // ── Live data resolution (ZERO quota — scraping) ─────────────────────

  private getCachedLiveVideoId(channelId: string): string | null {
    const entry = this.liveVideoCache.get(channelId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > LIVE_VIDEO_CACHE_TTL_MS) {
      this.liveVideoCache.delete(channelId);
      return null;
    }
    return entry.videoId;
  }

  /**
   * Scrapes the YouTube /channel/CHANNEL_ID/live page to detect if the channel
   * is currently live and extract viewer data. This costs ZERO API quota.
   *
   * How it works:
   * - If the channel IS live, the canonical URL becomes /watch?v=VIDEO_ID
   * - If the channel is NOT live, the canonical URL stays as the channel URL
   * - We also parse ytInitialPlayerResponse and ytInitialData for:
   *   - concurrent viewers (from originalViewCount in ytInitialData)
   *   - stream title (from ytInitialPlayerResponse.videoDetails.title)
   *   - channel name (from ytInitialPlayerResponse.videoDetails.author)
   *   - start time (from liveBroadcastDetails.startTimestamp)
   */
  private async scrapeLiveData(channelId: string): Promise<ScrapedLiveData | null> {
    try {
      const url = `https://www.youtube.com/channel/${channelId}/live`;
      const { data: html } = await this.scraper.get<string>(url, {
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      if (typeof html !== 'string') return null;

      // ── Step 1: Detect if the channel is live ──────────────────────────

      let videoId: string | null = null;

      // Method 1: Check canonical URL for /watch?v=VIDEO_ID
      const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
      if (canonicalMatch) {
        const canonicalUrl = canonicalMatch[1];
        const videoIdMatch = canonicalUrl.match(/\/watch\?v=([a-zA-Z0-9_-]+)/);
        if (videoIdMatch) {
          // Extra confirmation: check for isLive indicator
          const isLiveOnPage = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
          if (isLiveOnPage) {
            videoId = videoIdMatch[1];
          } else {
            logger.debug(`YouTube scrape: ${channelId} has canonical video ${videoIdMatch[1]} but isLive=false, treating as offline`);
            return null;
          }
        }
      }

      // Method 2: Fallback — look for live video ID in ytInitialData
      if (!videoId) {
        const liveVideoMatch = html.match(/"videoId":"([a-zA-Z0-9_-]+)"[^}]*"isLive":true/);
        if (liveVideoMatch) {
          videoId = liveVideoMatch[1];
        }
      }

      // Method 3: If isLive is confirmed on the page, grab the first videoId we can find
      if (!videoId) {
        const isLiveOnPage = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
        if (isLiveOnPage) {
          // Try videoDetails.videoId
          const videoDetailsMatch = html.match(/"videoDetails":\{"videoId":"([a-zA-Z0-9_-]+)"/);
          if (videoDetailsMatch) {
            videoId = videoDetailsMatch[1];
          } else {
            // Grab any videoId from the page — it's likely the live stream
            const anyVideoId = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            if (anyVideoId) {
              videoId = anyVideoId[1];
            }
          }
          if (videoId) {
            logger.debug(`YouTube scrape: ${channelId} detected live via isLive flag (Method 3), videoId=${videoId}`);
          }
        }
      }

      // Method 4: Last resort — isLive is on the page with viewer count but no video ID
      // Still report as live using a placeholder video ID (won't be used for API enrichment)
      if (!videoId) {
        const isLiveOnPage = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
        const hasViewers = html.includes('"originalViewCount"');
        if (isLiveOnPage && hasViewers) {
          videoId = `unknown-${channelId}`;
          logger.debug(`YouTube scrape: ${channelId} is LIVE (confirmed via isLive+viewers) but no videoId found, using placeholder`);
        }
      }

      if (!videoId) return null; // Channel is not live

      // Cache the video ID
      this.liveVideoCache.set(channelId, { videoId, cachedAt: Date.now() });

      // ── Step 2: Extract rich data from the page HTML ───────────────────

      let title: string | null = null;
      let channelName: string | null = null;
      let concurrentViewers = 0;
      let startedAt: string | null = null;
      let language: string | null = null;

      // Try to parse ytInitialPlayerResponse for title, author, language, start time
      const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script)/s);
      if (playerResponseMatch) {
        try {
          const pr = JSON.parse(playerResponseMatch[1]) as Record<string, unknown>;
          const videoDetails = pr.videoDetails as Record<string, unknown> | undefined;
          if (videoDetails) {
            title = (videoDetails.title as string) ?? null;
            channelName = (videoDetails.author as string) ?? null;
          }

          // Get start time from microformat.playerMicroformatRenderer.liveBroadcastDetails
          const microformat = pr.microformat as Record<string, unknown> | undefined;
          const renderer = microformat?.playerMicroformatRenderer as Record<string, unknown> | undefined;
          const liveBroadcast = renderer?.liveBroadcastDetails as Record<string, unknown> | undefined;
          if (liveBroadcast?.startTimestamp) {
            startedAt = liveBroadcast.startTimestamp as string;
          }

          // Language from captions or default audio language
          const captions = pr.captions as Record<string, unknown> | undefined;
          const captionTracks = (captions?.playerCaptionsTracklistRenderer as Record<string, unknown>)
            ?.captionTracks as Array<Record<string, unknown>> | undefined;
          if (captionTracks && captionTracks.length > 0) {
            language = (captionTracks[0].languageCode as string) ?? null;
          }
        } catch {
          // JSON parse failed — just use what we have
          logger.debug(`YouTube scrape: failed to parse ytInitialPlayerResponse for ${channelId}`);
        }
      }

      // Fallback for title: match from general page data
      if (!title) {
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
        title = titleMatch ? titleMatch[1] : null;
      }

      // Fallback for channel name
      if (!channelName) {
        const authorMatch = html.match(/"author":"([^"]+)"/);
        channelName = authorMatch ? authorMatch[1] : null;
      }

      // Get concurrent viewers from ytInitialData (originalViewCount field)
      // This is the actual live concurrent viewer count, NOT the total view count
      const originalViewCountMatch = html.match(/"originalViewCount":"(\d+)"/);
      if (originalViewCountMatch) {
        concurrentViewers = parseInt(originalViewCountMatch[1], 10);
      }

      logger.debug(`YouTube scrape: ${channelId} is LIVE → videoId=${videoId}, viewers=${concurrentViewers}, title="${title?.substring(0, 50) ?? 'unknown'}"`);

      return {
        videoId,
        title,
        channelName,
        concurrentViewers,
        startedAt,
        language,
      };
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('timeout') || errMsg.includes('ECONNRESET')) {
        logger.debug(`YouTube scrape: ${channelId} timed out or connection reset`);
      } else {
        logger.warn(`YouTube scrape: failed for ${channelId}`, { error: errMsg });
      }
      return null;
    }
  }

  /**
   * Scrapes live data for a specific YouTube video by its video ID.
   * Used when a channel_identifier is stored as `yt-video:VIDEO_ID`.
   * Directly fetches /watch?v=VIDEO_ID — more reliable than channel scraping.
   * Costs ZERO API quota.
   */
  private async scrapeVideoLiveData(videoId: string): Promise<ScrapedLiveData | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const { data: html } = await this.scraper.get<string>(url, {
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      if (typeof html !== 'string') return null;

      // Check if the video is currently live
      const isLive = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
      if (!isLive) return null;

      // Extract data
      let title: string | null = null;
      let channelName: string | null = null;
      let concurrentViewers = 0;
      let startedAt: string | null = null;
      let language: string | null = null;

      // Title from og:title or page content
      const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) ??
        html.match(/"title":"([^"]+)"/);
      title = titleMatch ? titleMatch[1] : null;

      // Channel name from author field
      const authorMatch = html.match(/"author":"([^"]+)"/);
      channelName = authorMatch ? authorMatch[1] : null;

      // Concurrent viewers
      const viewerMatch = html.match(/"originalViewCount":"(\d+)"/);
      if (viewerMatch) {
        concurrentViewers = parseInt(viewerMatch[1], 10);
      }

      // Channel ID for reference
      const channelIdMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]+)"/);

      logger.debug(`YouTube scrape video: ${videoId} is LIVE → viewers=${concurrentViewers}, channel=${channelName}`);

      return {
        videoId,
        title,
        channelName: channelName ?? (channelIdMatch ? channelIdMatch[1] : null),
        concurrentViewers,
        startedAt,
        language,
      };
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.warn(`YouTube scrape video: failed for ${videoId}`, { error: errMsg });
      return null;
    }
  }

  /**
   * Scrapes live data for multiple channels in parallel.
   * Returns a map of channelId → ScrapedLiveData for all live channels.
   * Costs ZERO API quota.
   */
  private async scrapeMultipleLiveData(
    channelIds: string[],
  ): Promise<Map<string, ScrapedLiveData>> {
    const results = new Map<string, ScrapedLiveData>();
    const toScrape: string[] = [];

    // Channels with cached video IDs still need scraping for viewer counts
    // (cache only stores videoId, not the full data), but we can skip known-offline channels
    for (const channelId of channelIds) {
      toScrape.push(channelId);
    }

    if (toScrape.length === 0) return results;

    logger.debug(`YouTube: scraping ${toScrape.length} channels for live status`);

    // Process in concurrent batches
    const batches = chunk(toScrape, SCRAPE_CONCURRENCY);

    for (const batch of batches) {
      const batchResults = await Promise.allSettled(
        batch.map(async (channelId) => {
          const data = await this.scrapeLiveData(channelId);
          return { channelId, data };
        }),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value.data) {
          results.set(result.value.channelId, result.value.data);
        }
      }

      // Small delay between batches to avoid hitting rate limits
      if (batches.indexOf(batch) < batches.length - 1) {
        await sleep(200);
      }
    }

    logger.info(`YouTube scrape results: ${results.size} live out of ${channelIds.length} channels`);
    return results;
  }

  // ── Legacy search-based resolution (expensive, kept for discovery) ───

  private async searchLiveVideoId(channelId: string): Promise<string | null> {
    if (!this.consumeQuota(QUOTA_COST.search, `searchLiveVideoId(${channelId})`)) {
      return null;
    }

    const result = await this.requestWithRetry(async () => {
      const { data } = await this.client.get<YouTubeListResponse<YouTubeSearchItem>>(
        '/search',
        {
          params: {
            channelId,
            eventType: 'live',
            type: 'video',
            part: 'id,snippet',
            maxResults: 1,
          },
        },
      );
      return data;
    }, `searchLiveVideoId(${channelId})`);

    if (!result || result.items.length === 0) {
      return null;
    }

    const videoId = result.items[0].id.videoId;
    this.liveVideoCache.set(channelId, { videoId, cachedAt: Date.now() });
    return videoId;
  }

  // ── Bulk video details fetch ──────────────────────────────────────────

  private async getVideoDetails(videoIds: string[]): Promise<YouTubeVideoItem[]> {
    if (videoIds.length === 0) return [];

    const batches = chunk(videoIds, MAX_VIDEO_IDS_PER_REQUEST);
    const allItems: YouTubeVideoItem[] = [];

    for (const batch of batches) {
      if (!this.consumeQuota(QUOTA_COST.videosList, 'getVideoDetails')) {
        break;
      }

      const result = await this.requestWithRetry(async () => {
        const { data } = await this.client.get<YouTubeListResponse<YouTubeVideoItem>>(
          '/videos',
          {
            params: {
              id: batch.join(','),
              part: 'snippet,liveStreamingDetails',
            },
          },
        );
        return data;
      }, 'getVideoDetails');

      if (result) {
        allItems.push(...result.items);
      }
    }

    return allItems;
  }

  // ── Handle / custom-URL → channel ID resolution ─────────────────────

  /** Cache of resolved handles → channel IDs (persists for adapter lifetime) */
  private readonly handleCache = new Map<string, string>();

  /**
   * Checks if a string looks like a YouTube channel ID (starts with UC, 24 chars).
   */
  private isChannelId(identifier: string): boolean {
    return /^UC[a-zA-Z0-9_-]{22}$/.test(identifier);
  }

  /**
   * Resolves a YouTube handle (@name), custom URL, or plain username to
   * an actual channel ID (UC...) by scraping the channel page.
   * Results are cached for the lifetime of the adapter.
   * Costs ZERO API quota.
   */
  private async resolveToChannelId(identifier: string): Promise<string | null> {
    // Already a channel ID
    if (this.isChannelId(identifier)) return identifier;

    // Check cache
    const cached = this.handleCache.get(identifier.toLowerCase());
    if (cached) return cached;

    // Build URL based on format
    let url: string;
    if (identifier.startsWith('@')) {
      url = `https://www.youtube.com/${identifier}`;
    } else if (identifier.startsWith('http')) {
      url = identifier;
    } else {
      // Try as @handle first, fall back to /c/ custom URL
      url = `https://www.youtube.com/@${identifier}`;
    }

    try {
      const { data: html } = await this.scraper.get<string>(url, {
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      if (typeof html !== 'string') return null;

      // Look for channel ID in the page
      const externalIdMatch = html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/);
      if (externalIdMatch) {
        const channelId = externalIdMatch[1];
        this.handleCache.set(identifier.toLowerCase(), channelId);
        logger.info(`YouTube: resolved "${identifier}" → ${channelId}`);
        return channelId;
      }

      // Fallback: look for channel ID in canonical URL or other locations
      const canonicalMatch = html.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/);
      if (canonicalMatch) {
        const channelId = canonicalMatch[1];
        this.handleCache.set(identifier.toLowerCase(), channelId);
        logger.info(`YouTube: resolved "${identifier}" → ${channelId}`);
        return channelId;
      }

      logger.warn(`YouTube: could not resolve "${identifier}" to a channel ID`);
      return null;
    } catch (err) {
      logger.warn(`YouTube: failed to resolve "${identifier}"`, { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Resolves multiple identifiers to channel IDs in parallel.
   * Returns a map of original identifier → resolved channel ID.
   * Non-resolvable identifiers are omitted from the map.
   */
  private async resolveIdentifiers(
    identifiers: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const toResolve: string[] = [];

    for (const id of identifiers) {
      if (this.isChannelId(id) || id.startsWith('yt-video:')) {
        // Channel IDs and video IDs pass through directly
        result.set(id, id);
      } else {
        toResolve.push(id);
      }
    }

    if (toResolve.length > 0) {
      logger.info(`YouTube: resolving ${toResolve.length} non-standard identifiers`);
      const batches = chunk(toResolve, SCRAPE_CONCURRENCY);
      for (const batch of batches) {
        const settled = await Promise.allSettled(
          batch.map(async (id) => {
            const resolved = await this.resolveToChannelId(id);
            return { id, resolved };
          }),
        );
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value.resolved) {
            result.set(r.value.id, r.value.resolved);
          }
        }
        if (batches.indexOf(batch) < batches.length - 1) {
          await sleep(200);
        }
      }
    }

    return result;
  }

  // ── Core methods ──────────────────────────────────────────────────────

  /**
   * Gets viewer counts for the given YouTube channels.
   *
   * APPROACH (quota-efficient with zero-quota fallback):
   *   Step 1: Scrape /channel/CHANNEL_ID/live pages in parallel (0 quota)
   *           Extracts: isLive, videoId, concurrent viewers, title, channel name, start time
   *   Step 2: Try to enrich with /videos API (1 quota per 50 videos) for more accurate data
   *           If API fails (quota exhausted), fall back to scraped data
   *
   * Quota cost comparison for 89 channels:
   *   Old: 89 × 100 = 8,900 units per poll (using /search)
   *   New: 0 (scraping) + 2 (videos.list for up to 89 IDs) = 2 units per poll
   *   Fallback: 0 units (scrape-only mode when API quota is exhausted)
   */
  async getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]> {
    if (channelIdentifiers.length === 0) return [];

    // Step 0: Separate video-specific identifiers (yt-video:VIDEO_ID) from channels
    const videoIdentifiers: string[] = [];
    const channelOnlyIdentifiers: string[] = [];

    for (const id of channelIdentifiers) {
      if (id.startsWith('yt-video:')) {
        videoIdentifiers.push(id);
      } else {
        channelOnlyIdentifiers.push(id);
      }
    }

    // Step 0a: Scrape specific video IDs directly (more reliable than channel scraping)
    const videoScrapedData = new Map<string, ScrapedLiveData>();
    if (videoIdentifiers.length > 0) {
      logger.debug(`YouTube: scraping ${videoIdentifiers.length} specific video stream(s)`);
      const batches = chunk(videoIdentifiers, SCRAPE_CONCURRENCY);
      for (const batch of batches) {
        const settled = await Promise.allSettled(
          batch.map(async (id) => {
            const videoId = id.replace('yt-video:', '');
            const data = await this.scrapeVideoLiveData(videoId);
            return { id, data };
          }),
        );
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value.data) {
            videoScrapedData.set(r.value.id, r.value.data);
          }
        }
      }
    }

    // Step 0b: Resolve any handles/custom URLs to channel IDs
    const resolvedMap = await this.resolveIdentifiers(channelOnlyIdentifiers);

    // Build the list of resolved channel IDs for scraping
    const resolvedIds = channelOnlyIdentifiers
      .map((id) => resolvedMap.get(id))
      .filter((id): id is string => id !== undefined);

    // Map from resolved channel ID back to original identifier
    const reverseMap = new Map<string, string>();
    for (const [original, resolved] of resolvedMap) {
      reverseMap.set(resolved, original);
    }

    // Step 1: Scrape all channels for live status + viewer data (ZERO quota)
    const scrapedData = await this.scrapeMultipleLiveData(resolvedIds);

    // Step 2: Try to enrich with API data (more accurate concurrent viewers)
    const videoIds = Array.from(scrapedData.values()).map((d) => d.videoId);
    const videoDetails = await this.getVideoDetails(videoIds);

    // Build lookup: videoId → API video data
    const videoMap = new Map<string, YouTubeVideoItem>();
    for (const video of videoDetails) {
      videoMap.set(video.id, video);
    }

    const apiAvailable = videoDetails.length > 0;
    if (!apiAvailable && videoIds.length > 0) {
      logger.warn(`YouTube: API unavailable (quota exhausted?), using scraped data for ${scrapedData.size} live channels`);
    }

    // Step 3: Build results — prefer API data, fall back to scraped data
    const results: ChannelSnapshot[] = [];

    for (const originalId of channelIdentifiers) {
      // Handle yt-video: identifiers (specific live stream URLs)
      if (originalId.startsWith('yt-video:')) {
        const vScraped = videoScrapedData.get(originalId);
        if (vScraped) {
          results.push({
            channelIdentifier: originalId,
            displayName: vScraped.channelName ?? originalId.replace('yt-video:', ''),
            concurrentViewers: vScraped.concurrentViewers,
            isLive: true,
            language: vScraped.language,
            gameName: null,
            title: vScraped.title,
            startedAt: vScraped.startedAt,
          });
        } else {
          results.push({
            channelIdentifier: originalId,
            displayName: originalId.replace('yt-video:', ''),
            concurrentViewers: 0,
            isLive: false,
            language: null,
            gameName: null,
            title: null,
            startedAt: null,
          });
        }
        continue;
      }

      const resolvedId = resolvedMap.get(originalId);

      if (!resolvedId) {
        // Could not resolve this identifier
        results.push({
          channelIdentifier: originalId,
          displayName: originalId,
          concurrentViewers: 0,
          isLive: false,
          language: null,
          gameName: null,
          title: null,
          startedAt: null,
        });
        continue;
      }

      const scraped = scrapedData.get(resolvedId);

      if (!scraped) {
        // Channel is not live
        results.push({
          channelIdentifier: originalId,
          displayName: originalId,
          concurrentViewers: 0,
          isLive: false,
          language: null,
          gameName: null,
          title: null,
          startedAt: null,
        });
        continue;
      }

      // Channel is live — try API data first, fall back to scraped data
      const apiVideo = videoMap.get(scraped.videoId);

      if (apiVideo && apiVideo.liveStreamingDetails?.concurrentViewers) {
        // API data available — use it (more accurate)
        results.push({
          channelIdentifier: originalId,
          displayName: apiVideo.snippet.channelTitle,
          concurrentViewers: parseInt(apiVideo.liveStreamingDetails.concurrentViewers, 10),
          isLive: true,
          language: apiVideo.snippet.defaultAudioLanguage ?? scraped.language,
          gameName: null,
          title: apiVideo.snippet.title,
          startedAt: apiVideo.liveStreamingDetails.actualStartTime ?? scraped.startedAt,
        });
      } else {
        // API unavailable — use scraped data (still accurate for viewer counts)
        results.push({
          channelIdentifier: originalId,
          displayName: scraped.channelName ?? originalId,
          concurrentViewers: scraped.concurrentViewers,
          isLive: true,
          language: scraped.language,
          gameName: null,
          title: scraped.title,
          startedAt: scraped.startedAt,
        });
      }
    }

    const liveCount = results.filter((r) => r.isLive).length;
    logger.debug(`YouTube getViewerCounts: ${liveCount}/${channelIdentifiers.length} live`, {
      quotaUsed: this.quotaUsed,
      apiEnriched: videoDetails.length,
      scrapedLive: scrapedData.size,
      mode: apiAvailable ? 'api+scrape' : 'scrape-only',
    });
    return results;
  }

  /**
   * Searches for live streams by keywords (used by Discovery).
   * This still uses the /search API (100 quota units per keyword) because
   * discovery needs to find NEW channels we don't know about yet.
   * However, discovery runs less frequently than polling, so the quota impact is manageable.
   */
  async searchLiveStreams(
    _gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    if (!keywords || keywords.length === 0) return [];

    // Search for each keyword, collect unique video IDs
    const seenVideoIds = new Set<string>();
    const searchResults: Array<{ videoId: string; snippet: YouTubeSearchItem['snippet'] }> = [];

    for (const keyword of keywords) {
      if (!this.consumeQuota(QUOTA_COST.search, `searchLiveStreams("${keyword}")`)) {
        break;
      }

      let nextPageToken: string | undefined;
      const maxPages = 2; // 2 pages × 50 results = up to 100 per keyword

      for (let page = 0; page < maxPages; page++) {
        const result = await this.requestWithRetry(async () => {
          const params: Record<string, string | number> = {
            q: keyword,
            eventType: 'live',
            type: 'video',
            part: 'id,snippet',
            maxResults: 50,
          };
          if (nextPageToken) params.pageToken = nextPageToken;

          const { data } = await this.client.get<YouTubeListResponse<YouTubeSearchItem>>(
            '/search',
            { params },
          );
          return data;
        }, `searchLiveStreams("${keyword}")`);

        if (!result || result.items.length === 0) break;

        for (const item of result.items) {
          if (!seenVideoIds.has(item.id.videoId)) {
            seenVideoIds.add(item.id.videoId);
            searchResults.push({ videoId: item.id.videoId, snippet: item.snippet });
          }
        }

        nextPageToken = result.nextPageToken;
        if (!nextPageToken) break;

        // Additional pages cost quota too
        if (page < maxPages - 1 && !this.consumeQuota(QUOTA_COST.search, `searchLiveStreams("${keyword}") page ${page + 2}`)) {
          break;
        }
      }
    }

    if (searchResults.length === 0) return [];

    // Fetch concurrent viewers for all discovered videos
    const videoIds = searchResults.map((r) => r.videoId);
    const videoDetails = await this.getVideoDetails(videoIds);

    const videoMap = new Map<string, YouTubeVideoItem>();
    for (const video of videoDetails) {
      videoMap.set(video.id, video);
    }

    const streams: DiscoveredStream[] = [];

    for (const result of searchResults) {
      const video = videoMap.get(result.videoId);
      const viewers = video?.liveStreamingDetails?.concurrentViewers;
      const title = video?.snippet.title ?? result.snippet.title;

      // Secondary keyword validation: YouTube search is broad, so verify
      // the stream title actually contains at least one keyword (case-insensitive).
      // This mirrors how the Twitch adapter filters by title keywords.
      if (keywords && keywords.length > 0) {
        const titleLower = (title ?? '').toLowerCase();
        const channelLower = result.snippet.channelTitle.toLowerCase();
        const matches = keywords.some(
          (kw) => {
            const kwLower = kw.toLowerCase();
            return titleLower.includes(kwLower) || channelLower.includes(kwLower);
          },
        );
        if (!matches) {
          logger.debug(
            `YouTube searchLiveStreams: skipping "${result.snippet.channelTitle}" — ` +
            `title "${title}" does not match any keywords`,
          );
          continue;
        }
      }

      streams.push({
        channelIdentifier: result.snippet.channelId,
        displayName: result.snippet.channelTitle,
        concurrentViewers: viewers ? parseInt(viewers, 10) : 0,
        language: video?.snippet.defaultAudioLanguage ?? null,
        title,
      });
    }

    logger.debug(`YouTube searchLiveStreams: found ${streams.length} streams (after keyword filter)`, {
      keywords,
      quotaUsed: this.quotaUsed,
    });
    return streams;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
