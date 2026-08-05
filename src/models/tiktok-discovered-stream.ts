import db from '../utils/db';
import type { TikTokFeedRoom } from '../utils/tiktok-feed';

/**
 * Staging buffer for TikTok live-category discovery — written by the
 * relay (residential Chrome captures the signed category feed), read by
 * TikTokAdapter.searchLiveStreams(). See the migration for the why.
 */

const TABLE = 'tiktok_discovered_streams';

/** Rows older than this are never served to discovery. */
export const FRESH_WINDOW_MINUTES = 15;
/** Rows older than this get swept on the next relay push. */
const SWEEP_AFTER_HOURS = 24;

export interface TikTokDiscoveredStream {
  id: string;
  category: string;
  username: string;
  nickname: string | null;
  room_id: string | null;
  title: string | null;
  viewer_count: number;
  language: string | null;
  captured_at: Date;
}

export async function upsertBatch(category: string, rooms: TikTokFeedRoom[]): Promise<number> {
  if (rooms.length === 0) return 0;
  // One row per (category, username); a fresh capture always wins.
  const rows = rooms.map((r) => ({
    category,
    username: r.username.replace(/^@/, '').toLowerCase(),
    nickname: r.nickname,
    room_id: r.roomId,
    title: r.title,
    viewer_count: r.viewerCount,
    language: r.language,
    captured_at: new Date(),
  }));
  await db(TABLE)
    .insert(rows)
    .onConflict(['category', 'username'])
    .merge(['nickname', 'room_id', 'title', 'viewer_count', 'language', 'captured_at']);
  return rows.length;
}

/** Streams captured recently enough to be treated as live right now. */
export async function freshStreams(maxAgeMinutes = FRESH_WINDOW_MINUTES): Promise<TikTokDiscoveredStream[]> {
  return db<TikTokDiscoveredStream>(TABLE)
    .where('captured_at', '>', new Date(Date.now() - maxAgeMinutes * 60_000))
    .orderBy('viewer_count', 'desc')
    .select('*');
}

/**
 * One category's fresh rooms, for the Discover live tracker. Tighter
 * window than event discovery: one relay interval (5 min) plus slack,
 * so a stream that ended stops being served within ~2 poll cycles
 * instead of lingering for 15 minutes.
 */
export async function freshStreamsForCategory(
  category: string,
  maxAgeMinutes = 7,
): Promise<TikTokDiscoveredStream[]> {
  return db<TikTokDiscoveredStream>(TABLE)
    .where('category', category)
    .where('captured_at', '>', new Date(Date.now() - maxAgeMinutes * 60_000))
    .orderBy('viewer_count', 'desc')
    .select('*');
}

export async function sweep(): Promise<number> {
  return db(TABLE)
    .where('captured_at', '<', new Date(Date.now() - SWEEP_AFTER_HOURS * 3_600_000))
    .delete();
}
