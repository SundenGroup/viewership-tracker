import { parseTikTokLivePage } from '../../src/utils/tiktok-live-page';

const pad = 'x'.repeat(1200);
const livePage = `<html>${pad}"liveRoomUserInfo":{"user":{"nickname":"GeoGuessr","signature":"World Cup\\nDay 3"},"liveRoom":{"status":2,"liveRoomStats":{"userCount":942,"likeCount":5}}}</html>`;
const offlinePage = `<html>${pad}"liveRoom":{"status":4,"liveRoomStats":{"userCount":0}}</html>`;
const challengePage = `<html>${pad}<title>Verify to continue</title></html>`;

describe('parseTikTokLivePage', () => {
  it('reads the live viewer count and names', () => {
    const p = parseTikTokLivePage(livePage);
    expect(p).toEqual({ unusable: false, isLive: true, viewers: 942, title: 'World Cup Day 3', displayName: 'GeoGuessr' });
  });
  it('reports offline when the room status is not 2', () => {
    const p = parseTikTokLivePage(offlinePage);
    expect(p.unusable).toBe(false);
    expect(p.isLive).toBe(false);
    expect(p.viewers).toBe(0);
  });
  it('flags a page without room status as unusable, never as offline', () => {
    expect(parseTikTokLivePage(challengePage).unusable).toBe(true);
    expect(parseTikTokLivePage('').unusable).toBe(true);
    expect(parseTikTokLivePage(null).unusable).toBe(true);
  });
});
