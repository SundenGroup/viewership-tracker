import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';
import * as YouTubeApiKeyModel from '../models/youtube-api-key';
import { getPushNotifier } from '../services/push-notifier';

/** Throttle: fire "quota exhausted" push at most once per 24h per process. */
const QUOTA_EXHAUSTED_PUSH_THROTTLE_MS = 24 * 60 * 60_000;
let lastQuotaExhaustedPushAt = 0;

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
  /**
   * Per-channel "last seen" map for multi-stream videoIds. When a fresh
   * scrape misses a videoId we recently saw on this channel, we keep it
   * in the returned set for STICKY_TTL — the orchestrator will poll it
   * one more time and only drop it if it confirms offline. Prevents the
   * 8:38pm-style 1-minute crashes where the channel's main stream
   * temporarily disappears from the /streams scrape.
   */
  private readonly stickyLiveVideoIds = new Map<string, Map<string, number>>();
  private static readonly STICKY_VIDEO_TTL_MS = 10 * 60_000;
  private quotaUsed = 0;
  private quotaResetDate: string = todayDateString();
  private readonly quotaLimit: number;
  private static readonly QUOTA_FILE = path.resolve(process.cwd(), '.youtube-quota.json');

  /**
   * Per-key usage counters for the discovery key pool. The keys are DB-stored
   * partner-tagged keys consulted only by the discovery path; polling stays
   * on the legacy single-key counter above.
   */
  private perKeyUsed = new Map<string, number>();
  private perKeyResetDate: string = todayDateString();
  private static readonly POOL_QUOTA_FILE = path.resolve(process.cwd(), '.youtube-pool-quota.json');

  constructor(apiKey?: string, quotaLimit?: number) {
    this.apiKey = apiKey ?? config.youtube.apiKey;
    this.quotaLimit = quotaLimit ?? DEFAULT_DAILY_QUOTA;

    // Restore quota counter from disk (survives PM2 restarts)
    this.loadQuotaFromDisk();
    this.loadPoolQuotaFromDisk();

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

      // Push fan-out — at most once per 24h per process
      const now = Date.now();
      if (now - lastQuotaExhaustedPushAt >= QUOTA_EXHAUSTED_PUSH_THROTTLE_MS) {
        lastQuotaExhaustedPushAt = now;
        void getPushNotifier()
          .notify('quota_exhausted', {
            title: 'YouTube quota exhausted',
            body: `Daily quota used: ${this.quotaUsed}/${this.quotaLimit}. Add or rotate keys to resume.`,
            url: '/settings/youtube-keys',
            tag: 'quota_exhausted',
            urgent: true,
          })
          .catch((err) => logger.warn('[Push] quota_exhausted fan-out failed', { error: (err as Error).message }));
      }

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

  // ── Pool quota tracking (discovery only) ──────────────────────────────

  /**
   * Pool quota state for the partner-tagged key pool used by discovery.
   * Polling continues using the legacy single-key tracking above.
   */
  getPoolQuotaUsage(): { date: string; perKey: Record<string, number> } {
    this.resetPoolQuotaIfNewDay();
    return {
      date: this.perKeyResetDate,
      perKey: Object.fromEntries(this.perKeyUsed),
    };
  }

  private resetPoolQuotaIfNewDay(): void {
    const today = todayDateString();
    if (today !== this.perKeyResetDate) {
      this.perKeyUsed.clear();
      this.perKeyResetDate = today;
      this.savePoolQuotaToDisk();
    }
  }

  private loadPoolQuotaFromDisk(): void {
    try {
      if (fs.existsSync(YouTubeAdapter.POOL_QUOTA_FILE)) {
        const raw = fs.readFileSync(YouTubeAdapter.POOL_QUOTA_FILE, 'utf-8');
        const data = JSON.parse(raw) as { date: string; perKey: Record<string, number> };
        if (data.date === todayDateString()) {
          this.perKeyResetDate = data.date;
          this.perKeyUsed = new Map(Object.entries(data.perKey ?? {}));
        }
      }
    } catch {
      // Start fresh
    }
  }

  private savePoolQuotaToDisk(): void {
    try {
      fs.writeFileSync(
        YouTubeAdapter.POOL_QUOTA_FILE,
        JSON.stringify({
          date: this.perKeyResetDate,
          perKey: Object.fromEntries(this.perKeyUsed),
        }),
      );
    } catch {
      // Non-critical
    }
  }

  /**
   * Reserve `cost` units against a specific pool key. Returns true if charged,
   * false if the key has insufficient remaining quota.
   */
  private chargePoolKey(keyId: string, dailyQuota: number, cost: number): boolean {
    this.resetPoolQuotaIfNewDay();
    const used = this.perKeyUsed.get(keyId) ?? 0;
    if (used + cost > dailyQuota) return false;
    this.perKeyUsed.set(keyId, used + cost);
    this.savePoolQuotaToDisk();
    return true;
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

      // Strategy 1: Look for videoRenderer items with LIVE overlay badges.
      // YouTube marks live streams with thumbnailOverlays containing "LIVE" style.
      // The previous regex used `[^}]*?` between videoId and thumbnailOverlays,
      // which stopped at the first `}` inside the nested `thumbnail.thumbnails[]`
      // array — so on real pages it matched zero. Use a lazy character-class
      // window large enough to cross the thumbnails array (~6 KB observed on
      // PUBGEsports /streams page 2026-05-02).
      const videoRendererRegex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,10000}?"thumbnailOverlays":\[[\s\S]{0,2000}?"style":"LIVE"/g;
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

      // Strategy 3: Broader pattern — look for any videoId with a LIVE
      // indicator within a generous window after it. Window bumped from
      // 2 KB → 10 KB after observing 6.3 KB distance on the legacy
      // videoRenderer variant.
      //
      // Multiple page variants are served by YouTube depending on
      // region / A-B test:
      //   • legacy:   `videoRenderer` + `"style":"LIVE"` / `BADGE_STYLE_TYPE_LIVE_NOW` /
      //               `"iconType":"LIVE"`
      //   • new:      `richItemRenderer` + `lockupViewModel` +
      //               `THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE` (badgeStyle field) +
      //               `"imageName":"LIVE"` (clientResource icon)
      // Match either set so the scrape works on both variants. The
      // server in Frankfurt was getting only the new variant on
      // 2026-05-02, which broke multi-stream detection for PUBGEsports
      // mid-broadcast.
      if (liveVideoIds.length === 0) {
        const allVideoIds = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
        for (const vidMatch of allVideoIds) {
          const pos = vidMatch.index!;
          const context = html.substring(pos, pos + 10000);
          const hasLiveIndicator =
            // Legacy variant tokens
            context.includes('"style":"LIVE"') ||
            context.includes('BADGE_STYLE_TYPE_LIVE_NOW') ||
            context.includes('"iconType":"LIVE"') ||
            // New (lockupViewModel) variant tokens
            context.includes('THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') ||
            context.includes('"imageName":"LIVE"');
          if (hasLiveIndicator && !seenIds.has(vidMatch[1])) {
            seenIds.add(vidMatch[1]);
            liveVideoIds.push(vidMatch[1]);
          }
        }
      }

      // Filter out videos that belong to OTHER channels.
      //
      // The /streams page mixes recommendations and sidebar tiles
      // alongside the channel's own broadcasts. The previous heuristic —
      // "look for any channelId in a 3500-char window around the videoId"
      // — is too lenient: the page's header / breadcrumb / common JSON
      // chunks contain the *expected* channelId, so foreign videoIds
      // pass the check and end up in sticky cache for 10 minutes,
      // poisoning that channel's CCV with another channel's data.
      //
      // Use the Videos API as the truth-source: videos.list returns the
      // authoritative snippet.channelId for each id. Drop anything whose
      // owner doesn't match. Cost: 1 quota unit per multi-stream poll
      // cycle (videos.list is 1 unit regardless of batch size, up to 50
      // ids), so well under daily budget.
      //
      // Fail-open on API errors / quota exhaustion (rare): we'd rather
      // accept a transient false positive than blank the channel out
      // for the rest of the broadcast — the channel-ownership step in
      // /watch?v= scrapeVideoLiveData is the second line of defence.
      let verifiedIds = liveVideoIds;
      if (liveVideoIds.length > 0) {
        try {
          const details = await this.getVideoDetails(liveVideoIds);
          const ownerByVideoId = new Map<string, string>();
          for (const v of details) {
            if (v.snippet?.channelId) ownerByVideoId.set(v.id, v.snippet.channelId);
          }
          if (ownerByVideoId.size > 0) {
            const owned: string[] = [];
            const dropped: Array<{ vid: string; owner: string }> = [];
            for (const vid of liveVideoIds) {
              const owner = ownerByVideoId.get(vid);
              if (!owner) {
                // videos.list didn't return this id (deleted, private,
                // or geo-blocked). Be conservative: drop it. A real
                // live stream would always come back from videos.list.
                dropped.push({ vid, owner: '<not-returned>' });
                continue;
              }
              if (owner === channelId) {
                owned.push(vid);
              } else {
                dropped.push({ vid, owner });
              }
            }
            if (dropped.length > 0) {
              logger.info(
                `YouTube: multi-stream scrape for ${channelId} — videos.list rejected ${dropped.length} foreign id(s): ` +
                  dropped.map((d) => `${d.vid}→${d.owner}`).join(', '),
              );
            }
            verifiedIds = owned;
          }
          // Else: API returned nothing (quota exhausted / outage) — keep
          // candidates as-is and let downstream defences handle it.
        } catch (err) {
          logger.warn(
            `YouTube: multi-stream ownership check failed for ${channelId}, falling back to scrape-only`,
            { error: (err as Error).message },
          );
        }
      }

      // Merge with sticky history so a single noisy scrape that misses the
      // channel's main stream doesn't crater attributed CCV. Any videoId
      // observed in the last STICKY_VIDEO_TTL_MS minutes is retained even
      // if absent from this scrape — the orchestrator will poll it one
      // more time and only drop it if it actually reports offline.
      const finalIds = this.applyStickyMerge(channelId, verifiedIds);

      this.multiStreamCache.set(channelId, {
        videoIds: finalIds,
        cachedAt: Date.now(),
      });

      if (finalIds.length > 0) {
        logger.info(`YouTube: ${finalIds.length} live stream(s) on channel ${channelId}: ${finalIds.join(', ')}` +
          (finalIds.length !== verifiedIds.length ? ` (sticky-restored ${finalIds.length - verifiedIds.length})` : ''));
      }

      return finalIds;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('timeout') || errMsg.includes('ECONNRESET')) {
        logger.debug(`YouTube: multi-stream scrape for ${channelId} timed out`);
      } else {
        logger.warn(`YouTube: multi-stream scrape failed for ${channelId}`, { error: errMsg });
      }
      // On scrape failure, fall back to recently-seen videoIds so a transient
      // network blip doesn't drop CCV to zero for the next minute.
      const sticky = this.applyStickyMerge(channelId, []);
      return sticky;
    }
  }

  /**
   * Force-drop a videoId from the sticky cache once we've confirmed it's
   * offline. Called by the multi-stream loop when scrapeVideoLiveData
   * returns null (= /watch?v=VIDEO_ID does not show a live stream).
   */
  private dropStickyVideoId(channelId: string, videoId: string): void {
    const history = this.stickyLiveVideoIds.get(channelId);
    if (history) history.delete(videoId);
  }

  /**
   * Merge a fresh-scrape videoId list with the per-channel sticky history.
   * Returns the union of: the new list (timestamps refreshed) + any
   * historical entry observed within STICKY_VIDEO_TTL_MS.
   */
  private applyStickyMerge(channelId: string, freshIds: string[]): string[] {
    const now = Date.now();
    const history = this.stickyLiveVideoIds.get(channelId) ?? new Map<string, number>();
    // Refresh the lastSeenAt for everything in this scrape
    for (const vid of freshIds) history.set(vid, now);
    // Drop history entries beyond TTL
    for (const [vid, ts] of [...history.entries()]) {
      if (now - ts > YouTubeAdapter.STICKY_VIDEO_TTL_MS) history.delete(vid);
    }
    this.stickyLiveVideoIds.set(channelId, history);
    // Return ordered: fresh videoIds first (likely the channel's current
    // primary), then any sticky-only ones at the end.
    const freshSet = new Set(freshIds);
    const stickyOnly = [...history.keys()].filter((v) => !freshSet.has(v));
    return [...freshIds, ...stickyOnly];
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
      // YouTube's /live page can redirect to recommended streams from OTHER
      // channels (happens when our channel is briefly offline). We MUST
      // discard those scrapes — otherwise we attribute foreign streams'
      // titles and CCVs to our own channel record.
      //
      // Previous regex used `[^}]*` which stopped at the first `}` inside
      // videoDetails (e.g. a nested `thumbnail:{…}`), so on real pages it
      // often failed to find channelId at all — and the old guard was
      // fail-open (`if (match && ...)`). Now: lazy `[\s\S]{0,4000}?` to
      // skip over nested objects, AND fail-closed — if we can't extract
      // the owner channelId, treat as offline. Belt-and-braces: parse
      // ytInitialPlayerResponse below as a second source.
      let videoOwner: string | null = null;
      const m = html.match(/"videoDetails":\{[\s\S]{0,4000}?"channelId":"(UC[a-zA-Z0-9_-]+)"/);
      if (m) videoOwner = m[1];
      if (!videoOwner) {
        // Fall back to parsing the ytInitialPlayerResponse JSON — more
        // robust, handles arbitrarily-nested videoDetails objects.
        const prMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script)/s);
        if (prMatch) {
          try {
            const pr = JSON.parse(prMatch[1]) as { videoDetails?: { channelId?: string } };
            if (pr.videoDetails?.channelId) videoOwner = pr.videoDetails.channelId;
          } catch {
            // JSON parse failed — leave videoOwner null
          }
        }
      }
      // Only fail-closed when we POSITIVELY identified a foreign owner.
      // If videoOwner couldn't be determined at all (page format we don't
      // recognize, missing videoDetails, etc.), fall through and let the
      // discovery-side defense-in-depth (display_name comparison) be the
      // backstop. Original fail-closed-on-missing-owner caused a global
      // 100 % offline reading on 2026-05-01 19:11Z when many channels'
      // /live pages didn't expose videoDetails in our expected shape.
      if (videoOwner && videoOwner !== channelId) {
        logger.debug(`YouTube scrape: ${channelId} /live page shows video from different channel ${videoOwner}, treating as offline`);
        return null;
      }
      if (!videoOwner) {
        logger.debug(`YouTube scrape: ${channelId} — could not extract videoDetails.channelId; proceeding (relying on display_name check downstream)`);
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

            if (!streamData) {
              // Confirmed offline — purge from sticky cache so we don't
              // keep retrying it for STICKY_VIDEO_TTL_MS minutes.
              this.dropStickyVideoId(resolvedId, liveVideoId);
              continue;
            }

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
    partner?: string | null,
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

    /**
     * Pick a key from the discovery pool that has enough remaining quota,
     * charge it, and return a one-shot axios client bound to that key. If
     * no pool key has room, returns null — discovery skips for this cycle
     * (no fall-through to the legacy single key on purpose; the operator
     * sees pool exhaustion in the Settings UI and adds keys).
     */
    const acquirePoolClient = async (
      cost: number,
      context: string,
    ): Promise<{ client: AxiosInstance; keyId: string; keyLabel: string } | null> => {
      const picked = await YouTubeApiKeyModel.pickBestKey(
        partner ?? null,
        cost,
        this.perKeyUsed,
      );
      if (!picked) {
        logger.error(
          `YouTube discovery pool exhausted (partner=${partner ?? 'shared'}, ` +
          `need ${cost} for ${context}). Add a key in Settings or wait for daily reset.`,
        );
        return null;
      }
      if (!this.chargePoolKey(picked.id, picked.daily_quota, cost)) {
        logger.warn(`YouTube pool key ${picked.label} couldn't accept ${cost} units`);
        return null;
      }
      // Touch last_used_at lazily; failure isn't fatal
      YouTubeApiKeyModel.touchLastUsed(picked.id).catch(() => {});
      const client = axios.create({
        baseURL: API_BASE,
        params: { key: picked.secret },
      });
      return { client, keyId: picked.id, keyLabel: picked.label };
    };

    for (const searchTerm of searchTerms) {
      const acquired = await acquirePoolClient(QUOTA_COST.search, `searchLiveStreams("${searchTerm}")`);
      if (!acquired) break;
      let activeClient = acquired.client;
      let activeKeyLabel = acquired.keyLabel;

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

          const { data } = await activeClient.get<YouTubeListResponse<YouTubeSearchItem>>(
            '/search',
            { params },
          );
          return data;
        }, `searchLiveStreams("${searchTerm}" p${page + 1}, key=${activeKeyLabel})`);

        if (!result || result.items.length === 0) break;

        for (const item of result.items) {
          if (!seenVideoIds.has(item.id.videoId)) {
            seenVideoIds.add(item.id.videoId);
            searchResults.push({ videoId: item.id.videoId, snippet: item.snippet });
          }
        }

        nextPageToken = result.nextPageToken;
        if (!nextPageToken) break; // No more pages

        // Additional pages cost quota too — pick a (potentially different)
        // pool key for the next page.
        if (page < MAX_PAGES - 1) {
          const nextAcquired = await acquirePoolClient(
            QUOTA_COST.search,
            `searchLiveStreams("${searchTerm}") p${page + 2}`,
          );
          if (!nextAcquired) break;
          activeClient = nextAcquired.client;
          activeKeyLabel = nextAcquired.keyLabel;
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
      partner: partner ?? null,
      poolUsed: Object.fromEntries(this.perKeyUsed),
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
  // YouTube Data API quotas reset at midnight Pacific Time
  // (https://developers.google.com/youtube/v3/getting-started#quota), NOT
  // midnight UTC. Using ISO/UTC here meant our counter rolled at 00:00 UTC
  // = 17:00 PT — about 7 hours before Google's reset — so for 7 hours each
  // day our "Used today" double-counted calls already charged to Google's
  // previous day. Result: dashboard reading 14K while Google's quotas tab
  // showed 0 right after the PT reset. Lock the day boundary to PT so our
  // counter aligns with Google's billing window.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
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
