/**
 * Known-channel watchlist — the reliability half of YouTube discovery.
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * Keyword discovery finds channels we've never seen, but it's fragile for
 * channels we already know: an approved streamer who titles today's stream
 * "PNC Day 3 — watch party" matches no game keyword and would silently
 * drop out of the tracker. Since a human already vouched for that channel,
 * we shouldn't be re-deriving membership from their title every day.
 *
 * So allowed channels are watched directly through their RSS feed
 * (`/feeds/videos.xml?channel_id=…`) — no API key, no quota, no redirect
 * roulette. The feed lists recent uploads including live streams; we take
 * the newest few ids and let videos.list decide which are actually live.
 * Non-live ids simply don't come back with a viewer count, so a wrong
 * guess here costs nothing.
 *
 * This is also the honest answer to "can we enumerate everyone streaming
 * game X?" — you can't, on any YouTube API. What you can do is remember
 * every channel you've ever confirmed and keep watching them, so coverage
 * accumulates instead of depending on what a search happens to surface.
 */
import axios from 'axios';
import logger from '../utils/logger';

const RSS_TIMEOUT_MS = 8_000;
/** How often to re-read one channel's feed. */
const WATCH_INTERVAL_MS = 10 * 60_000;
/** Newest N ids per feed — a live stream is always the most recent entry. */
const IDS_PER_FEED = 3;
/** Feeds fetched per cycle, so a big allow-list spreads over many cycles. */
const MAX_FEEDS_PER_CYCLE = 12;

const client = axios.create({
  timeout: RSS_TIMEOUT_MS,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/atom+xml,application/xml',
  },
  validateStatus: (s) => s < 500,
});

/** channelId → last fetch (module-level: the tracker service is a singleton). */
const lastFetched = new Map<string, number>();

async function recentVideoIds(channelId: string): Promise<string[]> {
  const { data, status } = await client.get<string>(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    { responseType: 'text' },
  );
  if (status !== 200 || typeof data !== 'string') return [];
  const ids: string[] = [];
  const re = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null && ids.length < IDS_PER_FEED) ids.push(m[1]);
  return ids;
}

/**
 * Candidate video ids for channels we've already approved. Throttled per
 * channel and capped per cycle; failures are swallowed (a feed hiccup must
 * never disturb the poll cycle).
 */
export async function watchlistVideoIds(channelIds: string[]): Promise<string[]> {
  const now = Date.now();
  const due = channelIds
    .filter((id) => now - (lastFetched.get(id) ?? 0) >= WATCH_INTERVAL_MS)
    .slice(0, MAX_FEEDS_PER_CYCLE);
  if (due.length === 0) return [];

  const out: string[] = [];
  for (const channelId of due) {
    lastFetched.set(channelId, now); // mark first: a failure shouldn't hot-loop
    try {
      out.push(...(await recentVideoIds(channelId)));
    } catch (err) {
      logger.debug(`[YTWatch] feed failed for ${channelId}: ${(err as Error).message}`);
    }
  }
  logger.debug(`[YTWatch] ${due.length} feed(s) → ${out.length} candidate id(s)`);
  return out;
}
