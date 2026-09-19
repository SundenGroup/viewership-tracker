import { assignMultiStreamSlots, reattributeLoneUnverified, type MultiStreamBindings, sideStreamMarker, labelMatchesMarker } from '../../src/utils/multi-stream-binding';

const TTL = 15 * 60_000;
const fresh = (): MultiStreamBindings => ({ parent: { videoId: null, seenAt: null }, children: new Map() });

describe('assignMultiStreamSlots', () => {
  it('first sighting: biggest stream takes the parent, the rest get new children', () => {
    const r = assignMultiStreamSlots(
      [{ videoId: 'map', viewers: 300 }, { videoId: 'main', viewers: 3000 }],
      fresh(), 1_000, TTL,
    );
    expect(r.parentVideoId).toBe('main');
    expect(r.childAssignments.get(2)).toBe('map');
    expect(r.newChildIndexes).toEqual([2]);
    expect(r.changed).toBe(true);
  });

  it('keeps bindings when streams swap viewer rank (no row swap)', () => {
    let b = fresh();
    b = assignMultiStreamSlots([{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }], b, 0, TTL).bindings;
    const r = assignMultiStreamSlots([{ videoId: 'main', viewers: 200 }, { videoId: 'map', viewers: 900 }], b, 60_000, TTL);
    expect(r.parentVideoId).toBe('main');
    expect(r.childAssignments.get(2)).toBe('map');
    expect(r.changed).toBe(false);
  });

  it('leaves the parent EMPTY when the main stream is missing (the 13:19 incident)', () => {
    let b = fresh();
    b = assignMultiStreamSlots([{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }], b, 0, TTL).bindings;
    // search omits "main"; only the map is listed
    const r = assignMultiStreamSlots([{ videoId: 'map', viewers: 330 }], b, 5 * 60_000, TTL);
    expect(r.parentVideoId).toBeNull();          // NOT the map
    expect(r.childAssignments.get(2)).toBe('map'); // map stays on its child
    expect(r.newChildIndexes).toEqual([]);
  });

  it('leaves a child EMPTY when its stream is missing (the 12:16 incident)', () => {
    let b = fresh();
    b = assignMultiStreamSlots([{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }], b, 0, TTL).bindings;
    const r = assignMultiStreamSlots([{ videoId: 'main', viewers: 3100 }], b, 5 * 60_000, TTL);
    expect(r.parentVideoId).toBe('main');
    expect(r.childAssignments.size).toBe(0);
  });

  it('releases a slot once its stream has been absent longer than TTL', () => {
    let b = fresh();
    b = assignMultiStreamSlots([{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }], b, 0, TTL).bindings;
    // main gone for > TTL; a new broadcast "main2" appears
    const r = assignMultiStreamSlots([{ videoId: 'map', viewers: 300 }, { videoId: 'main2', viewers: 2500 }], b, TTL + 1_000, TTL);
    expect(r.parentVideoId).toBe('main2');
    expect(r.childAssignments.get(2)).toBe('map');
  });

  it('a third simultaneous stream gets a new child index without disturbing the others', () => {
    let b = fresh();
    b = assignMultiStreamSlots([{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }], b, 0, TTL).bindings;
    const r = assignMultiStreamSlots(
      [{ videoId: 'main', viewers: 3000 }, { videoId: 'map', viewers: 300 }, { videoId: 'hindi', viewers: 800 }],
      b, 30_000, TTL,
    );
    expect(r.parentVideoId).toBe('main');
    expect(r.childAssignments.get(2)).toBe('map');
    expect(r.childAssignments.get(3)).toBe('hindi');
    expect(r.newChildIndexes).toEqual([3]);
  });
});

