/**
 * Per-tracker settings that live in game_trackers.metadata instead of a
 * column of their own (no schema change needed to add one):
 *
 *   chzzk_category_id     "Grand_Theft_Auto_VI" — the id in the CHZZK
 *                         category URL; "TYPE/id" for a type other than GAME
 *   chzzk_category_name   display name of that category ("GTA 6")
 *   kick_language_split   true → list the Kick category per language as
 *                         well, past the listing's 100 rows
 *
 * See also tiktok-extra-categories.ts (tiktok_extra_categories).
 */

function asObject(metadata: unknown): Record<string, unknown> | null {
  let meta: unknown = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

const CHZZK_CATEGORY = /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)?$/;

export function chzzkCategory(metadata: unknown): { id: string; name: string | null } | null {
  const meta = asObject(metadata);
  const id = typeof meta?.chzzk_category_id === 'string' ? meta.chzzk_category_id.trim() : '';
  if (!id || id.length > 120 || !CHZZK_CATEGORY.test(id)) return null;
  const name = typeof meta?.chzzk_category_name === 'string' && meta.chzzk_category_name.trim()
    ? meta.chzzk_category_name.trim()
    : null;
  return { id, name };
}

export function kickLanguageSplit(metadata: unknown): boolean {
  return asObject(metadata)?.kick_language_split === true;
}
