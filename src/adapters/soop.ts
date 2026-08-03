import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// ── Soop (formerly AfreecaTV) ─────────────────────────────────────────────
// Official API restricted to partnerships. Uses undocumented endpoints
// based on yt-dlp/streamlink reverse engineering.
// Channel identifiers are BJ IDs (usernames, e.g., "vf3366").

const SOOP_LIVE_API = 'https://live.sooplive.co.kr/afreeca/player_live_api.php';
const SOOP_STATION_API = 'https://chapi.sooplive.co.kr/api';
const SOOP_SEARCH_API = 'https://sch.sooplive.co.kr/api.php';
/** Category pages are 60/req; 5 pages = 300 live streams, plenty for one game. */
const MAX_CATEGORY_PAGES = 5;
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

/** sch.sooplive liveSearch item (keyword search of live broadcasts). */
interface SoopSearchBroadcast {
  user_id?: string;
  user_nick?: string;
  broad_no?: number | string;
  broad_title?: string;
  current_view_cnt?: number | string;
  total_view_cnt?: number | string;
  broad_cate_no?: string;
  broad_cate_name?: string;
  broad_start?: string;
}

interface SoopSearchResponse {
  RESULT?: number | string; // "1" = success
  HAS_MORE_LIST?: boolean;
  REAL_BROAD?: SoopSearchBroadcast[];
}

/** sch.sooplive categoryContentsList item (live listing for one category). */
interface SoopCategoryBroadcast {
  user_id?: string;
  user_nick?: string;
  broad_no?: number | string;
  broad_title?: string;
  view_cnt?: number | string;
  broad_start?: string;
}

interface SoopCategoryResponse {
  result?: number | string;
  data?: { is_more?: boolean; list?: SoopCategoryBroadcast[] };
}

/**
 * SOOP timestamps are naive KST strings ("2026-08-05 21:30:00"). Parse as
 * Asia/Seoul or every session start shifts nine hours.
 */
export function soopKstToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+09:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** liveSearch item → DiscoveredStream (null when the row is unusable). */
export function mapSoopSearchItem(b: SoopSearchBroadcast): DiscoveredStream | null {
  if (!b.user_id) return null;
  const viewers = Number(b.current_view_cnt ?? b.total_view_cnt ?? 0);
  return {
    channelIdentifier: b.user_id,
    displayName: b.user_nick || b.user_id,
    concurrentViewers: Number.isFinite(viewers) ? viewers : 0,
    language: 'ko',
    title: b.broad_title ?? '',
    gameName: b.broad_cate_name ?? null,
    startedAt: soopKstToIso(b.broad_start),
    streamId: b.broad_no != null ? String(b.broad_no) : undefined,
  };
}

