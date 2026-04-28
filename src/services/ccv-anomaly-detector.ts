/**
 * CCV anomaly detector — drops suspicious "cliff" samples from being
 * persisted to viewership_snapshots.
 *
 * Background: YouTube's scraping path can occasionally return a value ~95%
 * below a stream's recent CCV for one or two poll cycles before recovering.
 * Two known causes:
 *   1. YouTube briefly returns a tiny CCV for a still-live videoId (data
 *      anomaly upstream).
 *   2. The scraper falls back to a different live videoId on the same
 *      channel (a side-cam or rebroadcast with much lower audience) and
 *      records that videoId's CCV instead of the main broadcast's.
 *
 * Both produce the same artefact in the dashboard: a 1-10 minute "cliff"
 * dropping CCV from ~1500 to ~30, then recovering. This detector catches
 * those at write time so they never enter the historical record.
 *
 * Logic per (channel, stream) pair:
 *   • Keep the last accepted CCV + timestamp + reject count.
 *   • A new sample is "suspicious" if:
 *     - the previous CCV was ≥ MIN_PREV_CCV_FLOOR (100), AND
 *     - the new CCV is < SUSPICIOUS_DROP_RATIO (10%) of the previous, AND
 *     - the previous sample is within RECENT_WINDOW_MS (90 s) — i.e. the
 *       same active polling session, not a stale stat from yesterday.
 *   • A suspicious sample is rejected (skipped from insert) up to
 *     MAX_CONSECUTIVE_REJECTS (2) times. The third suspicious sample in
 *     a row is accepted — the drop is treated as real (raid left,
 *     broadcast ended mid-cycle, etc.) and we resume normal recording.
 *
 * State lives in-memory (singleton). After RESET_AFTER_MS (10 min) of
 * silence on a key, the entry is GC'd and the next sample starts fresh.
 *
 * Trade-off: a genuine audience cliff has a 60-90 second persistence
 * delay before showing up in the dashboard. Acceptable, given the
 * alternative is dirty data that has needed manual SQL patching twice
 * already (Day 1 and Day 2 PEC Finals 1).
 */

import logger from '../utils/logger';

const SUSPICIOUS_DROP_RATIO = 0.10;
const MIN_PREV_CCV_FLOOR = 100;
const RECENT_WINDOW_MS = 90_000;
const MAX_CONSECUTIVE_REJECTS = 2;
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
    // No streamId → no per-stream baseline, can't decide. Accept.
    if (!streamId) return false;
    const key = `${channelId}:${streamId}`;
    const last = this.state.get(key);
    const now = Date.now();

    // First sample, or stale state — accept and reset.
    if (!last || now - last.ts > RECENT_WINDOW_MS) {
      this.state.set(key, { ccv, ts: now, rejectCount: 0 });
      return false;
    }

    const isAnomaly = last.ccv >= MIN_PREV_CCV_FLOOR && ccv < last.ccv * SUSPICIOUS_DROP_RATIO;

    if (isAnomaly && last.rejectCount < MAX_CONSECUTIVE_REJECTS) {
      // Drop this sample. Keep the last accepted CCV as the baseline so
      // the next sample is judged against the previous *real* value.
      this.state.set(key, { ccv: last.ccv, ts: now, rejectCount: last.rejectCount + 1 });
      this.rejectionsTotal++;
      logger.debug('[CCV] Rejected suspicious cliff sample', {
        channelId,
        streamId,
        proposedCcv: ccv,
        baselineCcv: last.ccv,
        rejectCount: last.rejectCount + 1,
      });
      return true;
    }

    // Accept. If we got here on the 3rd consecutive low value, log it —
    // we're treating this as a real sustained drop now.
    if (isAnomaly && last.rejectCount >= MAX_CONSECUTIVE_REJECTS) {
      this.acceptanceAfterRetriesTotal++;
      logger.info('[CCV] Accepting sustained low CCV after retry budget exhausted', {
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
