import { gateMultiStreamIds } from '../../src/utils/multi-stream-ownership';

const CH = 'UC_geoguessr';

describe('gateMultiStreamIds', () => {
  it('keeps owned ids, rejects foreign and unreturned ones', () => {
    const verified = new Map<string, number>();
    const owners = new Map([['own1', CH], ['chess', 'UC_chess']]);
    const r = gateMultiStreamIds(CH, ['own1', 'chess', 'ghost'], owners, verified, 1000);
    expect(r.kept).toEqual(['own1']);
    expect(r.rejected).toEqual([
      { videoId: 'chess', owner: 'UC_chess' },
      { videoId: 'ghost', owner: '<not-returned>' },
    ]);
    expect(verified.get('own1')).toBe(1000);
  });

  it('fails closed when the owner lookup is unavailable: only previously verified ids survive', () => {
    const verified = new Map<string, number>([['own1', 1000]]);
    const r = gateMultiStreamIds(CH, ['own1', 'nurburgring', 'chess'], null, verified, 5000);
    expect(r.kept).toEqual(['own1']);
    expect(r.unverified).toEqual(['nurburgring', 'chess']);
    expect(r.rejected).toEqual([]);
  });

  it('forgets a verification after the TTL', () => {
    const verified = new Map<string, number>([['own1', 0]]);
    const r = gateMultiStreamIds(CH, ['own1'], null, verified, 31 * 60_000);
    expect(r.kept).toEqual([]);
    expect(r.unverified).toEqual(['own1']);
    expect(verified.has('own1')).toBe(false);
  });
});
