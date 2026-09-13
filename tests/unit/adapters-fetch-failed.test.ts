/**
 * A failed fetch is unknown, never a zero.
 *
 * 2026-09-13 01:02-01:10 UTC: the server lost DNS for eight minutes and
 * every outbound request timed out. Kick, Steam and the YouTube multi-stream
 * child slot wrote zeros for those minutes (an audience "collapse" that never
 * happened); YouTube and Twitch already wrote nothing. These pin the
 * fetchFailed contract for the three that were wrong.
 */
import { KickAdapter } from '../../src/adapters/kick';
import { SteamAdapter } from '../../src/adapters/steam';
import { YouTubeAdapter } from '../../src/adapters/youtube';

type Mutable = Record<string, unknown>;

describe('Kick adapter: failed fetches are fetchFailed, not offline', () => {
  it('marks every channel fetchFailed when the circuit breaker is open', async () => {
    const a = new KickAdapter() as unknown as Mutable;
    a.circuitOpen = true;
    a.circuitOpenedAt = Date.now();
    const snaps = await (a as unknown as KickAdapter).getViewerCounts(['pubgesports', 'danitw']);
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.fetchFailed === true && s.isLive === false)).toBe(true);
  });

  it('marks the batch fetchFailed when the channels request fails', async () => {
    const a = new KickAdapter() as unknown as Mutable;
    a.getAccessToken = jest.fn().mockResolvedValue('tok');
    a.requestWithRetry = jest.fn().mockResolvedValue(null);
    const snaps = await (a as unknown as KickAdapter).getViewerCounts(['pubgesports', 'danitw']);
    expect(snaps.map((s) => s.channelIdentifier)).toEqual(['pubgesports', 'danitw']);
    expect(snaps.every((s) => s.fetchFailed === true)).toBe(true);
  });
});

describe('Steam adapter: offline answers stay zeros, failed fetches are fetchFailed', () => {
  function adapter(mpd: 'ready' | 'not_ready' | 'throw') {
    const a = new SteamAdapter() as unknown as Mutable;
    a.resolveToSteam64 = jest.fn(async (id: string) => id);
    a.batchFetchDisplayNames = jest.fn(async () => undefined);
    a.scraper = {
      get: jest.fn(async (url: string) => {
        if (mpd === 'throw') throw new Error('timeout of 8000ms exceeded');
        if (url.includes('getbroadcastmpd')) return { data: { success: mpd, num_viewers: mpd === 'ready' ? 519 : undefined } };
        throw new Error('timeout of 8000ms exceeded');
      }),
    };
    a.client = { get: jest.fn(async () => { throw new Error('timeout of 8000ms exceeded'); }) };
    return a as unknown as SteamAdapter;
  }

  it('live answer', async () => {
    const [s] = await adapter('ready').getViewerCounts(['76561199624755604']);
    expect(s.isLive).toBe(true);
    expect(s.concurrentViewers).toBe(519);
    expect(s.fetchFailed).toBeUndefined();
  });

  it('"not broadcasting" is a real zero', async () => {
    const [s] = await adapter('not_ready').getViewerCounts(['76561199624755604']);
    expect(s.isLive).toBe(false);
    expect(s.concurrentViewers).toBe(0);
    expect(s.fetchFailed).toBeUndefined();
  });

  it('every strategy failing is fetchFailed', async () => {
    const [s] = await adapter('throw').getViewerCounts(['76561199624755604']);
    expect(s.isLive).toBe(false);
    expect(s.fetchFailed).toBe(true);
  });
});

describe('YouTube adapter: a multi-stream slot row is never polled into a zero', () => {
  it('returns a fetchFailed placeholder for ":stream-N" identifiers without touching the network', async () => {
    const a = new YouTubeAdapter() as unknown as Mutable;
    a.resolveIdentifiers = jest.fn(async () => new Map<string, string>());
    a.scrapeMultipleLiveData = jest.fn(async () => new Map());
    a.getVideoDetails = jest.fn(async () => []);
    const snaps = await (a as unknown as YouTubeAdapter).getViewerCounts(['UCLgYa1O5NodobOaDK6xj5aQ:stream-2']);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].fetchFailed).toBe(true);
    expect(snaps[0].isLive).toBe(false);
    expect(a.resolveIdentifiers).toHaveBeenCalledWith([]);
  });
});
