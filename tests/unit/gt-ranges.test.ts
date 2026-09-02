import {
  splitRangeByUtcDays,
  mergeBucketParts,
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
      { ts, ccv_sum: 1000 * 50, stream_sum: 10 * 50, minutes: 50 },
      { ts, ccv_sum: 1300 * 10, stream_sum: 13 * 10, minutes: 10 },
      { ts: ts + 3_600_000, ccv_sum: 500 * 60, stream_sum: 5 * 60, minutes: 60 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ts: new Date(ts), total_ccv: 1050, stream_count: 11 });
    expect(rows[1]).toEqual({ ts: new Date(ts + 3_600_000), total_ccv: 500, stream_count: 5 });
  });

  it('returns zero for buckets without minutes', () => {
    const rows = mergeBucketParts([{ ts: 0, ccv_sum: 0, stream_sum: 0, minutes: 0 }]);
    expect(rows[0]).toEqual({ ts: new Date(0), total_ccv: 0, stream_count: 0 });
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
