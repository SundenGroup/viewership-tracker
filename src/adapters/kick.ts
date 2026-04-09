import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// ── Kick Official API (api.kick.com) ─────────────────────────────────────
const KICK_API_BASE = 'https://api.kick.com';
const KICK_AUTH_BASE = 'https://id.kick.com';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const PARALLEL_BATCH_SIZE = 5;
const INTER_REQUEST_DELAY_MS = 200;
const TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000; // 5 minutes

// ── Kick API response shapes (official public/v1) ───────────────────────

interface KickStream {
  is_live?: boolean;
  is_mature?: boolean;
  viewer_count?: number;
  start_time?: string;
  language?: string;
  thumbnail?: string;
  url?: string;
  custom_tags?: string[];
}

interface KickCategory {
  id?: number;
  name?: string;
  thumbnail?: string;
}

interface KickChannelResponse {
  broadcaster_user_id?: number;
  slug?: string;
  channel_description?: string;
  stream_title?: string;
  banner_picture?: string;
  category?: KickCategory;
  stream?: KickStream;
}

interface KickLivestreamResponse {
  broadcaster_user_id?: number;
  channel_id?: number;
  slug?: string;
  stream_title?: string;
  viewer_count?: number;
  started_at?: string;
  language?: string;
  has_mature_content?: boolean;
  custom_tags?: string[];
  category?: KickCategory;
}

interface KickTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class KickAdapter implements PlatformAdapter {
  readonly platform = 'kick';

  private readonly client: AxiosInstance;
  private readonly authClient: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private circuitOpen = false;
  private circuitOpenedAt = 0;

  constructor() {
    this.client = axios.create({
      baseURL: KICK_API_BASE,
      headers: { Accept: 'application/json' },
      timeout: 10_000,
    });

    this.authClient = axios.create({
      baseURL: KICK_AUTH_BASE,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    // Attach auth interceptor
    this.client.interceptors.request.use(async (reqConfig) => {
      const token = await this.getAccessToken();
      if (token) {
        reqConfig.headers.Authorization = `Bearer ${token}`;
      }
      return reqConfig;
    });
  }

  // ── OAuth2 Client Credentials ─────────────────────────────────────────

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }

    const clientId = config.kick.clientId;
    const clientSecret = config.kick.clientSecret;

    if (!clientId || !clientSecret) {
      logger.warn('Kick: KICK_CLIENT_ID or KICK_CLIENT_SECRET not configured');
      return null;
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      });

      const { data } = await this.authClient.post<KickTokenResponse>(
        '/oauth/token',
        params.toString(),
      );

      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

      logger.info('Kick: OAuth2 token acquired', {
        expiresIn: `${data.expires_in}s`,
        tokenType: data.token_type,
      });

