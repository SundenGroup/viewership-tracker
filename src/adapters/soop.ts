import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// ── Soop (formerly AfreecaTV) ─────────────────────────────────────────────
// Official API restricted to partnerships. Uses undocumented endpoints
// based on yt-dlp/streamlink reverse engineering.
// Channel identifiers are BJ IDs (usernames, e.g., "vf3366").

const SOOP_LIVE_API = 'https://live.sooplive.co.kr/afreeca/player_live_api.php';
const SOOP_STATION_API = 'https://chapi.sooplive.co.kr/api';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const INTER_REQUEST_DELAY_MS = 300;

// ── Soop API response shapes ──────────────────────────────────────────────

interface SoopLiveResponse {
  CHANNEL: {
    RESULT: number; // 1 = success
    BESSION?: string;
    BJID?: string;
    BJNICK?: string;
    BJGRADE?: number;
    CHDOMAIN?: string;
    CHATNO?: string;
    FTK?: string;
    TITLE?: string;
    BNO?: string; // Broadcast number (non-empty if live)
    VIEWCNT?: number;
    CATEGORY?: string;
    GRADE?: number;
  };
}

interface SoopStationResponse {
  station?: {
    user_nick: string;
    user_id: string;
    station_title: string;
  };
  broad?: {
    broad_no: number;
    broad_title: string;
    current_sum_viewer: number;
    broad_grade: number;
    broad_start: string;
  } | null;
}

// ── SoopAdapter ───────────────────────────────────────────────────────────

export class SoopAdapter implements PlatformAdapter {
  readonly platform = 'soop';

  private readonly client: AxiosInstance;
  private readonly nameCache = new Map<string, string>(); // bjId → nickname

  constructor() {
    this.client = axios.create({
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
      const bjId = channelIdentifiers[i];
      if (i > 0) await this.delay(INTER_REQUEST_DELAY_MS);

      try {
        // Try station API first (cleaner response), fall back to player_live_api
        const info = await this.fetchViaStationAPI(bjId) ?? await this.fetchViaLiveAPI(bjId);

        if (info && info.isLive) {
          results.push({
            channelIdentifier: bjId,
            displayName: info.displayName,
            concurrentViewers: info.viewers,
            isLive: true,
            language: 'ko', // Soop is Korean-centric
            gameName: info.category,
            title: info.title,
            startedAt: info.startedAt,
          });
        } else {
          const displayName = info?.displayName ?? this.nameCache.get(bjId) ?? bjId;
          results.push(this.offlineSnapshot(bjId, displayName));
        }
      } catch (err) {
        logger.warn('[Soop] Error fetching channel', {
          bjId,
          error: (err as Error).message,
        });
        results.push(this.offlineSnapshot(bjId));
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

  // ── Private: Station API (preferred) ────────────────────────────────────

  private async fetchViaStationAPI(
    bjId: string,
  ): Promise<{
    isLive: boolean;
    displayName: string;
    viewers: number;
    category: string | null;
    title: string | null;
    startedAt: string | null;
  } | null> {
    try {
      const res = await this.requestWithRetry(
        () =>
          this.client.get<SoopStationResponse>(
            `${SOOP_STATION_API}/${bjId}/station`,
          ),
        `station(${bjId})`,
      );

      if (!res?.data) return null;

      const { station, broad } = res.data;
      const displayName = station?.user_nick ?? bjId;
      this.nameCache.set(bjId, displayName);

      if (broad && broad.broad_no) {
        return {
          isLive: true,
          displayName,
          viewers: broad.current_sum_viewer ?? 0,
          category: null, // Station API doesn't reliably return category
          title: broad.broad_title ?? null,
          startedAt: broad.broad_start ?? null,
        };
      }

      return { isLive: false, displayName, viewers: 0, category: null, title: null, startedAt: null };
    } catch (err) {
      logger.debug('[Soop] Station API failed', { bjId, error: (err as Error).message });
      return null;
    }
  }

  // ── Private: player_live_api (fallback) ─────────────────────────────────

  private async fetchViaLiveAPI(
    bjId: string,
  ): Promise<{
    isLive: boolean;
    displayName: string;
    viewers: number;
    category: string | null;
    title: string | null;
    startedAt: string | null;
  } | null> {
    try {
      const res = await this.requestWithRetry(
        () =>
          this.client.post<SoopLiveResponse>(
            SOOP_LIVE_API,
            new URLSearchParams({ bjid: bjId, type: 'live' }).toString(),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
            },
          ),
        `liveApi(${bjId})`,
      );

      if (!res?.data?.CHANNEL) return null;

      const ch = res.data.CHANNEL;
      if (ch.RESULT !== 1) return null;

      const displayName = ch.BJNICK ?? bjId;
      this.nameCache.set(bjId, displayName);

      const isLive = !!ch.BNO && ch.BNO !== '0' && ch.BNO !== '';

      return {
        isLive,
        displayName,
        viewers: ch.VIEWCNT ?? 0,
        category: ch.CATEGORY ?? null,
        title: ch.TITLE ?? null,
        startedAt: null,
      };
    } catch (err) {
      logger.debug('[Soop] Live API failed', { bjId, error: (err as Error).message });
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
          logger.debug(`[Soop] ${context}: retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    logger.warn(`[Soop] ${context}: all retries exhausted`);
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
