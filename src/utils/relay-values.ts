/**
 * Validation for viewer counts arriving from relays (TikTok / Twitch
 * browser scraper). Relays are our own code but run on remote machines
 * and parse third-party pages; a malformed value must never reach an
 * INSERT (one bad row fails the whole batch and loses every channel in it).
 */

export const MAX_PLAUSIBLE_RELAY_CCV = 500_000;

/**
 * Coerce a relay-supplied viewer value into a usable integer.
 * Returns null when the value cannot be trusted: non-numeric, negative,
 * NaN/Infinity, or beyond the plausible ceiling.
 */
export function normalizeRelayViewers(
  raw: unknown,
  max: number = MAX_PLAUSIBLE_RELAY_CCV,
): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v < 0 || v > max) return null;
  return v;
}

/**
 * Tab-bleed signature: ≥3 channels in one push carrying the IDENTICAL
 * value (>100) means the scraper read the same tab for all of them.
 * Returns the set of identifiers (lower-cased) implicated.
 */
export function detectBleedIdentifiers(
  entries: Array<{ identifier: string; viewers: number | null }>,
  minGroup = 3,
  minValue = 100,
): Set<string> {
  const groups = new Map<number, string[]>();
  for (const e of entries) {
    if (e.viewers === null || e.viewers <= minValue) continue;
    const list = groups.get(e.viewers) ?? [];
    list.push(e.identifier.toLowerCase());
    groups.set(e.viewers, list);
  }
  const out = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length >= minGroup) for (const id of ids) out.add(id);
  }
  return out;
}
