/**
 * SOOP discovery mappers — pure functions over the sch.sooplive payloads.
 *
 * The endpoint shapes were captured live (2026-08-04 probe + archived
 * healthy-day responses); these fixtures pin the mapping: KST timestamps
 * become real ISO instants (+09:00), viewer counts survive string typing,
 * broad_no becomes the streamId sessions key off.
 */
import { mapSoopSearchItem, mapSoopCategoryItem, soopKstToIso } from '../../src/adapters/soop';

describe('soopKstToIso', () => {
  it('parses naive KST as +09:00', () => {
    expect(soopKstToIso('2026-08-05 21:30:00')).toBe('2026-08-05T12:30:00.000Z');
  });
  it('accepts minute precision', () => {
    expect(soopKstToIso('2026-08-05 21:30')).toBe('2026-08-05T12:30:00.000Z');
  });
  it('rejects garbage', () => {
    expect(soopKstToIso('not a date')).toBeNull();
    expect(soopKstToIso(null)).toBeNull();
  });
});

describe('mapSoopSearchItem', () => {
  it('maps a liveSearch row', () => {
    const s = mapSoopSearchItem({
      user_id: 'pubg',
      user_nick: 'PUBG KR',
      broad_no: 295042943,
      broad_title: 'PGS7 그룹 스테이지',
      total_view_cnt: '4210',
      broad_cate_no: '00040066',
      broad_cate_name: '배틀그라운드',
      broad_start: '2026-08-05 13:30:00',
    });
    expect(s).toMatchObject({
      channelIdentifier: 'pubg',
      displayName: 'PUBG KR',
      concurrentViewers: 4210,
      language: 'ko',
      title: 'PGS7 그룹 스테이지',
      gameName: '배틀그라운드',
      streamId: '295042943',
    });
    expect(s!.startedAt).toBe('2026-08-05T04:30:00.000Z');
  });
  it('drops rows without a user id', () => {
    expect(mapSoopSearchItem({ broad_title: 'x' })).toBeNull();
  });
  it('prefers current over total viewers and survives bad numbers', () => {
    expect(mapSoopSearchItem({ user_id: 'a', current_view_cnt: '17', total_view_cnt: '99' })!.concurrentViewers).toBe(17);
    expect(mapSoopSearchItem({ user_id: 'a', total_view_cnt: 'NaN?' })!.concurrentViewers).toBe(0);
  });
});

describe('mapSoopCategoryItem', () => {
  it('maps a category listing row with string view_cnt', () => {
    const s = mapSoopCategoryItem({
      user_id: 'vf3366',
      user_nick: '배그하는사람',
      broad_no: '295099001',
      broad_title: '랭크 올림',
      view_cnt: '312',
      broad_start: '2026-08-05 18:04',
    });
    expect(s).toMatchObject({
      channelIdentifier: 'vf3366',
      concurrentViewers: 312,
      streamId: '295099001',
      gameName: null,
    });
    expect(s!.startedAt).toBe('2026-08-05T09:04:00.000Z');
  });
});
