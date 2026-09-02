/**
 * Live video ids from a channel's /streams page, one per tile.
 *
 * YouTube's newer "lockupViewModel" tiles put the video id and the LIVE
 * badge in different places from the old videoRenderer markup; the old
 * "scan backwards from each LIVE badge" heuristic resolved two of three
 * badges to the same id on 2026-09-02 (GeoGuessr's C-stream was never
 * tracked). Splitting the page per tile makes each badge count for its
 * own video. Returns [] when the page carries no such tiles, so the
 * caller can fall back to the older strategies.
 */
export function extractLiveTileIds(html: string): string[] {
  const chunks = html.split('"lockupViewModel":');
  if (chunks.length < 2) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of chunks.slice(1)) {
    const tile = raw.slice(0, 20000);
    const id = tile.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!id) continue;
    const live =
      tile.includes('"imageName":"LIVE"') ||
      tile.includes('BADGE_STYLE_TYPE_LIVE_NOW') ||
      tile.includes('"style":"LIVE"');
    if (live && !seen.has(id[1])) {
      seen.add(id[1]);
      out.push(id[1]);
    }
  }
  return out;
}
