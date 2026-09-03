/**
 * Parser for TikTok's live page (https://www.tiktok.com/@user/live).
 *
 * The page embeds the room state as JSON: "status": 2 means live, and
 * liveRoomStats.userCount is the viewer number TikTok shows next to the
 * eye icon. Same fields the residential relay script has always read
 * (scripts/tiktok-relay.ts); verified on 2026-09-03 to match the relay's
 * reading to the viewer, minute by minute, when fetched from the server.
 *
 * `unusable` is the important distinction: a page without any status
 * field is not a channel page (challenge, block, error), and must be
 * treated as a failed fetch, never as "offline".
 */
export interface TikTokLivePage {
  /** No room status in the HTML at all: not a channel page (block / challenge / error). */
  unusable: boolean;
  isLive: boolean;
  viewers: number;
  title: string | null;
  displayName: string | null;
}

export function parseTikTokLivePage(html: string | null | undefined): TikTokLivePage {
  const empty: TikTokLivePage = { unusable: true, isLive: false, viewers: 0, title: null, displayName: null };
  if (typeof html !== 'string' || html.length < 1000) return empty;
  const status = html.match(/"status"\s*:\s*(\d+)/);
  if (!status) return empty;
  if (status[1] !== '2') return { unusable: false, isLive: false, viewers: 0, title: null, displayName: null };
  const stats = html.match(/"liveRoomStats"\s*:\s*\{[^}]*"userCount"\s*:\s*(\d+)/);
  const viewers = stats ? parseInt(stats[1] ?? '0', 10) : 0;
  const name = html.match(/"nickname"\s*:\s*"([^"]+)"/);
  const sig = html.match(/"signature"\s*:\s*"([^"]+)"/);
  return {
    unusable: false,
    isLive: true,
    viewers: Number.isFinite(viewers) ? viewers : 0,
    title: sig ? (sig[1] ?? '').replace(/\\n/g, ' ').slice(0, 200) : null,
    displayName: name ? name[1] ?? null : null,
  };
}
