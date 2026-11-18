import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import { KickTailRoster } from '../utils/kick-tail-roster';
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

/**
 * Languages the category listing is asked for, one request each (see
 * listCategoryByLanguage). Kick's own language filter values.
 */
export const KICK_LISTING_LANGUAGES = [
  'en', 'es', 'pt', 'ar', 'tr', 'de', 'fr', 'ru', 'it', 'pl', 'nl', 'ja', 'ko', 'zh', 'id', 'th', 'vi', 'hi',
  'sv', 'fi', 'no', 'da', 'cs', 'hu', 'ro', 'el', 'uk', 'he', 'fa', 'ms', 'tl', 'bg', 'sr', 'hr', 'sk', 'ca',
  'bn', 'ur', 'az', 'ka', 'sq',
];
/** Requests in flight at once while asking per language. */
const LANGUAGE_CONCURRENCY = 4;
/** Languages that returned nothing are asked again this often. */
const LANGUAGE_REPROBE_MS = 10 * 60_000;

// ── Below a language's 100 rows (see utils/kick-tail-roster) ─────────────
/** Channel ids per read-by-id call. Kick's limit. */
const TAIL_IDS_PER_CALL = 50;
/** Read-by-id calls in flight at once. */
const TAIL_CONCURRENCY = 4;
/** A followed stream is forgotten this long after it was last seen live. */
const TAIL_TTL_MS = 12 * 60_000;
/** Streams first seen within this window are read on every poll. */
const TAIL_YOUNG_MS = 20 * 60_000;
/** Small old streams are read this often. */
const TAIL_COLD_EVERY_MS = 5 * 60_000;
/** Who is being followed survives a restart in this file. */
const TAIL_FILE = path.resolve(process.cwd(), '.kick-tail-roster.json');
const TAIL_SAVE_EVERY_MS = 60_000;

