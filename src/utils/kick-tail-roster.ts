/**
 * The streams of a Kick category that sit below a language's 100-row list.
 *
 * Kick's listing returns the 100 largest streams and has no paging. Asked
 * per language it returns each language's own 100, which is complete for
 * most languages but not for the big ones: on GTA VI launch day the English
 * list ended at 119 viewers and the Portuguese one at 38.
 *
 * Two things the API does allow close that gap. It can list a language's
 * most recently STARTED streams, and it can read any stream by channel id,
 * 50 per call. So every stream is noted when it starts (or when it is seen
 * in a list) and then followed by id for as long as it stays live. This
 * class is the memory of who is being followed; the adapter does the
 * calls. A stream that was already running below the list before we began
 * watching is only picked up when it next starts.
 *
 * Large and young streams are read on every poll. Small old ones are read
 * every few minutes, enough to notice one growing past the viewer floor.
 */

export interface TailEntry {
  viewers: number;
  lastLiveMs: number;
  firstSeenMs: number;
  lastReadMs: number;
}

export interface TailDuePolicy {
  /** Streams at or above this many viewers are read on every poll. */
  hotAtLeast: number;
  /** Streams first seen within this window are read on every poll too: they may still grow. */
  youngForMs: number;
  /** The rest are read this often. */
  coldEveryMs: number;
}

/** [channel id, viewers, last seen live, first seen] as kept on disk. */
export type TailRow = [number, number, number, number];

export class KickTailRoster {
  private readonly entries = new Map<number, TailEntry>();

  get size(): number {
    return this.entries.size;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  /** The stream was seen live just now, in a list or in a read by id. */
  observe(id: number, viewers: number, nowMs: number): void {
    if (!Number.isFinite(id) || id <= 0) return;
    const cur = this.entries.get(id);
    if (cur) {
      cur.viewers = viewers;
      cur.lastLiveMs = nowMs;
    } else {
      this.entries.set(id, { viewers, lastLiveMs: nowMs, firstSeenMs: nowMs, lastReadMs: 0 });
    }
  }

  /**
   * The ids to read by id on this poll. `covered` are streams a list
   * already returned this poll: they need no second read.
   */
  due(nowMs: number, covered: Set<number>, policy: TailDuePolicy): number[] {
    const out: number[] = [];
    for (const [id, e] of this.entries) {
      if (covered.has(id)) continue;
      const hot = e.viewers >= policy.hotAtLeast || nowMs - e.firstSeenMs < policy.youngForMs;
      if (hot || nowMs - e.lastReadMs >= policy.coldEveryMs) out.push(id);
    }
    return out;
  }

  markRead(ids: number[], nowMs: number): void {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.lastReadMs = nowMs;
    }
  }

  /** Forget streams not seen live for `ttlMs`. Returns how many were dropped. */
  prune(nowMs: number, ttlMs: number): number {
    let dropped = 0;
    for (const [id, e] of this.entries) {
      if (nowMs - e.lastLiveMs > ttlMs) {
        this.entries.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  dump(): TailRow[] {
    return [...this.entries.entries()].map(([id, e]) => [id, e.viewers, e.lastLiveMs, e.firstSeenMs]);
  }

  /** Rebuild from disk, leaving out anything already older than `ttlMs`. */
  static load(rows: unknown, nowMs: number, ttlMs: number): KickTailRoster {
    const roster = new KickTailRoster();
    if (!Array.isArray(rows)) return roster;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const [id, viewers, lastLiveMs, firstSeenMs] = row.map(Number);
      if (![id, viewers, lastLiveMs, firstSeenMs].every(Number.isFinite) || id <= 0) continue;
      if (nowMs - lastLiveMs > ttlMs) continue;
      roster.entries.set(id, { viewers, lastLiveMs, firstSeenMs, lastReadMs: 0 });
    }
    return roster;
  }
}
