import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
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

interface CachedMultiStreamVideoIds {
  videoIds: string[];
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
  private readonly multiStreamCache = new Map<string, CachedMultiStreamVideoIds>();
  private multiStreamChannels = new Set<string>();
  private quotaUsed = 0;
  private quotaResetDate: string = todayDateString();
  private readonly quotaLimit: number;
  private static readonly QUOTA_FILE = path.resolve(process.cwd(), '.youtube-quota.json');

  constructor(apiKey?: string, quotaLimit?: number) {
    this.apiKey = apiKey ?? config.youtube.apiKey;
    this.quotaLimit = quotaLimit ?? DEFAULT_DAILY_QUOTA;

    // Restore quota counter from disk (survives PM2 restarts)
    this.loadQuotaFromDisk();

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
      this.saveQuotaToDisk();
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

    // Persist to disk every time quota changes (small file, fast write)
    this.saveQuotaToDisk();

    return true;
  }

  private loadQuotaFromDisk(): void {
    try {
      if (fs.existsSync(YouTubeAdapter.QUOTA_FILE)) {
        const raw = fs.readFileSync(YouTubeAdapter.QUOTA_FILE, 'utf-8');
        const data = JSON.parse(raw) as { date: string; used: number };
        if (data.date === todayDateString()) {
          this.quotaUsed = data.used;
          this.quotaResetDate = data.date;
          logger.info(`YouTube quota restored from disk: ${data.used}/${this.quotaLimit}`);
        } else {
          logger.info('YouTube quota file is from a previous day, starting fresh');
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private saveQuotaToDisk(): void {
    try {
      fs.writeFileSync(
        YouTubeAdapter.QUOTA_FILE,
        JSON.stringify({ date: this.quotaResetDate, used: this.quotaUsed }),
      );
    } catch {
      // Non-critical — quota counter will just reset on next restart
    }
  }

  // ── Multi-stream management ──────────────────────────────────────────

  /**
   * Called by the polling orchestrator before each poll cycle to identify
   * which YouTube channels should be checked for multiple simultaneous streams.
   * Only channels with metadata.multi_stream = true are passed here.
   */
  setMultiStreamChannels(channelIds: string[]): void {
    this.multiStreamChannels = new Set(channelIds.map((id) => id.toLowerCase()));
    if (channelIds.length > 0) {
      logger.debug(`YouTube: multi-stream detection enabled for ${channelIds.length} channel(s)`);
    }
  }

  /**
   * Scrapes the channel's /streams tab to find ALL currently-live video IDs.
   * This allows detection of multiple simultaneous live streams on one channel.
   * Costs ZERO API quota.
   *
   * How it works:
   * - Fetches /channel/{id}/streams (the "Live" tab on YouTube)
   * - Parses ytInitialData JSON from the page
   * - Finds videoIds with LIVE badges in thumbnail overlays
   * - Returns array of currently-live video IDs
   */
  private async scrapeChannelLiveVideoIds(channelId: string): Promise<string[]> {
    // Check cache first (5-minute TTL)
    const cached = this.multiStreamCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < LIVE_VIDEO_CACHE_TTL_MS) {
      return cached.videoIds;
    }

    try {
      const url = `https://www.youtube.com/channel/${channelId}/streams`;
      const { data: html } = await this.scraper.get<string>(url, {
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      if (typeof html !== 'string') return [];

      const liveVideoIds: string[] = [];
      const seenIds = new Set<string>();

      // Strategy 1: Look for videoRenderer items with LIVE overlay badges
      // YouTube marks live streams with thumbnailOverlays containing "LIVE" style
      // Pattern: "videoId":"XXX"...followed by..."style":"LIVE" within the same renderer block
      const videoRendererRegex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"[^}]*?"thumbnailOverlays":\[.*?"style":"LIVE"/g;
      let match;
      while ((match = videoRendererRegex.exec(html)) !== null) {
        if (!seenIds.has(match[1])) {
          seenIds.add(match[1]);
          liveVideoIds.push(match[1]);
        }
      }

      // Strategy 2: Look for "LIVE_NOW" badges near videoIds
      if (liveVideoIds.length === 0) {
        const liveNowRegex = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]*?"BADGE_STYLE_TYPE_LIVE_NOW"/g;
        while ((match = liveNowRegex.exec(html)) !== null) {
          if (!seenIds.has(match[1])) {
            seenIds.add(match[1]);
            liveVideoIds.push(match[1]);
          }
        }
      }

      // Strategy 3: Broader pattern — look for richItemRenderer with live indicators
      if (liveVideoIds.length === 0) {
        // Find all videoIds on the page, then check if they have live indicators nearby
        const allVideoIds = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
        for (const vidMatch of allVideoIds) {
          const pos = vidMatch.index!;
          // Check 2000 chars after the videoId for LIVE indicators
          const context = html.substring(pos, pos + 2000);
          const hasLiveIndicator =
            context.includes('"style":"LIVE"') ||
            context.includes('BADGE_STYLE_TYPE_LIVE_NOW') ||
            context.includes('"iconType":"LIVE"');
          if (hasLiveIndicator && !seenIds.has(vidMatch[1])) {
            seenIds.add(vidMatch[1]);
            liveVideoIds.push(vidMatch[1]);
          }
        }
      }

      // Filter out videos that belong to OTHER channels (YouTube recommendations).
      // Use the Videos API to verify ownership if we have quota, otherwise keep all.
      let verifiedIds = liveVideoIds;
      if (liveVideoIds.length > 0) {
        // Quick check: look for channelId in nearby context for each video in the HTML
        const ownedIds: string[] = [];
        for (const vid of liveVideoIds) {
          const vidPos = html.indexOf(`"videoId":"${vid}"`);
          if (vidPos === -1) { ownedIds.push(vid); continue; } // Can't check, keep it
          // Look for channelId in the 3000 chars around this videoId reference
          const context = html.substring(Math.max(0, vidPos - 500), vidPos + 3000);
          const chIdMatch = context.match(/"channelId":"(UC[a-zA-Z0-9_-]+)"/);
          if (!chIdMatch || chIdMatch[1] === channelId) {
            ownedIds.push(vid); // Belongs to this channel (or can't determine)
          } else {
            logger.debug(`YouTube: multi-stream scrape for ${channelId} — skipping video ${vid} (belongs to ${chIdMatch[1]})`);
          }
        }
        verifiedIds = ownedIds;
      }

      // Cache the result
      this.multiStreamCache.set(channelId, {
        videoIds: verifiedIds,
        cachedAt: Date.now(),
      });

      if (verifiedIds.length > 0) {
        logger.info(`YouTube: found ${verifiedIds.length} live stream(s) on channel ${channelId}: ${verifiedIds.join(', ')}`);
      }

      return verifiedIds;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('timeout') || errMsg.includes('ECONNRESET')) {
        logger.debug(`YouTube: multi-stream scrape for ${channelId} timed out`);
      } else {
        logger.warn(`YouTube: multi-stream scrape failed for ${channelId}`, { error: errMsg });
      }
      return [];
    }
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

      // ── Step 1b: Verify the video actually belongs to this channel ────
      // YouTube's /live page can redirect to recommended streams from OTHER channels.
      // Check channelId in videoDetails to avoid tracking the wrong stream.
      const videoChannelMatch = html.match(/"videoDetails":\{[^}]*"channelId":"(UC[a-zA-Z0-9_-]+)"/);
      if (videoChannelMatch && videoChannelMatch[1] !== channelId) {
        logger.debug(`YouTube scrape: ${channelId} /live page shows video from different channel ${videoChannelMatch[1]}, treating as offline`);
        return null;
      }

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
      // IMPORTANT: YouTube pages embed multiple JSON objects and originalViewCount
      // can appear in different contexts. We specifically look for it inside a
      // videoViewCountRenderer with isLive:true — this is the "X watching now" display.
      concurrentViewers = extractLiveConcurrentViewers(html);

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

      // Concurrent viewers — use context-aware extraction to avoid picking up
      // total view counts from other JSON objects on the page
      concurrentViewers = extractLiveConcurrentViewers(html);

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

  // ── Viewer count resolution ──────────────────────────────────────────

  /**
   * Resolves the final viewer count by preferring scraped data (validated via
   * "watching now" text) and falling back to API data when scraper returns 0.
   */
  private resolveViewerCount(
    scraped: ScrapedLiveData,
    apiVideo: YouTubeVideoItem | undefined,
    identifier: string,
  ): number {
    const scrapedViewers = scraped.concurrentViewers;
    const apiViewers = apiVideo?.liveStreamingDetails?.concurrentViewers
      ? parseInt(apiVideo.liveStreamingDetails.concurrentViewers, 10)
      : null;

    if (scrapedViewers === 0 && apiViewers !== null) {
      logger.debug(`YouTube: scraper returned 0 for ${identifier}, using API value: ${apiViewers}`);
      return apiViewers;
    }
    if (apiViewers !== null && apiViewers !== scrapedViewers) {
      logger.debug(`YouTube: scraper=${scrapedViewers}, API=${apiViewers} for ${identifier} — using scraper (validated)`);
    }
    return scrapedViewers;
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

      // Channel is live — check if this is a multi-stream channel
      const isMultiStream = this.multiStreamChannels.has(resolvedId.toLowerCase()) ||
        this.multiStreamChannels.has(originalId.toLowerCase());

      if (isMultiStream) {
        // Multi-stream: detect ALL live streams on this channel
        const allLiveVideoIds = await this.scrapeChannelLiveVideoIds(resolvedId);

        if (allLiveVideoIds.length > 1) {
          // Multiple simultaneous streams detected — scrape each one individually
          // IMPORTANT: We must scrape each video via /watch?v= because the /channel/live
          // page returns garbage viewer counts when multiple streams are active.
          logger.info(`YouTube: multi-stream channel ${originalId} has ${allLiveVideoIds.length} live streams`);

          for (const liveVideoId of allLiveVideoIds) {
            // Always scrape each video individually — never reuse /channel/live data
            // because /channel/live returns wrong CCV when multiple streams are active
            const streamData = await this.scrapeVideoLiveData(liveVideoId);

            if (!streamData) continue;

            // Try API enrichment for this video
            const apiVideo = videoMap.get(liveVideoId);
            const viewers = this.resolveViewerCount(streamData, apiVideo, originalId);

            results.push({
              channelIdentifier: originalId,
              displayName: apiVideo?.snippet.channelTitle ?? scraped.channelName ?? originalId,
              concurrentViewers: viewers,
              isLive: true,
              language: apiVideo?.snippet.defaultAudioLanguage ?? streamData.language,
              gameName: null,
              title: apiVideo?.snippet.title ?? streamData.title,
              startedAt: apiVideo?.liveStreamingDetails?.actualStartTime ?? streamData.startedAt,
              streamId: liveVideoId,
              streamTitle: apiVideo?.snippet.title ?? streamData.title ?? undefined,
            });
          }
          continue; // Skip the single-stream path below
        }
        // If only 1 or 0 live videos found, fall through to single-stream path
      }

      // Single-stream path (default for all channels, and multi-stream with only 1 live stream)
      const apiVideo = videoMap.get(scraped.videoId);
      const finalViewers = this.resolveViewerCount(scraped, apiVideo, originalId);

      results.push({
        channelIdentifier: originalId,
        displayName: apiVideo?.snippet.channelTitle ?? scraped.channelName ?? originalId,
        concurrentViewers: finalViewers,
        isLive: true,
        language: apiVideo?.snippet.defaultAudioLanguage ?? scraped.language,
        gameName: null,
        title: apiVideo?.snippet.title ?? scraped.title,
        startedAt: apiVideo?.liveStreamingDetails?.actualStartTime ?? scraped.startedAt,
        streamId: scraped.videoId.startsWith('unknown-') ? undefined : scraped.videoId,
        streamTitle: apiVideo?.snippet.title ?? scraped.title ?? undefined,
      });
    }

    const liveCount = results.filter((r) => r.isLive).length;
    const multiStreamCount = results.length - channelIdentifiers.length;
    logger.debug(`YouTube getViewerCounts: ${liveCount} live snapshots from ${channelIdentifiers.length} channels${multiStreamCount > 0 ? ` (${multiStreamCount} extra from multi-stream)` : ''}`, {
      quotaUsed: this.quotaUsed,
      apiEnriched: videoDetails.length,
      scrapedLive: scrapedData.size,
      mode: apiAvailable ? 'api+scrape' : 'scrape-only',
    });
    return results;
  }

  /**
   * Searches for live streams (used by Discovery).
   *
   * Quota-optimized: performs a SINGLE search using the game name (gameId field),
   * then filters results client-side by keywords. No category filter — YouTube's
   * search engine handles relevance well enough.
   *
   * If gameId is blank, falls back to searching each keyword individually.
   *
   * Up to 4 pages (200 results) per search term. Each page costs 100 quota units.
   */
  async searchLiveStreams(
    gameId?: string,
    keywords?: string[],
    _categoryIds?: string[],
  ): Promise<DiscoveredStream[]> {
    // Determine search term(s):
    // - If gameId is set: single search for the game name (e.g. "Counter-Strike 2")
    // - If no gameId: search each keyword individually (fallback)
    const searchTerms: string[] = [];
    if (gameId) {
      searchTerms.push(gameId);
    } else if (keywords && keywords.length > 0) {
      searchTerms.push(...keywords);
    } else {
      return [];
    }

    const seenVideoIds = new Set<string>();
    const searchResults: Array<{ videoId: string; snippet: YouTubeSearchItem['snippet'] }> = [];
    const MAX_PAGES = 4; // 4 pages × 50 = up to 200 results per search term

    for (const searchTerm of searchTerms) {
      if (!this.consumeQuota(QUOTA_COST.search, `searchLiveStreams("${searchTerm}")`)) {
        break;
      }

      let nextPageToken: string | undefined;

      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.requestWithRetry(async () => {
          const params: Record<string, string | number> = {
            q: searchTerm,
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
        }, `searchLiveStreams("${searchTerm}" p${page + 1})`);

        if (!result || result.items.length === 0) break;

        for (const item of result.items) {
          if (!seenVideoIds.has(item.id.videoId)) {
            seenVideoIds.add(item.id.videoId);
            searchResults.push({ videoId: item.id.videoId, snippet: item.snippet });
          }
        }

        nextPageToken = result.nextPageToken;
        if (!nextPageToken) break; // No more pages

        // Additional pages cost quota too
        if (page < MAX_PAGES - 1 && !this.consumeQuota(QUOTA_COST.search, `searchLiveStreams("${searchTerm}") p${page + 2}`)) {
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
      gameId,
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

/**
 * Extracts the live concurrent viewer count from YouTube page HTML.
 *
 * YouTube pages embed multiple JSON objects. The `originalViewCount` field
 * can appear in different contexts — sometimes as total video views (all-time)
 * and sometimes as live concurrent viewers. We specifically look for it inside
 * a `videoViewCountRenderer` that has `isLive: true`, which is the "X watching now"
 * display component on live streams.
 *
 * Returns 0 if no live viewer count is found.
 */
function extractLiveConcurrentViewers(html: string): number {
  // Strategy 1: Find the "videoViewCountRenderer" JSON block with "isLive":true.
  // IMPORTANT: We search for `"videoViewCountRenderer":` (with the colon) because
  // YouTube pages also list renderer names in comma-separated arrays — searching
  // without the colon would match that list entry first (wrong location).
  //
  // The block looks like:
  //   "videoViewCountRenderer":{"viewCount":{"runs":[{"text":"18"},{"text":" watching now"}]},"isLive":true,"originalViewCount":"18"}
  //
  // NOTE: The "runs" text is LOCALIZED (e.g. "watching now" in English, "Zuschauer"
  // in German, etc.). We CANNOT rely on "watching now" for servers in non-English
  // locales. Instead we check for "isLive":true which is always in English.
  const rendererIdx = html.indexOf('"videoViewCountRenderer":');
  if (rendererIdx !== -1) {
    const chunk = html.substring(rendererIdx, rendererIdx + 500);
    const hasIsLive = chunk.includes('"isLive":true');
    const viewCountMatch = chunk.match(/"originalViewCount":"(\d+)"/);
    if (hasIsLive && viewCountMatch) {
      logger.debug(`YouTube: extracted viewers via videoViewCountRenderer (isLive=true): ${viewCountMatch[1]}`);
      return parseInt(viewCountMatch[1], 10);
    }
  }

  // Strategy 2: Look for "originalViewCount" near localized "watching" text or "isLive".
  const allViewCounts = [...html.matchAll(/"originalViewCount":"(\d+)"/g)];
  for (const match of allViewCounts) {
    const pos = match.index!;
    const lookback = html.substring(Math.max(0, pos - 300), pos + match[0].length);
    // Check for either English "watching now" OR the language-agnostic "isLive":true
    if (lookback.includes('"isLive":true') || lookback.toLowerCase().includes('watching now')) {
      logger.debug(`YouTube: extracted viewers via isLive/watching proximity: ${match[1]}`);
      return parseInt(match[1], 10);
    }
  }

  logger.warn('YouTube: could not extract live concurrent viewers — no isLive context found');
  return 0;
}
