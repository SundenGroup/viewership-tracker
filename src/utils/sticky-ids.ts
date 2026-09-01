/**
 * Sticky id merging — bridges momentary omissions in an upstream listing.
 *
 * YouTube's search.list intermittently omits a stream that is still live
 * (observed 2026-08-21: PUBG Esports EN's main stream vanished from search
 * for 16 minutes while demonstrably live; the map stream for 15 minutes).
 * A consumer that replaces its candidate set wholesale on every listing
 * loses the stream for as long as the omission lasts. Merging the fresh
 * listing with ids seen within a TTL keeps them as candidates; the caller's
 * per-id validation (videos.list) decides what is actually live.
 *
 * Pure: no clocks, no I/O. The caller owns the history map.
 */

export type StickyHistory = Map<string, number>; // id → last seen (epoch ms)

export interface StickyMergeResult {
  /** Fresh ids first (in listing order), then still-valid sticky ids. */
  ids: string[];
  /** Ids restored from history rather than present in the fresh listing. */
  restored: string[];
}

export function mergeStickyIds(
  history: StickyHistory,
  freshIds: string[],
  nowMs: number,
  ttlMs: number,
): StickyMergeResult {
  for (const id of freshIds) history.set(id, nowMs);
  for (const [id, seenAt] of [...history.entries()]) {
    if (nowMs - seenAt > ttlMs) history.delete(id);
  }
  const fresh = new Set(freshIds);
  const restored = [...history.keys()].filter((id) => !fresh.has(id));
  return { ids: [...freshIds, ...restored], restored };
}

/** Forget an id immediately (e.g. confirmed ended by per-id validation). */
export function dropStickyId(history: StickyHistory, id: string): void {
  history.delete(id);
}
