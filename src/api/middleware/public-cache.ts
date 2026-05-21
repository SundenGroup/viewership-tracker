/**
 * Public Cache — per-endpoint LRU caching for /api/public/* aggregation
 * responses.
 *
 * Why this exists:
 * During live broadcasts the public dashboard + report pages each issue
 * ~8 aggregation queries per poll cycle (metrics + live-ccv + 4× timeseries
 * group-bys × 1-2 view filters). With N concurrent viewers that's N × 8
 * queries every 30 s hammering the same Postgres aggregations. Caching at
 * the HTTP layer collapses the herd to 1 query per (URL, TTL window).
 *
 * Scope rule (same posture as report-cache):
 *   Only requests with a Referer matching /public/:shortName/[...]
 *   participate in the cache. The admin work dashboard hits the same
 *   endpoints from a different Referer and bypasses the cache entirely
 *   so live moderation never sees stale data.
 *
 * Storage: single-process in-memory Map with TTL + LRU bound. Fine for a
 * single pm2 fork; would need Redis for horizontal scaling.
 *
 * Invalidation: flushPublicCache(shortName) called from series/channel
 * write paths so an operator edit (view-group change, channel add, etc.)
 * surfaces on the public side without waiting for TTL.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import logger from '../../utils/logger';

const MAX_ENTRIES = 1000;

interface CacheEntry {
  body: unknown;
  contentType: string;
  expiresAt: number;
  shortName: string;
  storedAt: number;
}

// Single shared LRU across all per-endpoint middlewares. Keyed on full URL
// (path + query), so different scopes / filters / endpoints don't collide.
const cache = new Map<string, CacheEntry>();

/** Any /public/<shortName>/... Referer is cacheable (live dashboard + reports). */
const PUBLIC_REFERER = /\/public\/[^/]+(\/|$|\?)/;

interface PublicCacheOptions {
  /** Time-to-live in milliseconds. */
  ttlMs: number;
  /** Optional label for X-Public-Cache header and logging. */
  label?: string;
  /**
   * Referer gate. 'public' (default) — only requests from /public/* pages
   * participate (admin work flows always pass through to fresh data). 'any'
   * — every GET caches regardless of Referer; use for heavy editor-side
   * aggregations that can tolerate a few seconds of staleness.
   */
  scope?: 'public' | 'any';
}

/**
 * Express middleware factory — call once per route with its own TTL.
 *
 *   router.get('/:short/live-ccv', publicCacheMiddleware({ ttlMs: 10_000, label: 'live-ccv' }), handler);
 *
 * The middleware short-circuits with a 200 + cached body on hit; on miss
 * it wraps res.json to capture the response for next time.
 */
export function publicCacheMiddleware(opts: PublicCacheOptions): RequestHandler {
  const { ttlMs, label = 'public', scope = 'public' } = opts;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();

    if (scope === 'public') {
      const referer = req.get('Referer') ?? '';
      if (!PUBLIC_REFERER.test(referer)) return next();
    }

    // Opt-out hook: clients can force-bypass with ?_nocache=1 (used by
    // server-side diagnostics that need a fresh read).
    if (req.query['_nocache'] === '1') return next();

    const shortName = (req.params['shortName'] as string | undefined) ?? '';
    const key = req.originalUrl;

    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      // LRU touch — move to end.
      cache.delete(key);
      cache.set(key, hit);
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('X-Public-Cache', `HIT ${label} age=${Math.round((now - hit.storedAt) / 1000)}s`);
      res.send(hit.body as Parameters<Response['send']>[0]);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (cache.size >= MAX_ENTRIES) {
          // Drop oldest insertion (Map iteration order is insertion order).
          const oldestKey = cache.keys().next().value;
          if (oldestKey) cache.delete(oldestKey);
        }
        cache.set(key, {
          body,
          contentType: 'application/json; charset=utf-8',
          expiresAt: now + ttlMs,
          shortName,
          storedAt: now,
        });
      }
      res.setHeader('X-Public-Cache', `MISS ${label}`);
      return originalJson(body);
    };

    next();
  };
}

/**
 * Flush cache entries.
 *   flushPublicCache()             — clear everything
 *   flushPublicCache(shortName)    — clear entries for one series only
 *
 * Call from series / channel write paths to surface edits without waiting
 * for TTL.
 */
export function flushPublicCache(shortName?: string): number {
  if (!shortName) {
    const n = cache.size;
    cache.clear();
    logger.info(`[PublicCache] Flushed all entries (n=${n})`);
    return n;
  }
  let count = 0;
  for (const [key, entry] of cache) {
    if (entry.shortName === shortName) {
      cache.delete(key);
      count++;
    }
  }
  if (count > 0) {
    logger.info(`[PublicCache] Flushed ${count} entries for series ${shortName}`);
  }
  return count;
}

/** Diagnostic — current size + sample keys. For tests / debug routes. */
export function getPublicCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()).slice(0, 20),
  };
}
