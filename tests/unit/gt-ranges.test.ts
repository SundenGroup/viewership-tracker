import {
  splitRangeByUtcDays,
  mergeBucketParts,
  nextPollBoundary,
  pollBoundaryAtOrBefore,
  classifyTrend,
  clampInt,
  servableFromBucketRollup,
  bucketFloor,
} from '../../src/utils/gt-ranges';

describe('splitRangeByUtcDays', () => {
  it('uses day stats for the full days inside the window and raw for both edges', () => {
    const from = new Date('2026-08-26T06:30:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-09-01');
    expect(split.fullDays).toEqual({ fromDay: '2026-08-27', toDay: '2026-09-02' });
    expect(split.rawEdges).toEqual([
      { from, to: new Date('2026-08-27T00:00:00Z') },
      { from: new Date('2026-09-02T00:00:00Z'), to },
    ]);
  });

  it('keeps unrolled days raw (yesterday before the nightly job ran)', () => {
    const from = new Date('2026-08-26T06:30:00Z');
    const to = new Date('2026-09-02T02:00:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-08-31');
    expect(split.fullDays).toEqual({ fromDay: '2026-08-27', toDay: '2026-09-01' });
    expect(split.rawEdges[1]).toEqual({ from: new Date('2026-09-01T00:00:00Z'), to });
  });

  it('falls back to raw when no full rolled day fits (24h window)', () => {
    const from = new Date('2026-09-01T06:30:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-09-01');
    expect(split.fullDays).toBeNull();
    expect(split.rawEdges).toEqual([{ from, to }]);
  });

  it('has no leading edge when from is exactly midnight', () => {
    const from = new Date('2026-08-27T00:00:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-09-01');
    expect(split.fullDays).toEqual({ fromDay: '2026-08-27', toDay: '2026-09-02' });
    expect(split.rawEdges).toEqual([{ from: new Date('2026-09-02T00:00:00Z'), to }]);
  });

  it('is all raw when the rollup table is empty', () => {
    const from = new Date('2026-08-26T06:30:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    expect(splitRangeByUtcDays(from, to, null)).toEqual({ fullDays: null, rawEdges: [{ from, to }] });
  });
});

describe('mergeBucketParts', () => {
  it('averages per-minute totals across rolled and raw parts of one bucket', () => {
    const ts = Date.parse('2026-09-02T06:00:00Z');
    const rows = mergeBucketParts([
      { ts, ccv_sum: 1000 * 50, stream_sum: 10 * 50, minutes: 50, ccv_max: 1100 },
      { ts, ccv_sum: 1300 * 10, stream_sum: 13 * 10, minutes: 10, ccv_max: 1400 },
      { ts: ts + 3_600_000, ccv_sum: 500 * 60, stream_sum: 5 * 60, minutes: 60, ccv_max: 620 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ts: new Date(ts), total_ccv: 1050, stream_count: 11, peak_ccv: 1400 });
    expect(rows[1]).toEqual({ ts: new Date(ts + 3_600_000), total_ccv: 500, stream_count: 5, peak_ccv: 620 });
  });

  it('reports the highest single minute as the peak, not the bucket average', () => {
    // Ten minutes around 7.0M with one minute at 7.17M: the average is not the peak.
    const ts = Date.parse('2026-11-18T16:10:00Z');
    const [row] = mergeBucketParts([
      { ts, ccv_sum: 70_600_000, stream_sum: 18_000, minutes: 10, ccv_max: 7_169_676 },
    ]);
    expect(row.total_ccv).toBe(7_060_000);
    expect(row.peak_ccv).toBe(7_169_676);
  });

  it('returns zero for buckets without minutes', () => {
    const rows = mergeBucketParts([{ ts: 0, ccv_sum: 0, stream_sum: 0, minutes: 0, ccv_max: 0 }]);
    expect(rows[0]).toEqual({ ts: new Date(0), total_ccv: 0, stream_count: 0, peak_ccv: 0 });
  });
});

describe('poll boundaries', () => {
  const MIN = 60_000;
  it('the next poll is the next whole minute, whatever second the app started at', () => {
    expect(new Date(nextPollBoundary(Date.parse('2026-11-18T15:30:42.000Z'), MIN)).toISOString()).toBe(
      '2026-11-18T15:31:00.000Z',
    );
    expect(new Date(nextPollBoundary(Date.parse('2026-11-18T13:39:02.500Z'), MIN)).toISOString()).toBe(
      '2026-11-18T13:40:00.000Z',
    );
  });
  it('is strictly after now: exactly on a boundary means the following one', () => {
    const onTheMinute = Date.parse('2026-11-18T15:31:00.000Z');
    expect(nextPollBoundary(onTheMinute, MIN)).toBe(onTheMinute + MIN);
  });
  it('a poll started by hand is stamped with the minute it started in', () => {
    expect(new Date(pollBoundaryAtOrBefore(Date.parse('2026-11-18T16:03:04.000Z'), MIN)).toISOString()).toBe(
      '2026-11-18T16:03:00.000Z',
    );
  });
  it('follows the interval for trackers that poll slower than a minute', () => {
    expect(new Date(nextPollBoundary(Date.parse('2026-11-18T16:03:04.000Z'), 5 * MIN)).toISOString()).toBe(
      '2026-11-18T16:05:00.000Z',
    );
  });
});

describe('classifyTrend', () => {
  it('flags a riser only against a meaningful baseline', () => {
    expect(classifyTrend(1500, 500, true)).toEqual({ cls: 'riser', ratio: 3 });
    expect(classifyTrend(600, 500, true)).toBeNull(); // +20% is steady
    expect(classifyTrend(900, 40, true)).toBeNull(); // baseline below the floor
  });
  it('separates new from returning channels', () => {
    expect(classifyTrend(15000, null, false)).toEqual({ cls: 'new', ratio: null });
    expect(classifyTrend(3300, null, true)).toEqual({ cls: 'returning', ratio: null });
    expect(classifyTrend(20, null, false)).toBeNull(); // below the peak floor
  });
});

describe('clampInt', () => {
  it('falls back to the default for NaN instead of leaking it', () => {
    expect(clampInt('abc', 1, 200, 50)).toBe(50);
    expect(clampInt(undefined, 1, 200, 50)).toBe(50);
    expect(clampInt('500', 1, 200, 50)).toBe(200);
    expect(clampInt('0', 1, 200, 50)).toBe(1);
    expect(clampInt('12.6', 1, 200, 50)).toBe(13);
  });
});

describe('bucket helpers', () => {
  it('serves multiples of 10 minutes from the rollup and nothing smaller', () => {
    expect(servableFromBucketRollup(60)).toBe(false);
    expect(servableFromBucketRollup(300)).toBe(false);
    expect(servableFromBucketRollup(600)).toBe(true);
    expect(servableFromBucketRollup(1800)).toBe(true);
    expect(servableFromBucketRollup(3600)).toBe(true);
  });
  it('floors to epoch-aligned 10-minute buckets', () => {
    expect(bucketFloor(new Date('2026-09-02T06:37:59Z')).toISOString()).toBe('2026-09-02T06:30:00.000Z');
  });
});

describe('snapLongRangeStart', () => {
  const { snapLongRangeStart } = jest.requireActual('../../src/utils/gt-ranges');
  it('snaps a 7-day window to the UTC midnight of its first day', () => {
    const to = new Date('2026-09-02T06:30:00Z');
    const from = new Date('2026-08-26T06:30:00Z');
    expect(snapLongRangeStart(from, to).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });
  it('leaves shorter windows exact', () => {
    const to = new Date('2026-09-02T06:30:00Z');
    const from = new Date('2026-09-01T06:30:00Z');
    expect(snapLongRangeStart(from, to)).toEqual(from);
  });
});

describe('splitRangeByUtcDays with a fresh intraday rollup', () => {
  it('reads today from day stats and drops the trailing raw edge', () => {
    const from = new Date('2026-08-26T00:00:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-09-02', true);
    expect(split.fullDays).toEqual({ fromDay: '2026-08-26', toDay: '2026-09-03' });
    expect(split.rawEdges).toEqual([]);
  });
  it('keeps the raw edge when the rollup is stale', () => {
    const from = new Date('2026-08-26T00:00:00Z');
    const to = new Date('2026-09-02T06:30:00Z');
    const split = splitRangeByUtcDays(from, to, '2026-09-02', false);
    expect(split.fullDays).toEqual({ fromDay: '2026-08-26', toDay: '2026-09-02' });
    expect(split.rawEdges).toEqual([{ from: new Date('2026-09-02T00:00:00Z'), to }]);
  });
});
