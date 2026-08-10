/**
 * TikTok relay ingest guard.
 *
 * The residential tracker occasionally re-emits a stale cached reading
 * (or a bare zero) when its connection to a room drops and re-forms.
 * In the data that looks like a one-minute collapse: 9,654 → 686 → 5,886,
 * with the impostor value often hours old. Three PGS7 broadcast days in
 * a row needed hand-repair (interpolate the collapsed minute), so this
 * guard moves the defence to ingest time.
 *
 * Core idea: a sudden plunge is not credible on its own — it needs a
 * second opinion. When a channel's incoming value drops below half of
 * its fresh last-accepted level, the push is HELD (not written). On the
 * channel's next report:
 *   - still low → the drop was real (stream ending, raid over): the held
 *     value is released for insertion with its ORIGINAL timestamp, so
 *     the record stays complete and honest;
 *   - recovered → the held value was the relay artifact: it is dropped,
 *     and the curve never contains the false collapse.
 *
 * Costs and limits, stated plainly:
 *   - A genuine cliff-drop appears in the DB one relay cycle (~60s)
 *     late. It is backfilled with the original timestamp, so no data is
 *     lost — only its arrival is deferred.
 *   - State is in-memory; a server restart forgets held values and
 *     last-accepted levels. First push after boot is always accepted.
 *     Best-effort by design — the end-of-day sweep remains the backstop.
 */

export interface HeldReading {
  viewers: number;
  /** The relay timestamp the held value belongs to. */
  timestamp: Date;
}

export type GuardVerdict =
  | { action: 'accept'; release?: HeldReading }
  | { action: 'defer' };

interface ChannelState {
  lastAccepted: number;
  lastAcceptedAt: number;
  held: HeldReading | null;
}

/** A plunge below this fraction of the fresh last-accepted level is suspect. */
const PLUNGE_RATIO = 0.5;
/** Only guard channels with a meaningful audience — tiny channels jitter. */
const MIN_GUARDED_LEVEL = 50;
/** last-accepted older than this is not "fresh" — no basis to distrust. */
const FRESHNESS_MS = 5 * 60_000;
/** Held values older than this are stale state (tracker gone) — discard. */
const HELD_TTL_MS = 10 * 60_000;

export class TikTokIngestGuard {
  private readonly state = new Map<string, ChannelState>();

  /**
   * Assess one incoming reading. Mutates internal state.
   * `key` should be the normalized channel identifier (lower, no @).
   */
  assess(key: string, viewers: number, timestamp: Date): GuardVerdict {
    const now = timestamp.getTime();
    const st = this.state.get(key);

    if (!st) {
      this.state.set(key, { lastAccepted: viewers, lastAcceptedAt: now, held: null });
      return { action: 'accept' };
    }

    // Expire a held value that never got its second opinion.
    if (st.held && now - st.held.timestamp.getTime() > HELD_TTL_MS) {
      st.held = null;
    }

    const fresh = now - st.lastAcceptedAt <= FRESHNESS_MS;
    const plunge =
      fresh && st.lastAccepted >= MIN_GUARDED_LEVEL && viewers < st.lastAccepted * PLUNGE_RATIO;

    if (st.held) {
      // Second opinion on a previously held plunge.
      if (viewers < st.lastAccepted * PLUNGE_RATIO) {
        // Confirmed real decline: release the held reading and accept.
        const release = st.held;
        st.held = null;
        st.lastAccepted = viewers;
        st.lastAcceptedAt = now;
        return { action: 'accept', release };
      }
      // Recovered — the held value was the artifact. Drop it silently.
      st.held = null;
      st.lastAccepted = viewers;
      st.lastAcceptedAt = now;
      return { action: 'accept' };
    }

    if (plunge) {
      st.held = { viewers, timestamp };
      return { action: 'defer' };
    }

    st.lastAccepted = viewers;
    st.lastAcceptedAt = now;
    return { action: 'accept' };
  }

  /** Test/ops hook. */
  size(): number {
    return this.state.size;
  }
}
