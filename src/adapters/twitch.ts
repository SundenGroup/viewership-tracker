import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { config } from '../utils/config';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

const HELIX_BASE = 'https://api.twitch.tv/helix';
const GQL_URL = 'https://gql.twitch.tv/gql';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Public Twitch web client ID
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const MAX_CHANNELS_PER_REQUEST = 100;
const GQL_BATCH_SIZE = 35; // GQL batches: keep under rate limits
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry

interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TwitchStreamData {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  tags: string[];
}

interface TwitchGameData {
  id: string;
  name: string;
  box_art_url: string;
}

interface TwitchUserData {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  view_count: number;
  created_at: string;
}

export interface TwitchUserProfile {
  login: string;
  displayName: string;
  profileImageUrl: string;
  description: string;
}

interface TwitchPaginatedResponse<T> {
  data: T[];
  pagination: { cursor?: string };
}

interface GqlStreamResponse {
  data: {
    user: {
      login: string;
      displayName: string;
      stream: {
        viewersCount: number;
        title: string;
        game: { name: string } | null;
        createdAt: string;
      } | null;
      broadcastSettings: {
        language: string;
      } | null;
    } | null;
  };
}

export class TwitchAdapter implements PlatformAdapter {
  readonly platform = 'twitch';

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly client: AxiosInstance;
  private readonly gqlClient: AxiosInstance;
  private readonly gameIdCache = new Map<string, string>();
  private static readonly GAME_ID_CACHE_MAX = 500;
  private gqlHealthy = true;
  private gqlBackoffMs = 5 * 60_000; // Start at 5 minutes, grows exponentially
  private static readonly GQL_BACKOFF_MAX_MS = 60 * 60_000; // Max 1 hour

  constructor(clientId?: string, clientSecret?: string) {
    this.clientId = clientId ?? config.twitch.clientId;
    this.clientSecret = clientSecret ?? config.twitch.clientSecret;

    this.client = axios.create({ baseURL: HELIX_BASE });
    this.client.interceptors.request.use(async (reqConfig) => {
      await this.ensureToken();
      reqConfig.headers['Client-ID'] = this.clientId;
      reqConfig.headers['Authorization'] = `Bearer ${this.accessToken}`;
      return reqConfig;
    });

    this.gqlClient = axios.create({
      baseURL: GQL_URL,
      headers: { 'Client-ID': GQL_CLIENT_ID },
      timeout: 10_000,
    });
  }