      return this.accessToken;
    } catch (err) {
      const axErr = err as AxiosError;
      logger.error('Kick: failed to acquire OAuth2 token', {
        status: axErr.response?.status,
        message: axErr.message,
        data: axErr.response?.data,
      });
      this.accessToken = null;
      return null;
    }
  }

  // ── Circuit breaker ───────────────────────────────────────────────────

  private isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;
    if (Date.now() - this.circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      logger.info('Kick circuit breaker cooldown elapsed, resetting');
      this.circuitOpen = false;
      return false;
    }
    return true;
  }

  private tripCircuitBreaker(reason: string): void {
    this.circuitOpen = true;
    this.circuitOpenedAt = Date.now();
    logger.error(`Kick circuit breaker tripped: ${reason}. Skipping Kick polling for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
  }

  // ── Health check ──────────────────────────────────────────────────────

  async isAPIAvailable(): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        logger.warn('Kick API health check: no valid token');
        return false;
      }

      // Try fetching a well-known channel to verify API access
      const { status, headers } = await this.client.get('/public/v1/channels', {
        params: { slug: ['kick'] },
        validateStatus: () => true,
      });

      const contentType = headers['content-type'] ?? '';
      if (contentType.includes('json') && status >= 200 && status < 400) {
        return true;
      }

      logger.warn(`Kick API health check: unexpected response status=${status} contentType=${contentType}`);
      return false;
    } catch (err) {
      logger.warn('Kick API health check failed', {
        error: (err as Error).message,
      });
      return false;
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
        const retryable = status !== undefined && (status >= 500 || status === 429);

        // Detect non-JSON responses (API down / returning HTML)
        const contentType = axErr.response?.headers?.['content-type'] ?? '';
        if (axErr.response && !contentType.includes('json')) {
          this.tripCircuitBreaker(`non-JSON response from ${context}: content-type=${contentType}`);
          return null;
        }

        // 401 → try to refresh token once
        if (status === 401 && attempt === 0) {
          logger.warn('Kick: 401 received, forcing token refresh');
          this.accessToken = null;
          this.tokenExpiresAt = 0;
          // Retry immediately (the interceptor will re-acquire token)
          continue;
        }

        // 403 is not retryable — bail immediately
        if (status === 403) {
          logger.warn(`Kick API ${context}: 403 Forbidden`);
          return null;
        }

        if (!retryable || attempt === MAX_RETRIES) {
          logger.warn(`Kick API ${context} failed after ${attempt + 1} attempt(s)`, {
            status,
            message: axErr.message,
          });
          return null;
        }

        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`Kick API ${context} returned ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
      }
    }
    return null;
  }

  // ── Safe field extraction ─────────────────────────────────────────────

  private parseChannelResponse(raw: KickChannelResponse, channelName: string): ChannelSnapshot {
    try {
      const isLive = raw.stream?.is_live === true;

      return {
        channelIdentifier: raw.slug ?? channelName,
        displayName: raw.slug ?? channelName,
        concurrentViewers: isLive ? (raw.stream?.viewer_count ?? 0) : 0,
        isLive,
        language: raw.stream?.language ?? null,
        gameName: raw.category?.name ?? null,
        title: raw.stream_title ?? null,
        startedAt: raw.stream?.start_time ?? null,
      };
    } catch (err) {
      logger.warn(`Kick: failed to parse channel response for "${channelName}"`, {
        error: (err as Error).message,
        rawShape: describeShape(raw),
      });
      return offlineSnapshot(channelName);
    }
  }

  private parseLivestreamResponse(raw: KickLivestreamResponse): DiscoveredStream {
    return {
      channelIdentifier: raw.slug ?? 'unknown',
      displayName: raw.slug ?? 'unknown',
      concurrentViewers: raw.viewer_count ?? 0,
      language: raw.language ?? null,
      title: raw.stream_title ?? 'Untitled',
    };
  }

  // ── Core methods ──────────────────────────────────────────────────────

  async getViewerCounts(channelNames: string[]): Promise<ChannelSnapshot[]> {
    if (channelNames.length === 0) return [];

    if (this.isCircuitOpen()) {
      logger.warn(`Kick circuit breaker open, returning offline for ${channelNames.length} channels`);
      return channelNames.map((name) => offlineSnapshot(name));
    }

    const results: ChannelSnapshot[] = [];
    const batches = chunk(channelNames, PARALLEL_BATCH_SIZE);

    for (const batch of batches) {
      const batchResults = await this.fetchChannelBatch(batch);
      results.push(...batchResults);

      // Polite delay between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await sleep(INTER_REQUEST_DELAY_MS);
      }
    }

    const liveResults = results.filter(r => r.isLive);
    logger.debug(`Kick getViewerCounts: ${liveResults.length}/${channelNames.length} live`);

    // Log individual viewer counts for live channels to help trace discrepancies
    for (const r of liveResults) {
      logger.debug(`Kick: ${r.channelIdentifier} → ${r.concurrentViewers} viewers`);
    }

    return results;
  }

  /**
   * Fetch a batch of channels using the official GET /public/v1/channels endpoint.
   * The API accepts multiple slugs as repeated query params: ?slug=a&slug=b
   * NOTE: Kick's API does NOT accept slug[]=a&slug[]=b (bracket notation).
   */
  private async fetchChannelBatch(channelNames: string[]): Promise<ChannelSnapshot[]> {
    const result = await this.requestWithRetry(async () => {
      // Build query string manually because Kick requires slug=a&slug=b (not slug[]=a&slug[]=b)
      const slugParams = channelNames.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
      const { data } = await this.client.get<{ data: KickChannelResponse[] }>(
        `/public/v1/channels?${slugParams}`,
      );
      return data;
    }, `channels [${channelNames.join(',')}]`);

    if (!result || !Array.isArray(result.data)) {
      // API call failed — return all as offline
      logger.debug(`Kick: batch API call failed for [${channelNames.join(',')}], returning offline`);
      return channelNames.map((name) => offlineSnapshot(name));
    }

    // Build a map of slug → parsed result for quick lookup
    const responseMap = new Map<string, ChannelSnapshot>();
    for (const raw of result.data) {
      const slug = raw.slug?.toLowerCase();
      if (slug) {
        responseMap.set(slug, this.parseChannelResponse(raw, slug));
      }
    }

    // Return results in the same order as the input, filling missing with offline
    return channelNames.map((name) => {
      const snapshot = responseMap.get(name.toLowerCase());
      return snapshot ?? offlineSnapshot(name);
    });
  }

  /**
   * Look up a category ID by name (e.g. "PUBG: BATTLEGROUNDS" → 15).
   * Uses the v1 search endpoint with a fuzzy query, returns the best match.
   */
  async getCategoryId(gameName: string): Promise<{ id: number; name: string } | null> {
    if (this.isCircuitOpen()) {
      logger.warn('Kick circuit breaker open, skipping category lookup');
      return null;
    }

    const result = await this.requestWithRetry(async () => {
      const { data } = await this.client.get<{ data: Array<{ id: number; name: string }> }>(
        '/public/v1/categories',
        { params: { q: gameName } },
      );
      return data;
    }, `getCategoryId("${gameName}")`);

    if (!result || !Array.isArray(result.data) || result.data.length === 0) {
      logger.warn(`Kick: category not found for "${gameName}"`);
      return null;
    }

    // Try exact match first, then return first result
    const exact = result.data.find((c) => c.name.toLowerCase() === gameName.toLowerCase());
    const best = exact ?? result.data[0]!;
    logger.info(`Kick: resolved category "${gameName}" → ${best.name} (ID: ${best.id})`);
    return { id: best.id, name: best.name };
  }

  async searchLiveStreams(
    gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    if (this.isCircuitOpen()) {
      logger.warn('Kick circuit breaker open, skipping discovery');
      return [];
    }

    // Try category-filtered request first (with pagination), fall back to all
    // livestreams if empty. Kick's category_id filter is unreliable — sometimes
    // returns 0 results even when streams exist under that category.
    let allStreams: DiscoveredStream[] = [];

    const PAGE_SIZE = 100;
    const MAX_PAGES_CATEGORY = 3;  // 300 streams with category filter
    const MAX_PAGES_ALL = 3;       // 300 streams without category (deeper search for smaller co-streamers)

    if (gameId) {
      const numericId = parseInt(gameId, 10);
      if (!isNaN(numericId)) {
        // Try with category filter (paginated)
        for (let page = 1; page <= MAX_PAGES_CATEGORY; page++) {
          const catResult = await this.requestWithRetry(async () => {
            const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
              params: { limit: PAGE_SIZE, sort: 'viewer_count', category_id: numericId, page },
            });
            return data;
          }, `livestreams(category,p${page})`);

          if (!catResult || !Array.isArray(catResult.data) || catResult.data.length === 0) break;
          allStreams.push(...catResult.data.map((raw) => this.parseLivestreamResponse(raw)));
          if (catResult.data.length < PAGE_SIZE) break; // Last page
        }

        if (allStreams.length === 0) {
          logger.info(`Kick: category_id ${numericId} returned 0 results, falling back to all livestreams`);
        }
      }
    }

    // If no results yet (category failed or no gameId), fetch all livestreams with pagination
    if (allStreams.length === 0) {
      for (let page = 1; page <= MAX_PAGES_ALL; page++) {
        const result = await this.requestWithRetry(async () => {
          const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
            params: { limit: PAGE_SIZE, sort: 'viewer_count', page },
          });
          return data;
        }, `livestreams(all,p${page})`);

        if (!result || !Array.isArray(result.data)) {
          if (page === 1) {
            logger.warn('Kick livestreams endpoint returned unexpected shape', {
              rawShape: describeShape(result),
            });
          }
          break;
        }

        allStreams.push(...result.data.map((raw) => this.parseLivestreamResponse(raw)));
        if (result.data.length < PAGE_SIZE) break; // Last page
      }
    }

    logger.info(`Kick: fetched ${allStreams.length} total livestreams`);

    // Filter by keywords in stream title (client-side), matching Twitch behaviour.
    // Kick's API doesn't support server-side keyword filtering, so we do it here.
    const streams = allStreams.filter((stream) => {
      if (!keywords || keywords.length === 0) return true;
      const title = (stream.title ?? '').toLowerCase();
      const displayName = stream.displayName.toLowerCase();
      return keywords.some(
        (kw) => title.includes(kw.toLowerCase()) || displayName.includes(kw.toLowerCase()),
      );
    });

    logger.debug(`Kick searchLiveStreams: ${allStreams.length} total, ${streams.length} matched keywords`, {
      gameId,
      keywords,
    });
    return streams;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function offlineSnapshot(channelName: string): ChannelSnapshot {
  return {
    channelIdentifier: channelName,
    displayName: channelName,
    concurrentViewers: 0,
    isLive: false,
    language: null,
    gameName: null,
    title: null,
    startedAt: null,
  };
}

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

/**
 * Returns a human-readable description of an unknown value's shape
 * for debugging when the Kick API schema changes unexpectedly.
 */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `Array(${value.length})${value.length > 0 ? ` [${describeShape(value[0])}, ...]` : ''}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{ ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? `, ... +${keys.length - 8}` : ''} }`;
  }
  return typeof value;
}
