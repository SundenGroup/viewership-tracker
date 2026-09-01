import { assignMultiStreamSlots, type MultiStreamBindings } from '../../src/utils/multi-stream-binding';

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
