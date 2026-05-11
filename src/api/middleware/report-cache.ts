/**
 * Report Cache — scoped, opt-in caching for public-facing exported reports.
 *
 * Why scoped (not blanket on /api/public/*):
 * The admin work dashboard ALSO uses the public API endpoints
 * (publicRequest() in dashboard/src/services/api.ts), so caching the whole
 * /api/public/* surface would serve stale data to admins doing live moderation.
 *
 * Scope rule: only serve from / write to cache when the request's Referer
 * header is a public report URL (matches /public/:shortName/report/*).
 * Admin pages on the same domain (/, /:seriesId, /:seriesId/edit, /explore,
 * /discover, etc.) bypass cache entirely. Server-to-server / direct API hits
 * also bypass.
 *
 * Invalidation: ReportAgent calls flushReportCache() after each successful
 * export, clearing entries for the same series so the next visit recomputes.
 *
 * Storage: single-process in-memory Map with TTL + LRU bound. Fine for a
 * single pm2 fork; would need Redis if we ever scale to multiple instances.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import logger from '../../utils/logger';

const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 5 min default
const MAX_ENTRIES = 500;

interface CacheEntry {
  body: unknown;
  contentType: string;
  expiresAt: number;
  // Tags for selective flushing
  shortName: string;
  scopeId: string | null;
}

const cache = new Map<string, CacheEntry>();

/** Public report URL pattern — must match the Referer for cache to apply. */
const PUBLIC_REPORT_REFERER = /\/public\/[^/]+\/report\/(simple|detailed)(\/|$|\?)/;

/** Express middleware factory. */
export function reportCacheMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only GET requests are cacheable
    if (req.method !== 'GET') return next();

    // Only requests coming from a public report page are cacheable.
    // Admin dashboard hits the same endpoints but with different Referer.
    const referer = req.get('Referer') ?? '';
    if (!PUBLIC_REPORT_REFERER.test(referer)) return next();

    const shortName = (req.params['shortName'] as string | undefined) ?? '';
    const scopeId = (req.query['id'] as string | undefined) ?? null;
    const key = `${req.originalUrl}`;

    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      // LRU touch
      cache.delete(key);
      cache.set(key, hit);
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('X-Report-Cache', 'HIT');
      res.send(hit.body as Parameters<Response['send']>[0]);
      return;
    }

    // Cache miss — wrap res.json to capture the response.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // Only cache 2xx responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Evict oldest if at capacity
        if (cache.size >= MAX_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey) cache.delete(oldestKey);
        }
        cache.set(key, {
          body,
          contentType: 'application/json; charset=utf-8',
          expiresAt: now + DEFAULT_TTL_MS,
          shortName,
          scopeId,
        });
      }
      res.setHeader('X-Report-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

/**
 * Flush cache entries. Call from ReportAgent after each successful export so
 * the next public visit picks up fresh data.
 *
 * - `flushReportCache()` — clear everything (cheap, fine for low-volume).
 * - `flushReportCache(shortName)` — clear entries for one series.
 */
export function flushReportCache(shortName?: string): number {
  if (!shortName) {
    const n = cache.size;
    cache.clear();
    logger.info(`[ReportCache] Flushed all entries (n=${n})`);
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
    logger.info(`[ReportCache] Flushed ${count} entries for series ${shortName}`);
  }
  return count;
}

/** Diagnostic — current cache size + sample of keys. Used by tests / debug. */
export function getReportCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()).slice(0, 10),
  };
}