/** categoryContentsList item → DiscoveredStream. */
export function mapSoopCategoryItem(b: SoopCategoryBroadcast): DiscoveredStream | null {
  if (!b.user_id) return null;
  const viewers = Number(b.view_cnt ?? 0);
  return {
    channelIdentifier: b.user_id,
    displayName: b.user_nick || b.user_id,
    concurrentViewers: Number.isFinite(viewers) ? viewers : 0,
    language: 'ko',
    title: b.broad_title ?? '',
    gameName: null, // caller overlays the tracker's category name
    startedAt: soopKstToIso(b.broad_start),
    streamId: b.broad_no != null ? String(b.broad_no) : undefined,
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
    gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    // Two modes, both zero-auth JSON off sch.sooplive.co.kr:
    //   keywords → liveSearch, one request per keyword (event discovery)
    //   gameId   → categoryContentsList paginated (Discover trackers;
    //              8-digit zero-padded category codes, e.g. PUBG 00040066)
    // Fail soft everywhere — discovery must never take a poll cycle down.
    const byId = new Map<string, DiscoveredStream>();

    const kws = (keywords ?? []).map((k) => k.trim()).filter(Boolean);
    for (let i = 0; i < kws.length; i++) {
      if (i > 0) await this.delay(INTER_REQUEST_DELAY_MS);
      for (const stream of await this.searchByKeyword(kws[i]!)) {
        if (!byId.has(stream.channelIdentifier)) byId.set(stream.channelIdentifier, stream);
      }
    }

    if (gameId) {
      if (kws.length > 0) await this.delay(INTER_REQUEST_DELAY_MS);
      for (const stream of await this.listCategory(gameId)) {
        if (!byId.has(stream.channelIdentifier)) byId.set(stream.channelIdentifier, stream);
      }
    }

    for (const s of byId.values()) this.nameCache.set(s.channelIdentifier, s.displayName);
    return [...byId.values()];
  }

  /** Category directory search — feeds the admin "pick a category" list. */
  async searchCategories(query: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.requestWithRetry(
        () =>
          this.client.get<{
            result?: number | string;
            data?: { list?: Array<{ category_no?: string; category_name?: string }> };
          }>(SOOP_SEARCH_API, {
            params: {
              m: 'categoryList',
              szKeyword: query,
              szOrder: 'view_cnt',
              nPageNo: 1,
              nListCnt: 60,
              nOffset: 0,
              szPlatform: 'pc',
            },
          }),
        `categorySearch(${query})`,
      );
      const list = res?.data?.data?.list;
      if (!Array.isArray(list)) return [];
      const q = query.toLowerCase();
      return list
        .filter((c) => c.category_no && c.category_name)
        .filter((c) => !q || c.category_name!.toLowerCase().includes(q) || /pubg|배틀그라운드/i.test(c.category_name!))
        .map((c) => ({ id: c.category_no!, name: c.category_name! }));
    } catch (err) {
      logger.warn('[Soop] category search failed', { query, error: (err as Error).message });
      return [];
    }
  }

  /** Keyword search of live broadcasts (sch liveSearch). */
  private async searchByKeyword(keyword: string): Promise<DiscoveredStream[]> {
    try {
      const res = await this.requestWithRetry(
        () =>
          this.client.get<SoopSearchResponse>(SOOP_SEARCH_API, {
            params: {
              m: 'liveSearch',
              v: '1.0',
              c: 'UTF-8',
              szType: 'json',
              szOrder: 'view_cnt',
              szKeyword: keyword,
              nPageNo: 1,
              nListCnt: 60,
            },
          }),
        `liveSearch(${keyword})`,
      );
      const body = res?.data;
      if (!body || String(body.RESULT) !== '1' || !Array.isArray(body.REAL_BROAD)) return [];
      return body.REAL_BROAD.map(mapSoopSearchItem).filter(
        (x): x is DiscoveredStream => x !== null,
      );
    } catch (err) {
      logger.warn('[Soop] keyword search failed', { keyword, error: (err as Error).message });
      return [];
    }
  }

  /** Full live listing for one category, paginated (sch categoryContentsList). */
  private async listCategory(cateNo: string): Promise<DiscoveredStream[]> {
    const out: DiscoveredStream[] = [];
    try {
      for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
        if (page > 1) await this.delay(INTER_REQUEST_DELAY_MS);
        const res = await this.requestWithRetry(
          () =>
            this.client.get<SoopCategoryResponse>(SOOP_SEARCH_API, {
              params: {
                m: 'categoryContentsList',
                szType: 'live',
                szCateNo: cateNo,
                szPlatform: 'pc',
                szOrder: 'view_cnt_desc',
                nPageNo: page,
                nListCnt: 60,
              },
            }),
          `categoryList(${cateNo} p${page})`,
        );
        const body = res?.data;
        if (!body || String(body.result) !== '1' || !Array.isArray(body.data?.list)) break;
        out.push(
          ...body.data.list.map(mapSoopCategoryItem).filter(
            (x): x is DiscoveredStream => x !== null,
          ),
        );
        if (!body.data.is_more) break;
      }
    } catch (err) {
      logger.warn('[Soop] category listing failed', { cateNo, error: (err as Error).message });
    }
    return out;
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
