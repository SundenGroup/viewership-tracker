import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// ── Trovo API ─────────────────────────────────────────────────────────────
// Docs: https://developer.trovo.live/docs/APIs.html
// If client ID is available, uses the official API; otherwise scrapes channel pages.

const TROVO_API_BASE = 'https://open-api.trovo.live/openplatform';
const TROVO_WEB_BASE = 'https://trovo.live';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const INTER_REQUEST_DELAY_MS = 200;

// ── Trovo API response shapes ─────────────────────────────────────────────

interface TrovoChannelInfo {
  is_live: boolean;
  username: string;
  nickname: string;
  channel_url: string;
  current_viewers: number;
  category_name: string;
  live_title: string;
  language_code: string;
  started_at: string;
}

// ── TrovoAdapter ──────────────────────────────────────────────────────────

export class TrovoAdapter implements PlatformAdapter {
  readonly platform = 'trovo';

  private readonly clientId: string;
  private readonly client: AxiosInstance;
  private readonly scraper: AxiosInstance;

  constructor(clientId?: string) {
    this.clientId = clientId ?? (config as unknown as Record<string, Record<string, string>>).trovo?.clientId ?? '';

    this.client = axios.create({
      baseURL: TROVO_API_BASE,
      timeout: 10_000,
      headers: {
        Accept: 'application/json',
        'Client-ID': this.clientId,
      },
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

  // ── PlatformAdapter: getViewerCounts ────────────────────────────────────

  async getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]> {
    if (channelIdentifiers.length === 0) return [];

    const results: ChannelSnapshot[] = [];

    for (let i = 0; i < channelIdentifiers.length; i++) {
      const username = channelIdentifiers[i];
      if (i > 0) await this.delay(INTER_REQUEST_DELAY_MS);

      try {
        const info = this.clientId
          ? await this.fetchViaAPI(username)
          : await this.fetchViaScraping(username);

        if (info && info.isLive) {
          results.push({
            channelIdentifier: username,
            displayName: info.displayName,
            concurrentViewers: info.viewers,
            isLive: true,
            language: info.language,
            gameName: info.category,
            title: info.title,
            startedAt: info.startedAt,
          });
        } else {
          results.push(this.offlineSnapshot(username, info?.displayName));
        }
      } catch (err) {
        logger.warn('[Trovo] Error fetching channel', {
          username,
          error: (err as Error).message,
        });
        results.push(this.offlineSnapshot(username));
      }
    }

    return results;
  }

  // ── PlatformAdapter: searchLiveStreams ───────────────────────────────────

  async searchLiveStreams(
    _gameId?: string,
    _keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    // Manual tracking only for now
    return [];
  }

  // ── Private: API-based fetching ─────────────────────────────────────────

  private async fetchViaAPI(
    username: string,
  ): Promise<{
    isLive: boolean;
    displayName: string;
    viewers: number;
    language: string | null;
    category: string | null;
    title: string | null;
    startedAt: string | null;
  } | null> {
    try {
      // Trovo's getChannelInfoByName endpoint
      const res = await this.requestWithRetry(
        () =>
          this.client.post<TrovoChannelInfo>('/channels/id', {
            username,
          }),
        `getChannel(${username})`,
      );

      if (!res?.data) return null;

      const data = res.data;
      return {
        isLive: data.is_live,
        displayName: data.nickname || data.username || username,
        viewers: data.current_viewers ?? 0,
        language: data.language_code || null,
        category: data.category_name || null,
        title: data.live_title || null,
        startedAt: data.started_at || null,
      };
    } catch (err) {
      logger.debug('[Trovo] API fetch failed, falling back to scraping', {
        username,
        error: (err as Error).message,
      });
      return this.fetchViaScraping(username);
    }
  }

  // ── Private: Scraping-based fetching ────────────────────────────────────

  private async fetchViaScraping(
    username: string,
  ): Promise<{
    isLive: boolean;
    displayName: string;
    viewers: number;
    language: string | null;
    category: string | null;
    title: string | null;
    startedAt: string | null;
  } | null> {
    try {
      const url = `${TROVO_WEB_BASE}/${username}`;
      const res = await this.scraper.get<string>(url);
      const html = res.data;

      if (!html || typeof html !== 'string') return null;

      // Trovo embeds channel data as JSON in script tags
      const stateMatch = html.match(/__NEXT_DATA__\s*=\s*({.+?})\s*<\/script>/s) ||
        html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});?\s*<\/script>/s);

      if (stateMatch) {
        try {
          const state = JSON.parse(stateMatch[1]);

          // Navigate the state object for channel data
          const channelData =
            state?.props?.pageProps?.channelInfo ??
            state?.channel?.channelInfo ??
            state?.liveInfo;

          if (channelData) {
            return {
              isLive: !!channelData.is_live,
              displayName: channelData.nickname || channelData.username || username,
              viewers: channelData.current_viewers ?? 0,
              language: channelData.language_code || null,
              category: channelData.category_name || null,
              title: channelData.live_title || null,
              startedAt: channelData.started_at || null,
            };
          }
        } catch {
          // JSON parse failed — fall through to regex
        }
      }

      // Fallback: regex extraction
      const viewerMatch = html.match(/["']current_viewers["']\s*:\s*(\d+)/);
      const isLive = html.includes('"is_live":true') || html.includes("'is_live':true");
      const nameMatch = html.match(/["']nickname["']\s*:\s*["']([^"']+)["']/);

      return {
        isLive,
        displayName: nameMatch?.[1] ?? username,
        viewers: viewerMatch ? parseInt(viewerMatch[1], 10) : 0,
        language: null,
        category: null,
        title: null,
        startedAt: null,
      };
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      if (status === 404) {
        logger.debug('[Trovo] Channel not found', { username });
      } else {
        logger.warn('[Trovo] Scraping failed', { username, error: (err as Error).message });
      }
      return null;
    }
  }

  // ── Private: Helpers ────────────────────────────────────────────────────

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

        if (status && status >= 400 && status < 500 && status !== 429) {
          return null;
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.debug(`[Trovo] ${context}: retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    logger.warn(`[Trovo] ${context}: all retries exhausted`);
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
