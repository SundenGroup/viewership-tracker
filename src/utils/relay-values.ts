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

/**
 * A browser badge that reads far above the Helix value for the same
 * channel is a Stream Together combined count, not the channel's own
 * audience. Absolute rule (2× or +500) for big channels, relative rule
 * (1.5×) so a 500-viewer channel showing 815 is caught too.
 */
export function looksLikeCombinedBadge(relayViewers: number, helixViewers: number): boolean {
  if (relayViewers > Math.max(helixViewers * 2, helixViewers + 500)) return true;
  return helixViewers >= 200 && relayViewers > helixViewers * 1.5;
}

/**
 * Every participant of a Stream Together shows the SAME combined number
 * on their badge. When one channel is flagged with combined value C, any
 * other channel in the same push whose badge is within `tolerance` of C
 * is a co-participant whose badge is inflated by the same amount, even
 * when the inflation is small next to their own audience (BastiGHG's
 * 10K badge carried Dimeax's 600 for four hours under the absolute rule).
 */
export function sharesCombinedNumber(
  value: number,
  flaggedCombinedValues: number[],
  tolerance = 0.02,
  minValue = 1000,
): boolean {
  if (value < minValue) return false;
  return flaggedCombinedValues.some((c) => c > 0 && Math.abs(value - c) / c <= tolerance);
}
