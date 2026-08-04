/**
 * TikTok webcast feed parser — fixture mirrors the live schema captured
 * from webcast.tiktok.com/webcast/feed/ (channel_id=1111006, 2026-08).
 */
import { parseFeedRooms } from '../../src/utils/tiktok-feed';

const room = (over: Record<string, unknown>) => ({
  type: 1,
  rid: 'r',
  data: {
    id: 7670285073522576148,
    id_str: '7670285073522576148',
    status: 2,
    user_count: 506,
    title: 'PUBG solos are still IT',
    language: 'en',
    owner: { display_id: 'stonemountain', nickname: 'StoneMountain64' },
    hashtag: { title: 'Gaming' },
    ...over,
  },
});

describe('parseFeedRooms', () => {
  it('maps the real feed shape to rooms', () => {
    const rooms = parseFeedRooms({
      status_code: 0,
      extra: { has_more: true },
      data: [
        room({}),
        room({
          id_str: '111',
          user_count: 339,
          title: 'CONQUEROR LEAGUE 2vs4',
          owner: { display_id: 'yakupyusuftwins', nickname: 'YY Twins' },
        }),
      ],
    });
    expect(rooms).toHaveLength(2);
    expect(rooms[0]).toEqual({
      username: 'stonemountain',
      nickname: 'StoneMountain64',
      roomId: '7670285073522576148',
      title: 'PUBG solos are still IT',
      viewerCount: 506,
      language: 'en',
    });
    expect(rooms[1].viewerCount).toBe(339);
  });

  it('rejects non-success payloads', () => {
    expect(parseFeedRooms({ status_code: 10011, data: { message: 'Request params error' } })).toEqual([]);
    expect(parseFeedRooms(null)).toEqual([]);
    expect(parseFeedRooms('nonsense')).toEqual([]);
  });

  it('skips rooms without an owner display_id, keeps the rest', () => {
    const rooms = parseFeedRooms({
      status_code: 0,
      data: [room({ owner: {} }), room({}), { type: 1 }, null],
    });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].username).toBe('stonemountain');
  });

  it('coerces missing counts and empty titles safely', () => {
    const rooms = parseFeedRooms({
      status_code: 0,
      data: [room({ user_count: undefined, title: '', id_str: undefined, id: 42 })],
    });
    expect(rooms[0]).toMatchObject({ viewerCount: 0, title: null, roomId: '42' });
  });
});
