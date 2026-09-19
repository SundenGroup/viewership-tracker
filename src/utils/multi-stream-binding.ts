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
 * Which unbound stream takes the parent is decided by what the stream IS,
 * not by its audience at that second: a title that marks a side stream
 * ("[MAP] …", "B-Stream") never takes the parent row. On 2026-09-18 the
 * PAS2 map stream had 25 viewers and the main broadcast 14 at the first
 * poll, the map took the parent, and the binding kept the two rows swapped
 * for the whole day.
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
  /** Live title, when the adapter has one: tells a side stream from the main one. */
  title?: string | null;
}

/**
 * The side-stream marker in a live title, normalised ("map", "b-stream"), or
 * null for a main broadcast. Deliberately narrow: "[MAP] PUBG Americas Series"
 * and "World Championship | B-Stream" are side streams, "New map reveal" is not.
 */
export function sideStreamMarker(title: string | null | undefined): string | null {
  if (!title) return null;
  if (/^\s*[\[(【]?\s*map\s*[\])】]?(?=$|[\s:|-])/i.test(title)) return 'map';
  const lettered = /(?:^|[\s\[(|:-])([b-d])[\s-]?stream\b/i.exec(title);
  if (lettered) return `${lettered[1].toLowerCase()}-stream`;
  return null;
}

/** Whether a child row's name says it is the home of that side stream ("PUBG Esports Map", "GeoGuessr - C-Stream"). */
export function labelMatchesMarker(label: string | null | undefined, marker: string): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  if (marker === 'map') return /\bmap\b/.test(l);
  const letter = marker.charAt(0);
  return new RegExp(`(^|[^a-z])${letter}[\\s-]?stream\\b`).test(l);
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
 *  2. Unbound streams, main broadcasts before side streams, then highest
 *     viewers first. A main broadcast takes the parent slot if it is free or
 *     its binding is stale. A side stream ("[MAP] …") never takes the parent:
 *     it goes to the free child whose name carries its marker, else like any
 *     other stream to the first stale/free child slot, else a new child slot.
 *  3. A bound slot whose stream is absent this cycle stays EMPTY. It is
 *     released only once the binding is older than `ttlMs`.
 */
export function assignMultiStreamSlots(
  candidates: StreamCandidate[],
  current: MultiStreamBindings,
  nowMs: number,
  ttlMs: number,
  /** Child index → display name, so a side stream finds the row named after it. */
  childLabels: Map<number, string> = new Map(),
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

  // 2. Place unbound streams: main broadcasts first, then biggest first.
  const remaining = [...unassigned]
    .map((id) => ({ cand: byId.get(id)!, marker: sideStreamMarker(byId.get(id)!.title) }))
    .sort((a, b) => Number(a.marker !== null) - Number(b.marker !== null) || b.cand.viewers - a.cand.viewers);
  for (const { cand, marker } of remaining) {
    if (marker === null && parentVideoId === null && isStale(bindings.parent, nowMs, ttlMs)) {
      bindings.parent = { videoId: cand.videoId, seenAt: nowMs };
      parentVideoId = cand.videoId;
      changed = true;
      continue;
    }
    // First child slot that is free/stale AND not assigned this cycle; a side
    // stream looks for the child named after it before taking any other.
    let placed = false;
    const free = [...bindings.children.keys()].sort((a, b) => a - b);
    const indexes = marker
      ? [...free.filter((i) => labelMatchesMarker(childLabels.get(i), marker)), ...free.filter((i) => !labelMatchesMarker(childLabels.get(i), marker))]
      : free;
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
    const nextIdx = free.length > 0 ? Math.max(...free) + 1 : 2;
    bindings.children.set(nextIdx, { videoId: cand.videoId, seenAt: nowMs });
    childAssignments.set(nextIdx, cand.videoId);
    newChildIndexes.push(nextIdx);
    changed = true;
  }

  return { parentVideoId, childAssignments, newChildIndexes, bindings, changed };
}

/**
 * Which video id a LONE candidate should carry.
 *
 * The /live page reading never goes through the per-id ownership gate, and
 * its video id field can bleed from another page while the viewer count is
 * still the channel's featured stream. A lone, unverified candidate whose id
 * is bound to no slot, while the parent's stream was seen live within
 * `ttlMs`, is that stream under a bled id: it must never mint a child.
 * (2026-09-14 02:29 UTC: PUBGEsports' last two readings created
 * "(Stream 3)" and "(Stream 4)" children under a NASA broadcast id and a
 * Minecraft video id while the API pool was exhausted.)
 *
 * Returns the id the reading should be filed under.
 */
export function reattributeLoneUnverified(
  candidateVideoId: string,
  ownerVerified: boolean | undefined,
  current: MultiStreamBindings,
  nowMs: number,
  ttlMs: number,
): string {
  if (ownerVerified === true) return candidateVideoId;
  const boundSomewhere =
    current.parent.videoId === candidateVideoId ||
    [...current.children.values()].some((b) => b.videoId === candidateVideoId);
  if (boundSomewhere) return candidateVideoId;
  const p = current.parent;
  if (p.videoId && p.seenAt !== null && nowMs - p.seenAt <= ttlMs) return p.videoId;
  return candidateVideoId;
}
