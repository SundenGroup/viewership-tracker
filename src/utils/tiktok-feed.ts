/**
 * Parser for TikTok's webcast feed response
 * (webcast.tiktok.com/webcast/feed/ — the payload behind
 * tiktok.com/live/gaming/<Category> pages).
 *
 * Verified shape (2026-08): top level { status_code, extra, data };
 * data is an array of items { type, rid, data: <room> } where room
 * carries id_str, user_count, title, owner { display_id, nickname },
 * language, hashtag { title }. Everything here is defensive — TikTok
 * reshuffles fields without notice, so a malformed item is skipped,
 * never thrown on.
 */

export interface TikTokFeedRoom {
  /** Bare username (no @) — owner.display_id. */
  username: string;
  nickname: string | null;
  roomId: string | null;
  title: string | null;
  viewerCount: number;
  language: string | null;
}

export function parseFeedRooms(feedJson: unknown): TikTokFeedRoom[] {
  const out: TikTokFeedRoom[] = [];
  const top = feedJson as { status_code?: number; data?: unknown } | null;
  if (!top || top.status_code !== 0 || !Array.isArray(top.data)) return out;
  for (const item of top.data) {
    const room = ((item as { data?: unknown })?.data ?? item) as Record<string, unknown> | null;
    if (!room || typeof room !== 'object') continue;
    const owner = room.owner as Record<string, unknown> | undefined;
    const username = typeof owner?.display_id === 'string' ? owner.display_id.trim() : '';
    if (!username) continue;
    const count = Number(room.user_count);
    out.push({
      username,
      nickname: typeof owner?.nickname === 'string' && owner.nickname ? owner.nickname : null,
      roomId:
        typeof room.id_str === 'string' && room.id_str
          ? room.id_str
          : room.id != null
            ? String(room.id)
            : null,
      title: typeof room.title === 'string' && room.title ? room.title : null,
      viewerCount: Number.isFinite(count) && count > 0 ? Math.round(count) : 0,
      language: typeof room.language === 'string' && room.language ? room.language : null,
    });
  }
  return out;
}
