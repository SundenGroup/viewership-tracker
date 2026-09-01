/**
 * Multi-stream slot binding — which of a channel's simultaneous streams
 * goes to the parent row and which to each ":stream-N" child.
 *
 * Previously slots were assigned by viewer RANK every cycle (highest →
 * parent). Two failure modes followed, both observed on 2026-08-21:
 *   • when the main stream dropped out of YouTube's search, the remaining
 *     (map) stream was promoted to the parent row — the main channel's
 *     numbers became the map's numbers;
 *   • when two streams swapped rank, their rows swapped children.
 *
 * Here a slot is bound to a VIDEO ID and keeps it until that id has been
 * absent longer than `ttlMs`. A stream that is missing this cycle leaves
 * its slot EMPTY (no row) rather than letting another stream take it.
 *
 * Pure: the caller loads/persists bindings and creates child rows.
 */

export interface SlotBinding {
  /** Bound video id, or null when the slot is free. */
  videoId: string | null;
  /** Last time the bound id was seen live (epoch ms). */
  seenAt: number | null;
}

export interface MultiStreamBindings {
  parent: SlotBinding;
  /** Keyed by child index (2, 3, …). */
  children: Map<number, SlotBinding>;
}

export interface StreamCandidate {
  videoId: string;
  viewers: number;
}

export interface SlotAssignment {
  /** Video id that goes to the parent row this cycle, or null (leave empty). */
  parentVideoId: string | null;
  /** child index → video id for this cycle (only slots that got a stream). */
  childAssignments: Map<number, string>;
  /** Child indexes that must be created by the caller before use. */
  newChildIndexes: number[];
  /** Updated bindings to persist (only when `changed` is true). */
  bindings: MultiStreamBindings;
  changed: boolean;
}

const isStale = (b: SlotBinding, now: number, ttl: number): boolean =>
  b.videoId === null || b.seenAt === null || now - b.seenAt > ttl;

/**
 * Assign this cycle's live streams to slots.
 *
 * Rules, in order:
 *  1. A stream whose id is bound to a slot goes to that slot (parent or child).
 *  2. Unbound streams, highest viewers first: take the parent slot if it is
 *     free or its binding is stale; else the first stale/free child slot;
 *     else a new child slot (next index).
 *  3. A bound slot whose stream is absent this cycle stays EMPTY. It is
 *     released only once the binding is older than `ttlMs`.
 */
export function assignMultiStreamSlots(
  candidates: StreamCandidate[],
  current: MultiStreamBindings,
  nowMs: number,
  ttlMs: number,
): SlotAssignment {
  // Work on copies so the caller's object is untouched until persisted.
  const bindings: MultiStreamBindings = {
    parent: { ...current.parent },
    children: new Map([...current.children.entries()].map(([k, v]) => [k, { ...v }])),
  };
  let changed = false;
  const childAssignments = new Map<number, string>();
  const newChildIndexes: number[] = [];
  let parentVideoId: string | null = null;

  const byId = new Map(candidates.map((c) => [c.videoId, c]));
  const unassigned = new Set(candidates.map((c) => c.videoId));

  // 1. Honor existing bindings.
  if (bindings.parent.videoId && byId.has(bindings.parent.videoId)) {
    parentVideoId = bindings.parent.videoId;
    bindings.parent.seenAt = nowMs;
    unassigned.delete(parentVideoId);
  }
  for (const [idx, b] of bindings.children) {
    if (b.videoId && byId.has(b.videoId)) {
      childAssignments.set(idx, b.videoId);
      b.seenAt = nowMs;
      unassigned.delete(b.videoId);
    }
  }

  // 2. Place unbound streams, biggest first.
  const remaining = [...unassigned]
    .map((id) => byId.get(id)!)
    .sort((a, b) => b.viewers - a.viewers);
  for (const cand of remaining) {
    if (parentVideoId === null && isStale(bindings.parent, nowMs, ttlMs)) {
      bindings.parent = { videoId: cand.videoId, seenAt: nowMs };
      parentVideoId = cand.videoId;
      changed = true;
      continue;
    }
    // First child slot that is free/stale AND not assigned this cycle.
    let placed = false;
    const indexes = [...bindings.children.keys()].sort((a, b) => a - b);
    for (const idx of indexes) {
      const b = bindings.children.get(idx)!;
      if (childAssignments.has(idx)) continue;
      if (isStale(b, nowMs, ttlMs)) {
        bindings.children.set(idx, { videoId: cand.videoId, seenAt: nowMs });
        childAssignments.set(idx, cand.videoId);
        changed = true;
        placed = true;
        break;
      }
    }
    if (placed) continue;
    const nextIdx = indexes.length > 0 ? Math.max(...indexes) + 1 : 2;
    bindings.children.set(nextIdx, { videoId: cand.videoId, seenAt: nowMs });
    childAssignments.set(nextIdx, cand.videoId);
    newChildIndexes.push(nextIdx);
    changed = true;
  }

  return { parentVideoId, childAssignments, newChildIndexes, bindings, changed };
}
