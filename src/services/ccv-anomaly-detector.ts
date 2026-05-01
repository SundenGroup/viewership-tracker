/**
 * CCV anomaly detector — drops both suspicious "cliff" (sudden drop) and
 * "spike" (sudden surge) samples from being persisted to
 * viewership_snapshots.
 *
 * Background:
 *   • YouTube's scraping path can return a value ~95 % below a stream's
 *     recent CCV for one or two poll cycles before recovering. Two known
 *     causes: YouTube returns a tiny CCV for a still-live videoId, OR the
 *     scraper falls back to a different live videoId on the same channel
 *     (side-cam / rebroadcast) and records its tiny CCV instead.
 *   • Twitch's scraping path can occasionally report a single-poll value
 *     5×+ the surrounding curve (likely Twitch CDN burst-cache or mirror-
 *     player attribution glitch). Saw this on PUBG_BR 2026-04-18: 1730
 *     and 2033 reported between samples in the 350-380 range.
 *
 * Both artefacts show up in the dashboard as 1-10 minute fake cliffs or
 * spikes. This detector catches them at write time so they never enter
 * the historical record.
 *
 * Logic per (channel, stream) pair:
 *   • Keep the last accepted CCV + timestamp + reject count.
 *   • A new sample is "suspicious" if EITHER:
 *     - downward cliff:  prev ≥ MIN_PREV_CCV_FLOOR (100) AND
 *                        new < prev × SUSPICIOUS_DROP_RATIO (0.10), OR
 *     - upward spike:    prev ≥ MIN_PREV_CCV_FLOOR (100) AND
 *                        new > prev × SUSPICIOUS_SPIKE_RATIO (5.0)
 *     AND the previous sample is within RECENT_WINDOW_MS (90 s).
 *   • A suspicious sample is rejected (skipped from insert) up to
 *     MAX_CONSECUTIVE_REJECTS (2) times. The third suspicious sample in
 *     a row is accepted — the move is treated as real (raid joined/left,
 *     broadcast ended, host received) and we resume normal recording.
 *
 * State lives in-memory (singleton). After RESET_AFTER_MS (10 min) of
 * silence on a key, the entry is GC'd and the next sample starts fresh.
 *
 * Trade-off: a genuine audience cliff or surge has a 60-90 second
 * persistence delay before showing up in the dashboard. Acceptable,
 * given the alternative is dirty data needing manual SQL patches —
 * we've now patched cliffs across 7 broadcast days and one spike.
 */

import logger from '../utils/logger';

const SUSPICIOUS_DROP_RATIO = 0.10;   // new < prev × this → likely cliff
const SUSPICIOUS_SPIKE_RATIO = 5.0;   // new > prev × this → likely spike
const MIN_PREV_CCV_FLOOR = 100;
const RECENT_WINDOW_MS = 90_000;
// Bumped 2 → 10 after a real PEC Playoffs 2 Day 1 cliff that lasted 6 min
// (12 polls at 30 s cadence) slipped through and required a manual SQL
// backfill. 10 rejects ≈ 5 min of grace; longer cliffs would still slip,
// but those are extremely rare and a 5-min real-audience drop without an
// accompanying broadcast-end signal is even rarer.
const MAX_CONSECUTIVE_REJECTS = 10;
const RESET_AFTER_MS = 10 * 60_000;

interface SampleState {
  /** Last ACCEPTED ccv (rejected samples don't overwrite this). */
  ccv: number;
  /** When the last accepted (or rejected) sample arrived. */
  ts: number;
  /** Count of consecutive rejects since last accept. */
  rejectCount: number;
}

export class CcvAnomalyDetector {
  private state = new Map<string, SampleState>();
  private rejectionsTotal = 0;
  private acceptanceAfterRetriesTotal = 0;

  /**
   * Returns true if this sample should be dropped from the snapshot insert.
   * Mutates internal state in either case (so the next call has the right
   * baseline).
   */
  shouldReject(channelId: string, streamId: string | null | undefined, ccv: number): boolean {
    // Key by (channel, stream) when we have a streamId — that's the right
    // baseline for YouTube where the scraper can flip videoIds. For Twitch
    // and other platforms we key on channel only, since the artefact is a
    // bogus value on the same stream rather than a stream change.
    const key = streamId ? `${channelId}:${streamId}` : channelId;
    const last = this.state.get(key);
    const now = Date.now();

    // First sample, or stale state — accept and reset.
    if (!last || now - last.ts > RECENT_WINDOW_MS) {
      this.state.set(key, { ccv, ts: now, rejectCount: 0 });
      return false;
    }

    const meetsFloor = last.ccv >= MIN_PREV_CCV_FLOOR;
    const isCliff = meetsFloor && ccv < last.ccv * SUSPICIOUS_DROP_RATIO;
    const isSpike = meetsFloor && ccv > last.ccv * SUSPICIOUS_SPIKE_RATIO;
    const isAnomaly = isCliff || isSpike;

    if (isAnomaly && last.rejectCount < MAX_CONSECUTIVE_REJECTS) {
      // Drop this sample. Keep the last accepted CCV as the baseline so
      // the next sample is judged against the previous *real* value.
      this.state.set(key, { ccv: last.ccv, ts: now, rejectCount: last.rejectCount + 1 });
      this.rejectionsTotal++;
      logger.debug(`[CCV] Rejected suspicious ${isCliff ? 'cliff' : 'spike'} sample`, {
        channelId,
        streamId,
        proposedCcv: ccv,
        baselineCcv: last.ccv,
        rejectCount: last.rejectCount + 1,
      });
      return true;
    }

    // Accept. If we got here on the 3rd consecutive anomalous value, log
    // it — we're treating this as a real sustained move now (raid /
    // broadcast end / sudden host received).
    if (isAnomaly && last.rejectCount >= MAX_CONSECUTIVE_REJECTS) {
      this.acceptanceAfterRetriesTotal++;
      logger.info(`[CCV] Accepting sustained ${isCliff ? 'low' : 'high'} CCV after retry budget exhausted`, {
        channelId,
        streamId,
        ccv,
        baselineCcv: last.ccv,
      });
    }
    this.state.set(key, { ccv, ts: now, rejectCount: 0 });
    return false;
  }

  /**
   * GC stale entries. Called occasionally from the orchestrator so the map
   * doesn't grow unboundedly across days/series. Cheap iteration.
   */
  gc(): void {
    const now = Date.now();
    for (const [k, v] of this.state) {
      if (now - v.ts > RESET_AFTER_MS) this.state.delete(k);
    }
  }

  /** Diagnostics for /api/polling/status. */
  stats() {
    return {
      tracked: this.state.size,
      rejectionsTotal: this.rejectionsTotal,
      acceptanceAfterRetriesTotal: this.acceptanceAfterRetriesTotal,
    };
  }
}

// Singleton — the orchestrator accesses this directly so a single shared
// state covers all channels across the polling cycle.
export const ccvAnomalyDetector = new CcvAnomalyDetector();
