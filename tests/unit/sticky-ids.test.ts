import { mergeStickyIds, dropStickyId, type StickyHistory } from '../../src/utils/sticky-ids';

const TTL = 10 * 60_000;

describe('mergeStickyIds', () => {
  it('returns fresh ids unchanged when history is empty', () => {
    const h: StickyHistory = new Map();
    const r = mergeStickyIds(h, ['a', 'b'], 1_000_000, TTL);
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.restored).toEqual([]);
    expect(h.get('a')).toBe(1_000_000);
  });

  it('restores an id omitted from one listing while within TTL (the 13:19 incident)', () => {
    const h: StickyHistory = new Map();
    const t0 = 1_000_000;
    mergeStickyIds(h, ['main', 'map'], t0, TTL);
    // search.list omits "main" 5 minutes later — must still be a candidate
    const r = mergeStickyIds(h, ['map'], t0 + 5 * 60_000, TTL);
    expect(r.ids).toEqual(['map', 'main']);
    expect(r.restored).toEqual(['main']);
  });

  it('forgets an id once it has been absent longer than TTL', () => {
    const h: StickyHistory = new Map();
    const t0 = 1_000_000;
    mergeStickyIds(h, ['main', 'map'], t0, TTL);
    const r = mergeStickyIds(h, ['map'], t0 + TTL + 1, TTL);
    expect(r.ids).toEqual(['map']);
    expect(h.has('main')).toBe(false);
  });

  it('keeps fresh ids first, in listing order', () => {
    const h: StickyHistory = new Map();
    mergeStickyIds(h, ['x'], 0, TTL);
    const r = mergeStickyIds(h, ['b', 'a'], 1, TTL);
    expect(r.ids).toEqual(['b', 'a', 'x']);
  });

  it('dropStickyId removes an id immediately', () => {
    const h: StickyHistory = new Map();
    mergeStickyIds(h, ['ended', 'live'], 0, TTL);
    dropStickyId(h, 'ended');
    const r = mergeStickyIds(h, ['live'], 1, TTL);
    expect(r.ids).toEqual(['live']);
  });
});