describe('side streams never take the parent row (PAS2 Finals 1 Day 1, 2026-09-18)', () => {
  const NOW2 = 1_700_000_000_000;
  const TTL2 = 15 * 60_000;
  const fresh = () => ({ parent: { videoId: null, seenAt: null }, children: new Map([[2, { videoId: null, seenAt: null }]]) });
  const labels = new Map([[2, 'PUBG Esports Map']]);
  it('the map stream leads at the first poll (25 against 14) and still goes to the Map row', () => {
    const a = assignMultiStreamSlots(
      [
        { videoId: 'gFtVm3l2mIs', viewers: 25, title: '[MAP] PUBG Americas Series 2: Finals 1 - Day 1' },
        { videoId: 'lp1hkf_GuRU', viewers: 14, title: 'PUBG Americas Series 2: Finals 1 - Day 1' },
      ],
      fresh(), NOW2, TTL2, labels,
    );
    expect(a.parentVideoId).toBe('lp1hkf_GuRU');
    expect(a.childAssignments.get(2)).toBe('gFtVm3l2mIs');
    expect(a.newChildIndexes).toEqual([]);
  });
  it('a map stream that is live alone waits in its own row and leaves the parent free for the main broadcast', () => {
    const first = assignMultiStreamSlots([{ videoId: 'map1', viewers: 30, title: '[MAP] Finals' }], fresh(), NOW2, TTL2, labels);
    expect(first.parentVideoId).toBeNull();
    expect(first.childAssignments.get(2)).toBe('map1');
    const next = assignMultiStreamSlots(
      [{ videoId: 'map1', viewers: 40, title: '[MAP] Finals' }, { videoId: 'main1', viewers: 10, title: 'Finals' }],
      first.bindings, NOW2 + 60_000, TTL2, labels,
    );
    expect(next.parentVideoId).toBe('main1');
    expect(next.childAssignments.get(2)).toBe('map1');
  });
  it('a lettered side stream finds the child named after it, not the first free one', () => {
    const bindings = { parent: { videoId: null, seenAt: null }, children: new Map([[2, { videoId: null, seenAt: null }], [3, { videoId: null, seenAt: null }]]) };
    const a = assignMultiStreamSlots(
      [
        { videoId: 'main', viewers: 900, title: 'GeoGuessr World Championship' },
        { videoId: 'bbb', viewers: 300, title: 'GeoGuessr World Championship | B-Stream' },
        { videoId: 'ccc', viewers: 100, title: 'GeoGuessr World Championship | C-Stream' },
      ],
      bindings, NOW2, TTL2, new Map([[2, 'GeoGuessr - C-Stream'], [3, 'GeoGuessr - B-Stream (Stream 3)']]),
    );
    expect(a.parentVideoId).toBe('main');
    expect(a.childAssignments.get(3)).toBe('bbb');
    expect(a.childAssignments.get(2)).toBe('ccc');
  });
  it('without titles nothing changes: biggest stream takes the parent', () => {
    const a = assignMultiStreamSlots([{ videoId: 'x', viewers: 5 }, { videoId: 'y', viewers: 50 }], fresh(), NOW2, TTL2);
    expect(a.parentVideoId).toBe('y');
    expect(a.childAssignments.get(2)).toBe('x');
  });
  it('markers are narrow', () => {
    expect(sideStreamMarker('[MAP] PUBG Americas Series 2: Finals 1 - Day 1')).toBe('map');
    expect(sideStreamMarker('MAP | PUBG EMEA Championship')).toBe('map');
    expect(sideStreamMarker('PUBG Esports: new map reveal')).toBeNull();
    expect(sideStreamMarker('Mapping the meta with the casters')).toBeNull();
    expect(sideStreamMarker('World Championship - B Stream')).toBe('b-stream');
    expect(sideStreamMarker('PUBG Americas Series 2: Finals 1 - Day 1')).toBeNull();
    expect(labelMatchesMarker('PUBG Esports Map', 'map')).toBe(true);
    expect(labelMatchesMarker('PUBGEsports (Stream 3)', 'map')).toBe(false);
    expect(labelMatchesMarker('GeoGuessr - C-Stream', 'c-stream')).toBe(true);
    expect(labelMatchesMarker('GeoGuessr - C-Stream', 'b-stream')).toBe(false);
  });
});

describe('reattributeLoneUnverified', () => {
  const bound = (): MultiStreamBindings => ({
    parent: { videoId: 'MAIN', seenAt: 1_000_000 },
    children: new Map([[2, { videoId: 'MAP', seenAt: 1_000_000 }]]),
  });

  it('an ownership-verified id is left alone', () => {
    expect(reattributeLoneUnverified('NEW', true, bound(), 1_000_000 + 30_000, TTL)).toBe('NEW');
  });

  it('an id bound to a slot is left alone', () => {
    expect(reattributeLoneUnverified('MAP', undefined, bound(), 1_000_000 + 30_000, TTL)).toBe('MAP');
  });

  it('an unbound, unverified id while the main stream was live moments ago is the main stream (the 02:29 incident)', () => {
    expect(reattributeLoneUnverified('nfhDuOHMp0A', undefined, bound(), 1_000_000 + 30_000, TTL)).toBe('MAIN');
  });

  it('once the main stream has been gone longer than the TTL the id stands', () => {
    expect(reattributeLoneUnverified('NEW', undefined, bound(), 1_000_000 + TTL + 1, TTL)).toBe('NEW');
  });

  it('with no parent binding the id stands', () => {
    expect(reattributeLoneUnverified('NEW', undefined, fresh(), 5, TTL)).toBe('NEW');
  });
});
