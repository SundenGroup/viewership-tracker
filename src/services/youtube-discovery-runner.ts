/**
 * Runs a tracker's YouTube Live-search pass in the background.
 *
 * The pass used to run inside the poll, every ten minutes, and made that
 * poll about twenty seconds slower. With a few dozen searches it takes a
 * couple of minutes, which no poll can wait for. So a poll only kicks a
 * pass off when one is due, and picks up what the last finished pass found.
 *
 * One pass per tracker at a time. A pass that fails leaves nothing behind
 * and the next one is tried when it is due again.
 */
import logger from '../utils/logger';
import type { YouTubeLiveCandidate } from './youtube-live-discovery';

export type DiscoverFn = (queries: string[], pagesPerQuery: number) => Promise<YouTubeLiveCandidate[]>;

export class DiscoveryRunner {
  private readonly lastStarted = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly found = new Map<string, YouTubeLiveCandidate[]>();

  constructor(private readonly discover: DiscoverFn) {}

  /**
   * Start a pass when one is due and none is running. Never waits for it.
   * Returns true when a pass was started.
   */
  kick(
    trackerId: string,
    label: string,
    queries: string[],
    pagesPerQuery: number,
    everyMs: number,
    now: number = Date.now(),
  ): boolean {
    if (queries.length === 0 || this.running.has(trackerId)) return false;
    if (now - (this.lastStarted.get(trackerId) ?? 0) < everyMs) return false;
    this.lastStarted.set(trackerId, now);
    this.running.add(trackerId);
    const started = Date.now();
    void this.discover(queries, pagesPerQuery)
      .then((candidates) => {
        this.found.set(trackerId, candidates);
        logger.info(
          `[YT:${label}] search pass: ${queries.length} searches found ${candidates.length} live stream(s) ` +
            `in ${Math.round((Date.now() - started) / 1000)}s`,
        );
      })
      .catch((err: unknown) => {
        logger.warn(`[YT:${label}] search pass failed`, { error: (err as Error).message });
      })
      .finally(() => {
        this.running.delete(trackerId);
      });
    return true;
  }

  /** What the last finished pass found, handed out once. Null when nothing is waiting. */
  take(trackerId: string): YouTubeLiveCandidate[] | null {
    const candidates = this.found.get(trackerId);
    if (!candidates) return null;
    this.found.delete(trackerId);
    return candidates;
  }

  isRunning(trackerId: string): boolean {
    return this.running.has(trackerId);
  }
}
