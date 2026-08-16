/**
 * Live-edge trimming — replays the TikTok-lag dip: the newest minute
 * exists without its TikTok rows and must be withheld until complete.
 */
import { trimIncompleteEdge } from '../../src/utils/timeline';

const MIN = 60_000;

function series(counts: number[], nowMs: number): Array<{ bucket: Date; channel_count: number }> {
  // counts[i] is the aggregate channel count of the bucket i minutes ago,
  // oldest first.
  return counts.map((c, i) => ({
    bucket: new Date(nowMs - (counts.length - i) * MIN),
    channel_count: c,
  }));
}

describe('trimIncompleteEdge', () => {
  const now = Date.UTC(2026, 7, 16, 14, 0);

  it('withholds the newest minute while TikTok has not landed', () => {
    const rows = series([50, 50, 51, 50, 50, 50, 41], now); // last minute lost 9 tiktok channels
    const out = trimIncompleteEdge(rows, 60, now);
    expect(out).toHaveLength(6);
    expect(out[out.length - 1]!.channel_count).toBe(50);
  });

  it('serves the newest minute once coverage matches the baseline', () => {
    const rows = series([50, 50, 51, 50, 50, 50, 49], now);
    expect(trimIncompleteEdge(rows, 60, now)).toHaveLength(7);
  });

  it('a shrinking audience is not mistaken for lag (count is the signal)', () => {
    // Viewers collapsing but the same channels keep reporting.
    const rows = series([50, 50, 50, 50, 50, 50, 50], now);
    expect(trimIncompleteEdge(rows, 60, now)).toHaveLength(7);
  });

  it('history is never trimmed — old buckets are settled', () => {
    const old = now - 60 * MIN;
    const rows = series([50, 50, 50, 50, 50, 50, 20], old);
    expect(trimIncompleteEdge(rows, 60, now)).toHaveLength(7);
  });

  it('can withhold up to three still-filling minutes', () => {
    const rows = series([50, 50, 50, 50, 50, 50, 44, 43, 12], now);
    const out = trimIncompleteEdge(rows, 60, now);
    expect(out.map((r) => r.channel_count)).toEqual([50, 50, 50, 50, 50, 50]);
  });
});
