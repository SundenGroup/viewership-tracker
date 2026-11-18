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
 * The relay box captures them like any other category. Which of their
 * rooms the tracker counts is set by metadata.tiktok_extra_rule:
 *
 *   "named" (the default)   only rooms whose title names the tracker's game
 *   "all_but_excluded"      every room, except those whose title carries
 *                           an excluded word (the other game's name)
 *
 * The second fits a launch, when nearly every room in the predecessor's
 * category is the new game and most titles name no game at all.
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

export type TikTokExtraRule = 'named' | 'all_but_excluded';

/** How rooms of a neighbouring category are admitted (see the file header). */
export function tiktokExtraRule(metadata: unknown): TikTokExtraRule {
  let meta: unknown = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return 'named';
    }
  }
  if (!meta || typeof meta !== 'object') return 'named';
  return (meta as Record<string, unknown>).tiktok_extra_rule === 'all_but_excluded' ? 'all_but_excluded' : 'named';
}
