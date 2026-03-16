import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// ── Chzzk (Naver) reverse-engineered API ──────────────────────────────────
// No official public API. These endpoints are publicly accessible without auth.
// Channel identifiers are 32-char hex IDs (e.g., "17f0cfcba4ff608de5eabb5110d134d0")

const CHZZK_API_BASE = 'https://api.chzzk.naver.com';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const INTER_REQUEST_DELAY_MS = 300;

// ── Chzzk API response shapes ─────────────────────────────────────────────

interface ChzzkLiveStatusResponse {
  code: number;
  message: string | null;
  content: {
    status: string; // "OPEN" | "CLOSE"
    concurrentUserCount: number;
    accumulateCount: number;
    liveTitle: string | null;
    liveCategory: string | null;
    liveCategoryValue: string | null;
    chatChannelId: string | null;
    adult: boolean;
    faultStatus: string | null;
  } | null;
}

interface ChzzkChannelResponse {
  code: number;
  content: {
    channelId: string;
    channelName: string;
    channelImageUrl: string | null;
    followerCount: number;
  } | null;
}

// ── ChzzkAdapter ──────────────────────────────────────────────────────────

export class ChzzkAdapter implements PlatformAdapter {
  readonly platform = 'chzzk';

  private readonly client: AxiosInstance;
  private readonly nameCache = new Map<string, string>(); // channelId → channelName

  constructor() {
    this.client = axios.create({
      baseURL: CHZZK_API_BASE,
      timeout: 10_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
  }

  // ── PlatformAdapter: getViewerCounts ────────────────────────────────────

  async getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]> {
    if (channelIdentifiers.length === 0) return [];

    const results: ChannelSnapshot[] = [];

    for (let i = 0; i < channelIdentifiers.length; i++) {
      const channelId = channelIdentifiers[i];
      if (i > 0) await this.delay(INTER_REQUEST_DELAY_MS);

      try {
        // Fetch live status
        const liveData = await this.fetchLiveStatus(channelId);

        // Fetch channel name if not cached
        if (!this.nameCache.has(channelId)) {
          await this.fetchChannelInfo(channelId);
        }
        const displayName = this.nameCache.get(channelId) ?? channelId;

        if (liveData && liveData.status === 'OPEN') {
          results.push({
            channelIdentifier: channelId,
            displayName,
            concurrentViewers: liveData.concurrentUserCount ?? 0,
            isLive: true,
            language: 'ko', // Chzzk is Korean-only
            gameName: liveData.liveCategory ?? null,
            title: liveData.liveTitle ?? null,
            startedAt: null,
          });
        } else {
          results.push(this.offlineSnapshot(channelId, displayName));
        }
      } catch (err) {
        logger.warn('[Chzzk] Error fetching channel', {
          channelId,
          error: (err as Error).message,
        });
        results.push(this.offlineSnapshot(channelId));
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

  // ── Private: API fetching ───────────────────────────────────────────────

  private async fetchLiveStatus(
    channelId: string,
  ): Promise<ChzzkLiveStatusResponse['content']> {
    const res = await this.requestWithRetry(
      () =>
        this.client.get<ChzzkLiveStatusResponse>(
          `/polling/v1/channels/${channelId}/live-status`,
        ),
      `liveStatus(${channelId})`,
    );

    if (!res?.data?.content) return null;
    return res.data.content;
  }

  private async fetchChannelInfo(channelId: string): Promise<void> {
    try {
      const res = await this.client.get<ChzzkChannelResponse>(
        `/service/v1/channels/${channelId}`,
      );

      if (res.data?.content?.channelName) {
        this.nameCache.set(channelId, res.data.content.channelName);
      }
    } catch (err) {
      logger.debug('[Chzzk] Failed to fetch channel info', {
        channelId,
        error: (err as Error).message,
      });
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
          logger.debug(`[Chzzk] ${context}: retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    logger.warn(`[Chzzk] ${context}: all retries exhausted`);
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
