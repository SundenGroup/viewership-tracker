/**
 * Merge rules for TikTok readings that arrive from several sources for
 * the same channel and minute (server page fetch, residential page
 * scrapes, WebSocket trackers, browser DOM fallbacks).
 *
 * "Highest value wins" was the old rule; it let a frozen browser reading
 * (a flat 728 repeated for hours) beat live readings of 150 on
 * 2026-09-03. Now:
 *   - sources have a rank; a higher-ranked source's reading is not
 *     replaced by a lower-ranked one within the minute; equal ranks keep
 *     the larger value (two page scrapes agree to the viewer anyway);
 *   - a source that reports the identical value for STALE_REPEATS
 *     consecutive minutes while another source reported a different value
 *     recently is stale for that channel, and its readings are ignored
 *     until it changes.
 */
export const STALE_REPEATS = 5;
/** Another source must have reported within this window for a repeat to count as stale. */
export const OTHER_SOURCE_WINDOW_MS = 5 * 60_000;

export type TikTokSource = 'ws' | 'browser-ws' | 'server-page' | 'page-scrape' | 'browser-dom' | 'unknown';

export function normalizeSource(raw: unknown): TikTokSource {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'ws' || s === 'browser-ws') return s;
  if (s === 'server-page' || s === 'page-scrape') return s;
  if (s === 'browser-dom') return 'browser-dom';
  return 'unknown';
}

/** Higher is more trusted. Legacy relays without a tag are page scrapes. */
export function sourceRank(source: TikTokSource): number {
  switch (source) {
    case 'ws':
    case 'browser-ws':
      return 3;
    case 'server-page':
    case 'page-scrape':
    case 'unknown':
      return 2;
    case 'browser-dom':
      return 1;
    default:
      return 0;
  }
}

/**
 * Whether an incoming reading should replace the one already stored for
 * the same channel and minute. `existingSource` is null when the stored
 * row's source is unknown (server restart, or written before tagging).
 */
export function shouldReplace(
  existing: { value: number; source: TikTokSource | null },
  incoming: { value: number; source: TikTokSource },
): boolean {
  const er = existing.source ? sourceRank(existing.source) : 2;
  const ir = sourceRank(incoming.source);
  if (ir > er) return true;
  if (ir < er) return false;
  return incoming.value > existing.value;
}

interface SourceState {
  lastValue: number;
  repeats: number; // consecutive minutes with the same value
  lastMinute: number;
}

/**
 * Per (channel, source) repeat tracking with the "another source moved"
 * condition. In-memory; a restart forgets it, which only means a stale
 * source gets STALE_REPEATS more minutes before being caught again.
 */
export class StaleSourceTracker {
  private state = new Map<string, SourceState>();
  private lastByChannel = new Map<string, Map<TikTokSource, { value: number; at: number }>>();

  /**
   * Record a reading and say whether it is stale. `minuteMs` is the
   * reading's minute (any ms within it); `nowMs` the wall clock.
   */
  observe(channelKey: string, source: TikTokSource, value: number, minuteMs: number, nowMs = Date.now()): { stale: boolean; repeats: number } {
    const minute = Math.floor(minuteMs / 60_000);
    const key = `${channelKey}|${source}`;
    const prev = this.state.get(key);
    let repeats = 1;
    if (prev && prev.lastValue === value && minute !== prev.lastMinute) repeats = prev.repeats + 1;
    else if (prev && prev.lastValue === value && minute === prev.lastMinute) repeats = prev.repeats;
    this.state.set(key, { lastValue: value, repeats, lastMinute: minute });

    const others = this.lastByChannel.get(channelKey) ?? new Map();
    let otherMoved = false;
    for (const [src, r] of others) {
      if (src === source) continue;
      if (nowMs - r.at <= OTHER_SOURCE_WINDOW_MS && r.value !== value) otherMoved = true;
    }
    others.set(source, { value, at: nowMs });
    this.lastByChannel.set(channelKey, others);

    return { stale: repeats >= STALE_REPEATS && otherMoved, repeats };
  }
}
