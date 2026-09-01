import { normalizeRelayViewers, detectBleedIdentifiers } from '../../src/utils/relay-values';

describe('normalizeRelayViewers', () => {
  it('accepts plain integers and rounds floats', () => {
    expect(normalizeRelayViewers(1200)).toBe(1200);
    expect(normalizeRelayViewers(1200.6)).toBe(1201);
  });
  it('accepts numeric strings, including thousands separators', () => {
    expect(normalizeRelayViewers('4 531')).toBe(4531);
    expect(normalizeRelayViewers('12,345')).toBe(12345);
  });
  it('rejects garbage that would previously have failed the whole INSERT', () => {
    expect(normalizeRelayViewers('N/A')).toBeNull();
    expect(normalizeRelayViewers(NaN)).toBeNull();
    expect(normalizeRelayViewers(Infinity)).toBeNull();
    expect(normalizeRelayViewers(undefined)).toBeNull();
    expect(normalizeRelayViewers(null)).toBeNull();
    expect(normalizeRelayViewers({} as unknown)).toBeNull();
  });
  it('rejects negatives and implausible ceilings', () => {
    expect(normalizeRelayViewers(-1)).toBeNull();
    expect(normalizeRelayViewers(500_001)).toBeNull();
    expect(normalizeRelayViewers(500_000)).toBe(500_000);
    expect(normalizeRelayViewers(0)).toBe(0);
  });
});

describe('detectBleedIdentifiers', () => {
  it('flags ≥3 channels sharing one identical value above 100', () => {
    const set = detectBleedIdentifiers([
      { identifier: 'A', viewers: 4_812 },
      { identifier: 'b', viewers: 4_812 },
      { identifier: 'C', viewers: 4_812 },
      { identifier: 'd', viewers: 4_813 },
    ]);
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
  });
  it('ignores small identical values and pairs', () => {
    expect(detectBleedIdentifiers([
      { identifier: 'a', viewers: 50 }, { identifier: 'b', viewers: 50 }, { identifier: 'c', viewers: 50 },
    ]).size).toBe(0);
    expect(detectBleedIdentifiers([
      { identifier: 'a', viewers: 900 }, { identifier: 'b', viewers: 900 },
    ]).size).toBe(0);
  });
  it('skips null (invalid) values', () => {
    expect(detectBleedIdentifiers([
      { identifier: 'a', viewers: null }, { identifier: 'b', viewers: null }, { identifier: 'c', viewers: null },
    ]).size).toBe(0);
  });
});
