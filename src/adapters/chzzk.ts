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

interface ChzzkLiveDetailResponse {
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
    openDate: string | null;
    channel?: {
      channelId: string;
      channelName: string;
      channelImageUrl: string | null;
      verifiedMark: boolean;
    };
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

interface ChzzkCategoryLivesResponse {
  code: number;
  content: {
    page: { next: { concurrentUserCount: number; liveId: number } | null } | null;
    data: Array<{
      liveId: number;
      liveTitle: string | null;
      concurrentUserCount: number;
      /** "2026-11-18 19:24:37", Korea time. */
      openDate: string | null;
      liveCategory: string | null;
      liveCategoryValue: string | null;
      channel?: { channelId: string; channelName: string; channelImageUrl: string | null };
    }>;
  } | null;
}

/** Items per category page (the site itself asks for 20 to 50). */
const CATEGORY_PAGE_SIZE = 50;

/** "2026-11-18 19:24:37" in Korea time → ISO, or null when unreadable. */
export function chzzkOpenDateToIso(openDate: string | null | undefined): string | null {
  if (!openDate || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(openDate)) return null;
  const t = new Date(`${openDate.replace(' ', 'T')}+09:00`);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
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
        // Fetch live detail (v3 endpoint includes channel info)
        const liveData = await this.fetchLiveDetail(channelId);

        // Cache channel name from embedded channel object
        if (liveData?.channel?.channelName) {
          this.nameCache.set(channelId, liveData.channel.channelName);
        } else if (!this.nameCache.has(channelId)) {
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

  /**
   * Live streams of one category, largest audience first, for the live
   * game tracker. `category` is the id from the category URL
   * ("Grand_Theft_Auto_VI"; "TYPE/id" for a type other than GAME).
   * Reading stops at the first page wholly below `minViewers`. Throws when
   * the first page cannot be read, so the caller can tell a failed listing
   * from an empty category.
   */
  async listCategoryLives(
    category: string,
    opts: { minViewers?: number; maxPages?: number } = {},
  ): Promise<DiscoveredStream[]> {
    const path = category.includes('/') ? category : `GAME/${category}`;
    const floor = opts.minViewers ?? 0;
    const maxPages = Math.max(1, opts.maxPages ?? 20);
    const out: DiscoveredStream[] = [];
    const seen = new Set<string>();
    let next: { concurrentUserCount: number; liveId: number } | null = null;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await this.delay(INTER_REQUEST_DELAY_MS);
      const cursor: Record<string, number> = next ?? {};
      const res = await this.requestWithRetry(
        () =>
          this.client.get<ChzzkCategoryLivesResponse>(`/service/v2/categories/${path}/lives`, {
            params: { size: CATEGORY_PAGE_SIZE, sortType: 'POPULAR', ...cursor },
          }),
        `categoryLives(${path} p${page + 1})`,
      );
      const content = res?.data?.content;
      if (!content || !Array.isArray(content.data)) {
        if (page === 0) throw new Error(`Chzzk category ${path} could not be listed`);
        break;
      }
      for (const item of content.data) {
        const channelId = item.channel?.channelId;
        if (!channelId || seen.has(channelId)) continue;
        seen.add(channelId);
        out.push({
          channelIdentifier: channelId,
          displayName: item.channel?.channelName || channelId,
          concurrentViewers: item.concurrentUserCount ?? 0,
          language: 'ko', // Chzzk is Korean-only
          title: item.liveTitle ?? '',
          gameName: item.liveCategoryValue ?? null,
          startedAt: chzzkOpenDateToIso(item.openDate),
          streamId: item.liveId != null ? String(item.liveId) : null,
          platformCategoryId: item.liveCategory ?? null,
        });
      }
      if (content.data.length === 0 || content.data.every((i) => (i.concurrentUserCount ?? 0) < floor)) break;
      next = content.page?.next ?? null;
      if (!next) break;
    }
    return out;
  }

  // ── Private: API fetching ───────────────────────────────────────────────

  private async fetchLiveDetail(
    channelId: string,
  ): Promise<ChzzkLiveDetailResponse['content']> {
    const res = await this.requestWithRetry(
      () =>
        this.client.get<ChzzkLiveDetailResponse>(
          `/service/v3/channels/${channelId}/live-detail`,
        ),
      `liveDetail(${channelId})`,
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
