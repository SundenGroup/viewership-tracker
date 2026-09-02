/**
 * Ownership gate for multi-stream YouTube candidates (pure, unit-tested).
 *
 * A candidate video id found on a channel's /streams page may belong to
 * another channel (YouTube shows other people's live tiles there). The
 * gate keeps an id only when videos.list confirmed the owner, or when the
 * same channel already proved ownership of that id recently. When the
 * owner lookup is unavailable, nothing NEW gets through: fail closed.
 */

export const VERIFIED_ID_TTL_MS = 30 * 60_000;

export interface OwnershipGateResult {
  kept: string[];
  /** ids whose owner was positively someone else, or which the API did not return */
  rejected: Array<{ videoId: string; owner: string }>;
  /** ids dropped only because the owner lookup was unavailable */
  unverified: string[];
}

export function gateMultiStreamIds(
  channelId: string,
  candidates: string[],
  owners: Map<string, string> | null,
  previouslyVerified: Map<string, number>,
  nowMs: number,
  ttlMs = VERIFIED_ID_TTL_MS,
): OwnershipGateResult {
  const kept: string[] = [];
  const rejected: Array<{ videoId: string; owner: string }> = [];
  const unverified: string[] = [];
  const stillValid = (vid: string) => {
    const t = previouslyVerified.get(vid);
    return t != null && nowMs - t < ttlMs;
  };
  for (const vid of candidates) {
    if (owners) {
      const owner = owners.get(vid);
      if (owner === channelId) {
        kept.push(vid);
        previouslyVerified.set(vid, nowMs);
      } else {
        rejected.push({ videoId: vid, owner: owner ?? '<not-returned>' });
      }
    } else if (stillValid(vid)) {
      kept.push(vid);
    } else {
      unverified.push(vid);
    }
  }
  for (const [vid, t] of [...previouslyVerified.entries()]) {
    if (nowMs - t >= ttlMs) previouslyVerified.delete(vid);
  }
  return { kept, rejected, unverified };
}
