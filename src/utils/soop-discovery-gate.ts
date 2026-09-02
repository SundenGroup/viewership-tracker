/**
 * SOOP's keyword search (liveSearch) spans every category on the platform,
 * unlike the Twitch/YouTube searches Scout runs, which are scoped to the
 * event's game. A keyword like "wc" or "world" therefore returns Sudden
 * Attack clan streams and a billiards World Cup. A SOOP hit only counts
 * when it sits in the series' configured SOOP category; a series with no
 * SOOP category configured gets no SOOP keyword hits at all.
 */
export function soopStreamInCategory(
  stream: { platformCategoryId?: string | null },
  configuredCategoryId: string | null | undefined,
): boolean {
  if (!configuredCategoryId) return false;
  if (!stream.platformCategoryId) return false;
  return normalize(stream.platformCategoryId) === normalize(configuredCategoryId);
}

/** SOOP category codes are zero-padded 8-digit strings; compare without the padding. */
function normalize(id: string): string {
  return id.trim().replace(/^0+(?=\d)/, '');
}