/** Kick takes a list as a repeated key: broadcaster_user_id=1&broadcaster_user_id=2. */
function repeatedKeys(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, String(v));
  }
  return out.toString();
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
  /** categoryId → languages that returned rows, and when all were last asked. */
  private readonly languageState = new Map<number, { active: Set<string>; probedAt: number }>();
  /** "categoryId:language" → the streams followed below that language's list. */
  private tailRosters: Map<string, KickTailRoster> | null = null;
  private tailSavedAt = 0;
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

  private parseLivestreamResponse(raw: KickLivestreamResponse): DiscoveredStream & { categoryId?: number; categoryName?: string } {
    return {
      channelIdentifier: raw.slug ?? 'unknown',
      displayName: raw.slug ?? 'unknown',
      concurrentViewers: raw.viewer_count ?? 0,
      language: raw.language ?? null,
      title: raw.stream_title ?? 'Untitled',
      categoryId: raw.category?.id,
      categoryName: raw.category?.name,
      gameName: raw.category?.name ?? null,
      startedAt: raw.started_at ?? null,
      // Kick doesn't expose a per-broadcast id like Twitch — use the
      // channel slug + start time as a synthetic session marker. Good
      // enough for "is this the same broadcast as before?" queries.
      streamId:
        raw.started_at && raw.slug ? `${raw.slug}:${raw.started_at}` : raw.slug ?? null,
    };
  }

  // ── Core methods ──────────────────────────────────────────────────────

  async getViewerCounts(channelNames: string[]): Promise<ChannelSnapshot[]> {
    if (channelNames.length === 0) return [];

    if (this.isCircuitOpen()) {
      // Unknown, not offline: the orchestrator writes no row for fetchFailed.
      logger.warn(`Kick circuit breaker open, no rows for ${channelNames.length} channels this cycle`);
      return channelNames.map((name) => ({ ...offlineSnapshot(name), fetchFailed: true }));
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
      // API call failed: unknown, not offline. Marked fetchFailed so the
      // orchestrator writes nothing (2026-09-13: an 8-minute DNS outage wrote
      // zeros for every Kick channel on PAS2 Playoffs 1 Day 2).
      logger.warn(`Kick: batch API call failed for [${channelNames.join(',')}], no rows written for them`);
      return channelNames.map((name) => ({ ...offlineSnapshot(name), fetchFailed: true }));
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
   * Fetch profile-picture URLs for Kick channels by slug. The official API
   * has no avatar on the channels endpoint, so it's two hops:
   *   slug → broadcaster_user_id   (GET /public/v1/channels?slug=…)
   *   user_id → profile_picture    (GET /public/v1/users?id=…)
   * Returns a map of lowercased-slug → profile_picture URL. Channels that
   * can't be resolved are simply absent from the map.
   */
  async getProfilePics(slugs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (slugs.length === 0) return out;
    const BATCH = 40;
    for (let i = 0; i < slugs.length; i += BATCH) {
      const batch = slugs.slice(i, i + BATCH);
      // 1) slug → broadcaster_user_id
      const chRes = await this.requestWithRetry(async () => {
        const q = batch.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
        const { data } = await this.client.get<{ data: KickChannelResponse[] }>(
          `/public/v1/channels?${q}`,
        );
        return data;
      }, `profilepics channels [${batch.join(',')}]`);
      if (!chRes || !Array.isArray(chRes.data)) continue;
      const idToSlug = new Map<number, string>();
      for (const c of chRes.data) {
        if (c.broadcaster_user_id != null && c.slug) {
          idToSlug.set(c.broadcaster_user_id, c.slug.toLowerCase());
        }
      }
      const ids = [...idToSlug.keys()];
      if (ids.length === 0) continue;
      // 2) broadcaster_user_id → profile_picture
      const usRes = await this.requestWithRetry(async () => {
        const q = ids.map((id) => `id=${id}`).join('&');
        const { data } = await this.client.get<{
          data: Array<{ user_id: number; profile_picture?: string }>;
        }>(`/public/v1/users?${q}`);
        return data;
      }, `profilepics users [${ids.join(',')}]`);
      if (!usRes || !Array.isArray(usRes.data)) continue;
      for (const u of usRes.data) {
        const slug = idToSlug.get(u.user_id);
        if (slug && u.profile_picture) out.set(slug, u.profile_picture);
      }
    }
    return out;
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

  /**
   * Search categories by name and return ALL matches (up to 10).
   * Used by the game ID picker UI so users can choose the correct category
   * when there are similar names (e.g. "Counter-Strike: Source" vs "Counter-Strike 2").
   */
  async searchCategories(query: string): Promise<Array<{ id: number; name: string }>> {
    if (this.isCircuitOpen()) return [];

    const result = await this.requestWithRetry(async () => {
      const { data } = await this.client.get<{ data: Array<{ id: number; name: string }> }>(
        '/public/v1/categories',
        { params: { q: query } },
      );
      return data;
    }, `searchCategories("${query}")`);

    if (!result || !Array.isArray(result.data)) return [];
    return result.data.slice(0, 10).map((c) => ({ id: c.id, name: c.name }));
  }

  /**
   * A category beyond the listing's 100 rows, for the live game tracker.
   *
   * The listing has no paging: every request returns at most the 100
   * largest streams. It does take a language filter, and then returns that
   * language's own 100 largest, so the union over languages reaches far
   * below the global top 100 (GTA VI launch, 2026-11-18: 963 streams
   * against 100, 406 of them above 50 viewers).
   *
     * Per-language requests are only made when the plain listing is full and
   * still above `minViewers`; otherwise it is already complete. They are
   * best effort: the first failure ends the pass and the plain listing
   * still stands, and they never touch the circuit breaker.
   *
   * A language whose own list is full and still above `minViewers` (English
   * and Portuguese on a big launch) has more streams below it. Those are
   * followed by channel id: see followBelowList.
   */
  async listCategoryByLanguage(
    gameId: string,
    opts: { minViewers: number },
  ): Promise<DiscoveredStream[]> {
    const base = await this.searchLiveStreams(gameId);
    const target = parseInt(gameId, 10);
    if (isNaN(target) || base.length < 100 || base.some((s) => s.concurrentViewers < opts.minViewers)) {
      return base;
    }

    const state = this.languageState.get(target) ?? { active: new Set<string>(), probedAt: 0 };
    const probeAll = Date.now() - state.probedAt >= LANGUAGE_REPROBE_MS;
    const languages = probeAll ? KICK_LISTING_LANGUAGES : KICK_LISTING_LANGUAGES.filter((l) => state.active.has(l));

    const found = new Map<string, DiscoveredStream>(base.map((s) => [s.channelIdentifier, s]));
    const withRows = new Set<string>();
    /** language → channel ids its full list returned (the list is cut above the floor). */
    const cutLists = new Map<string, Set<number>>();
    let failed = false;
    for (let i = 0; i < languages.length && !failed; i += LANGUAGE_CONCURRENCY) {
      await Promise.all(
        languages.slice(i, i + LANGUAGE_CONCURRENCY).map(async (language) => {
          try {
            const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
              params: { limit: 100, sort: 'viewer_count', category_id: target, language },
            });
            const rows = Array.isArray(data?.data) ? data.data : [];
            if (rows.length > 0) withRows.add(language);
            if (rows.length >= 100 && rows.every((r) => (r.viewer_count ?? 0) >= opts.minViewers)) {
              cutLists.set(
                language,
                new Set(rows.filter((r) => r.category?.id === target).map((r) => Number(r.broadcaster_user_id))),
              );
            }
            for (const raw of rows) {
              // The category filter has returned other categories before: check each row.
              if (raw.category?.id !== target || !raw.slug || found.has(raw.slug)) continue;
              found.set(raw.slug, this.parseLivestreamResponse(raw));
            }
          } catch (err) {
            failed = true;
            logger.debug(`Kick: language listing ${language} failed for category ${target}: ${(err as Error).message}`);
          }
        }),
      );
    }
    if (probeAll && !failed) this.languageState.set(target, { active: withRows, probedAt: Date.now() });
    else for (const l of withRows) state.active.add(l);

    let below = 0;
    for (const [language, listed] of cutLists) {
      below += await this.followBelowList(target, language, listed, found, opts.minViewers);
    }

    logger.info(
      `Kick: category ${target} by language: ${found.size} livestreams from ${languages.length} language list(s)` +
        (cutLists.size > 0 ? `, ${below} of them below the full list(s) of ${[...cutLists.keys()].join(', ')}` : '') +
        (failed ? ' (pass cut short by a failed request)' : ''),
    );
    return [...found.values()];
  }

  /**
   * Streams of one language that sit below its 100-row list. Notes the
   * language's most recently started streams, then reads every followed
   * stream the lists did not return by channel id. Adds what is live in
   * this category to `found` and returns how many it added.
   *
   * Best effort like the language lists: a failed call ends this pass for
   * the language and nothing already found is lost.
   */
  private async followBelowList(
    target: number,
    language: string,
    listed: Set<number>,
    found: Map<string, DiscoveredStream>,
    minViewers: number,
  ): Promise<number> {
    const now = Date.now();
    const roster = this.tailRoster(`${target}:${language}`, now);
    const covered = new Set<number>(listed);
    let added = 0;
    const take = (raw: KickLivestreamResponse): void => {
      const id = Number(raw.broadcaster_user_id);
      if (raw.category?.id !== target || !raw.slug || !Number.isFinite(id)) return;
      roster.observe(id, raw.viewer_count ?? 0, now);
      covered.add(id);
      if (found.has(raw.slug)) return;
      found.set(raw.slug, this.parseLivestreamResponse(raw));
      added++;
    };
    // A stream in the list is followed too: it stays known when it drops out of the top 100.
    for (const id of listed) roster.observe(id, minViewers, now);

    try {
      const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
        params: { limit: 100, sort: 'started_at', category_id: target, language },
      });
      for (const raw of Array.isArray(data?.data) ? data.data : []) take(raw);

      const due = roster.due(now, covered, {
        hotAtLeast: Math.max(1, Math.floor(minViewers * 0.4)),
        youngForMs: TAIL_YOUNG_MS,
        coldEveryMs: TAIL_COLD_EVERY_MS,
      });
      const batches: number[][] = [];
      for (let i = 0; i < due.length; i += TAIL_IDS_PER_CALL) batches.push(due.slice(i, i + TAIL_IDS_PER_CALL));
      for (let i = 0; i < batches.length; i += TAIL_CONCURRENCY) {
        await Promise.all(
          batches.slice(i, i + TAIL_CONCURRENCY).map(async (batch) => {
            const { data: read } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
              params: { broadcaster_user_id: batch, limit: 100 },
              paramsSerializer: { serialize: repeatedKeys },
            });
            for (const raw of Array.isArray(read?.data) ? read.data : []) take(raw);
            roster.markRead(batch, now);
          }),
        );
      }
    } catch (err) {
      logger.debug(`Kick: following ${language} below its list failed for category ${target}: ${(err as Error).message}`);
    }
    roster.prune(now, TAIL_TTL_MS);
    this.saveTailRosters(now);
    return added;
  }

  private tailRoster(key: string, now: number): KickTailRoster {
    if (!this.tailRosters) {
      this.tailRosters = new Map();
      if (process.env.NODE_ENV !== 'test') {
        try {
          const stored = JSON.parse(fs.readFileSync(TAIL_FILE, 'utf-8')) as Record<string, unknown>;
          for (const [k, rows] of Object.entries(stored)) {
            this.tailRosters.set(k, KickTailRoster.load(rows, now, TAIL_TTL_MS));
          }
        } catch {
          // No file yet, or unreadable: start empty.
        }
      }
    }
    let roster = this.tailRosters.get(key);
    if (!roster) {
      roster = new KickTailRoster();
      this.tailRosters.set(key, roster);
    }
    return roster;
  }

  private saveTailRosters(now: number): void {
    if (process.env.NODE_ENV === 'test' || !this.tailRosters || now - this.tailSavedAt < TAIL_SAVE_EVERY_MS) return;
    this.tailSavedAt = now;
    const out: Record<string, unknown> = {};
    for (const [key, roster] of this.tailRosters) out[key] = roster.dump();
    fs.promises.writeFile(TAIL_FILE, JSON.stringify(out)).catch(() => {});
  }

  async searchLiveStreams(
    gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    if (this.isCircuitOpen()) {
      logger.warn('Kick circuit breaker open, skipping discovery');
      return [];
    }

    // Try category-filtered request first, fall back to all livestreams if empty.
    // Kick's API has a hard limit of 100 results with no pagination support.
    // Category filter is unreliable — sometimes returns 0 results even when
    // streams exist under that category.
    let allStreams: DiscoveredStream[] = [];
    // Whether `allStreams` came from the category_id-filtered request (already
    // game-scoped) vs. the global top-100 fallback (NOT game-scoped — must be
    // category-gated below).
    let usedCategoryRequest = false;

    const params: Record<string, unknown> = {
      limit: 100,
      sort: 'viewer_count',
    };

    const targetCategoryId = gameId ? parseInt(gameId, 10) : NaN;

    if (!isNaN(targetCategoryId)) {
      // Try with category filter first
      const catResult = await this.requestWithRetry(async () => {
        const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
          params: { ...params, category_id: targetCategoryId },
        });
        return data;
      }, 'livestreams(category)');

      if (catResult && Array.isArray(catResult.data) && catResult.data.length > 0) {
        allStreams = catResult.data.map((raw) => this.parseLivestreamResponse(raw));
        usedCategoryRequest = true;
      } else {
        logger.info(`Kick: category_id ${targetCategoryId} returned 0 results, falling back to all livestreams`);
      }
    }

    // If no results yet (category failed or no gameId), fetch top 100 livestreams
    if (allStreams.length === 0) {
      const result = await this.requestWithRetry(async () => {
        const { data } = await this.client.get<{ data: KickLivestreamResponse[] }>('/public/v1/livestreams', {
          params,
        });
        return data;
      }, 'livestreams(all)');

      if (!result || !Array.isArray(result.data)) {
        logger.warn('Kick livestreams endpoint returned unexpected shape', {
          rawShape: describeShape(result),
        });
        return [];
      }

      allStreams = result.data.map((raw) => this.parseLivestreamResponse(raw));
    }

    logger.info(`Kick: fetched ${allStreams.length} livestreams (API max: 100, no pagination)`);

    // Filter results. Two modes:
    //
    //  • Category-driven (game trackers): no keywords. When the streams came
    //    from the global top-100 FALLBACK (the category_id request returned
    //    nothing), keep only streams whose own category matches the target.
    //    Without this gate, a niche or momentarily-empty category (e.g.
    //    "Goals", "GeoGuessr") makes the fallback vacuum up the global top
    //    Kick streams — Just Chatting, IRL, Slots & Casino, GTA — none of
    //    which are playing our game. The category_id-request path is already
    //    game-scoped, so the gate only applies to the fallback.
    //
    //  • Keyword-driven (e.g. watch-party discovery): require a title/name
    //    keyword match; in the fallback, a stream in a different category is
    //    allowed only if the channel NAME itself matches a keyword.
    const streams = (allStreams as Array<DiscoveredStream & { categoryId?: number; categoryName?: string }>).filter((stream) => {
      if (!keywords || keywords.length === 0) {
        // Category-driven: gate the fallback by the stream's actual category.
        if (!isNaN(targetCategoryId) && !usedCategoryRequest) {
          return stream.categoryId === targetCategoryId;
        }
        return true;
      }
      const title = (stream.title ?? '').toLowerCase();
      const displayName = stream.displayName.toLowerCase();
      const matchesKeyword = keywords.some(
        (kw) => title.includes(kw.toLowerCase()) || displayName.includes(kw.toLowerCase()),
      );
      if (!matchesKeyword) return false;

      // Category-request results are already game-scoped.
      if (usedCategoryRequest) return true;

      // Fallback path — verify the stream's category matches our target.
      if (!isNaN(targetCategoryId) && stream.categoryId !== undefined) {
        if (stream.categoryId !== targetCategoryId) {
          // Different category — allow only if the channel NAME matches a keyword
          // (the channel itself is relevant, just streaming under a different category).
          const nameMatchesKeyword = keywords.some(
            (kw) => displayName.includes(kw.toLowerCase()),
          );
          if (!nameMatchesKeyword) {
            logger.debug(`Kick: skipping ${stream.displayName} — category "${stream.categoryName}" doesn't match target, title keyword match only`);
            return false;
          }
        }
      }

      return true;
    });

    logger.debug(`Kick searchLiveStreams: ${allStreams.length} total, ${streams.length} matched`, {
      gameId,
      keywords,
      usedCategoryRequest,
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