  // ── Authentication ──────────────────────────────────────────────────

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return;
    }
    await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    try {
      const { data } = await axios.post<TwitchTokenResponse>(TOKEN_URL, null, {
        params: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'client_credentials',
        },
      });

      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      logger.info('Twitch OAuth token refreshed', {
        expiresIn: data.expires_in,
      });
    } catch (err) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      logger.error('Failed to refresh Twitch OAuth token', { error: err });
      throw err;
    }
  }

  // ── Retry wrapper ───────────────────────────────────────────────────

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
          logger.warn(`Twitch API ${context} failed after ${attempt + 1} attempt(s)`, {
            status,
            message: axErr.message,
          });
          return null;
        }

        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`Twitch API ${context} returned ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, {
          status,
        });
        await sleep(delay);
      }
    }
    return null;
  }

  // ── Core Methods ────────────────────────────────────────────────────

  async getViewerCounts(channelNames: string[]): Promise<ChannelSnapshot[]> {
    if (channelNames.length === 0) return [];

    // Try GQL first (real-time counts), fall back to Helix (stepped ~3-5 min)
    if (this.gqlHealthy) {
      try {
        const results = await this.getViewerCountsViaGQL(channelNames);
        // Reset backoff on success
        this.gqlBackoffMs = 5 * 60_000;
        return results;
      } catch (err) {
        logger.warn(`Twitch GQL failed, falling back to Helix API (retry in ${Math.round(this.gqlBackoffMs / 60_000)}m)`, {
          error: (err as Error).message,
        });
        this.gqlHealthy = false;
        const backoff = this.gqlBackoffMs;
        // Exponential backoff: 5m → 10m → 20m → 40m → 60m max
        this.gqlBackoffMs = Math.min(this.gqlBackoffMs * 2, TwitchAdapter.GQL_BACKOFF_MAX_MS);
        setTimeout(() => {
          this.gqlHealthy = true;
          logger.info('Twitch GQL re-enabled for next poll cycle');
        }, backoff);
      }
    }

    return this.getViewerCountsViaHelix(channelNames);
  }

  // ── GQL: Real-time viewer counts (~15-30s freshness) ────────────────

  private async getViewerCountsViaGQL(channelNames: string[]): Promise<ChannelSnapshot[]> {
    const batches = chunk(channelNames, GQL_BATCH_SIZE);
    const results: ChannelSnapshot[] = [];

    for (const batch of batches) {
      // Build a batched GQL request: one query per channel in a single POST
      const operations = batch.map((name, i) => ({
        operationName: 'StreamMetadata',
        variables: { channelLogin: name.toLowerCase() },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'a647c2a13599e5991e175155f798ca7f1ecddde73f7f341f39009c14dbfd59df',
          },
        },
      }));

      // Use inline queries (persisted query hashes rotate and break)
      let responses: GqlStreamResponse[];
      const inlineOps = batch.map((name) => ({
        query: `query { user(login: "${name.toLowerCase()}") { login displayName stream { viewersCount title game { name } createdAt } broadcastSettings { language } } }`,
      }));
      const { data } = await this.gqlClient.post<GqlStreamResponse[]>('', inlineOps);
      responses = data;

      for (let i = 0; i < batch.length; i++) {
        const name = batch[i];
        const resp = responses[i];
        const user = resp?.data?.user;
        const stream = user?.stream;

        if (user && stream) {
          results.push({
            channelIdentifier: user.login,
            displayName: user.displayName,
            concurrentViewers: stream.viewersCount,
            isLive: true,
            language: user.broadcastSettings?.language ?? null,
            gameName: stream.game?.name ?? null,
            title: stream.title,
            startedAt: stream.createdAt,
          });
        } else {
          results.push({
            channelIdentifier: name,
            displayName: user?.displayName ?? name,
            concurrentViewers: 0,
            isLive: false,
            language: null,
            gameName: null,
            title: null,
            startedAt: null,
          });
        }
      }
    }

    logger.debug(`Twitch GQL getViewerCounts: ${results.filter(r => r.isLive).length}/${channelNames.length} live`);
    return results;
  }

  // ── Helix: Official API (stepped ~3-5 min viewer counts) ────────────

  private async getViewerCountsViaHelix(channelNames: string[]): Promise<ChannelSnapshot[]> {
    const batches = chunk(channelNames, MAX_CHANNELS_PER_REQUEST);
    const results: ChannelSnapshot[] = [];

    for (const batch of batches) {
      const liveStreams = await this.requestWithRetry(async () => {
        const params = new URLSearchParams();
        for (const name of batch) {
          params.append('user_login', name);
        }
        params.set('first', '100');

        const { data } = await this.client.get<TwitchPaginatedResponse<TwitchStreamData>>(
          '/streams',
          { params },
        );
        return data.data;
      }, 'getViewerCounts');

      const liveMap = new Map<string, TwitchStreamData>();
      if (liveStreams) {
        for (const stream of liveStreams) {
          liveMap.set(stream.user_login.toLowerCase(), stream);
        }
      }

      for (const name of batch) {
        const stream = liveMap.get(name.toLowerCase());
        if (stream) {
          results.push({
            channelIdentifier: stream.user_login,
            displayName: stream.user_name,
            concurrentViewers: stream.viewer_count,
            isLive: true,
            language: stream.language,
            gameName: stream.game_name,
            title: stream.title,
            startedAt: stream.started_at,
          });
        } else {
          results.push({
            channelIdentifier: name,
            displayName: name,
            concurrentViewers: 0,
            isLive: false,
            language: null,
            gameName: null,
            title: null,
            startedAt: null,
          });
        }
      }
    }

    logger.debug(`Twitch Helix getViewerCounts: ${results.filter(r => r.isLive).length}/${channelNames.length} live`);
    return results;
  }

  async searchLiveStreams(
    gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    const allStreams: DiscoveredStream[] = [];
    let cursor: string | undefined;
    const maxPages = 5;

    for (let page = 0; page < maxPages; page++) {
      const pageResult = await this.requestWithRetry(async () => {
        const params: Record<string, string> = { first: '100' };
        if (gameId) params.game_id = gameId;
        if (cursor) params.after = cursor;

        const { data } = await this.client.get<TwitchPaginatedResponse<TwitchStreamData>>(
          '/streams',
          { params },
        );
        return data;
      }, 'searchLiveStreams');

      if (!pageResult || pageResult.data.length === 0) break;

      for (const stream of pageResult.data) {
        const matches = !keywords || keywords.length === 0 || keywords.some(
          (kw) => stream.title.toLowerCase().includes(kw.toLowerCase()),
        );

        if (matches) {
          allStreams.push({
            channelIdentifier: stream.user_login,
            displayName: stream.user_name,
            concurrentViewers: stream.viewer_count,
            language: stream.language,
            title: stream.title,
            gameName: stream.game_name ?? null,
            startedAt: stream.started_at ?? null,
            streamId: stream.id ?? null,
          });
        }
      }

      cursor = pageResult.pagination.cursor;
      if (!cursor) break;
    }

    logger.debug(`Twitch searchLiveStreams: found ${allStreams.length} streams`, {
      gameId,
      keywords,
    });
    return allStreams;
  }

  /**
   * Look up profile metadata (display_name, profile_image_url, etc.)
   * for a list of Twitch login handles. Used by the live game tracker
   * to cache streamer avatars on first sighting — Helix `/streams`
   * doesn't return them.
   *
   * Batches at 100 logins/call (the Helix max). Empty input → empty
   * output. Logins not found are silently omitted (just won't appear in
   * the result map).
   */
  async getUsersByLogin(logins: string[]): Promise<TwitchUserProfile[]> {
    if (logins.length === 0) return [];
    const out: TwitchUserProfile[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < logins.length; i += 100) chunks.push(logins.slice(i, i + 100));

    for (const batch of chunks) {
      const result = await this.requestWithRetry(async () => {
        const params = new URLSearchParams();
        for (const l of batch) params.append('login', l);
        const { data } = await this.client.get<TwitchPaginatedResponse<TwitchUserData>>(
          `/users?${params.toString()}`,
        );
        return data.data;
      }, 'getUsersByLogin');
      if (!result) continue;
      for (const u of result) {
        out.push({
          login: u.login,
          displayName: u.display_name,
          profileImageUrl: u.profile_image_url,
          description: u.description,
        });
      }
    }
    return out;
  }

  async getGameId(gameName: string): Promise<string | null> {
    const cached = this.gameIdCache.get(gameName.toLowerCase());
    if (cached) return cached;

    const result = await this.requestWithRetry(async () => {
      const { data } = await this.client.get<TwitchPaginatedResponse<TwitchGameData>>(
        '/games',
        { params: { name: gameName } },
      );
      return data.data;
    }, 'getGameId');

    if (!result || result.length === 0) {
      logger.warn(`Twitch game not found: "${gameName}"`);
      return null;
    }

    const id = result[0].id;
    // LRU eviction: remove oldest entries if cache exceeds max size
    if (this.gameIdCache.size >= TwitchAdapter.GAME_ID_CACHE_MAX) {
      const firstKey = this.gameIdCache.keys().next().value;
      if (firstKey) this.gameIdCache.delete(firstKey);
    }
    this.gameIdCache.set(gameName.toLowerCase(), id);
    return id;
  }

  /**
   * Search games/categories by name and return ALL matches (up to 10).
   * Uses the /search/categories endpoint for fuzzy matching.
   * Used by the game ID picker UI so users can choose the correct game.
   */
  async searchGames(query: string): Promise<Array<{ id: string; name: string }>> {
    const result = await this.requestWithRetry(async () => {
      const { data } = await this.client.get<TwitchPaginatedResponse<TwitchGameData>>(
        '/search/categories',
        { params: { query, first: 10 } },
      );
      return data.data;
    }, `searchGames("${query}")`);

    if (!result || result.length === 0) return [];
    return result.map((g) => ({ id: g.id, name: g.name }));
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
