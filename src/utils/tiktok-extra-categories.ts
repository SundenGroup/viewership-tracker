/**
 * Neighbouring TikTok LIVE categories of a game tracker.
 *
 * A tracker follows one TikTok category in full
 * (game_trackers.tiktok_category_slug). When a new game launches, a large
 * share of its streams is still filed under the predecessor's category
 * (GTA VI under "Grand Theft Auto V"), which holds the old game as well.
 * Such categories are listed in the tracker's metadata:
 *
 *   metadata.tiktok_extra_categories = ["gaming/Grand_Theft_Auto_V"]
 *
 * The relay box captures them like any other category; the tracker then
 * counts only the rooms whose title names its own game.
 */

/** A category path as it appears in tiktok.com/live/category/<path>. */
const CATEGORY_PATH = /^[A-Za-z0-9_:.\-]+(\/[A-Za-z0-9_:.\-]+)*$/;

export function tiktokExtraCategories(metadata: unknown): string[] {
  let meta: unknown = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return [];
    }
  }
  if (!meta || typeof meta !== 'object') return [];
  const list = (meta as Record<string, unknown>).tiktok_extra_categories;
  if (!Array.isArray(list)) return [];
  const out = list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length <= 120 && CATEGORY_PATH.test(x));
  return [...new Set(out)];
}
