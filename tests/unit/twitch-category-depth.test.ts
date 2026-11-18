/**
 * Twitch category listing depth.
 *
 * The stakes (GTA VI launch, 2026-11-18): the listing stopped after five
 * pages, so a tracker could never see past the 500 largest streams of a
 * category that held more than a thousand streams above its viewer floor.
 */
import { TwitchAdapter } from '../../src/adapters/twitch';

type Stream = { id: string; user_login: string; user_name: string; viewer_count: number; language: string; title: string; game_name: string; started_at: string };

/** 100 streams a page, audience falling by one per stream from `top`. */
function fakeCategory(top: number, total: number) {
  const all: Stream[] = Array.from({ length: total }, (_, i) => ({
    id: `s${i}`, user_login: `user${i}`, user_name: `User${i}`, viewer_count: Math.max(0, top - i),
    language: 'en', title: 'GTA 6', game_name: 'Grand Theft Auto VI', started_at: '2026-11-18T10:00:00Z',
  }));
  const get = jest.fn(async (_url: string, cfg: { params: Record<string, string> }) => {
    const start = cfg.params.after ? Number(cfg.params.after) : 0;
    const data = all.slice(start, start + 100);
    const next = start + 100 < all.length ? String(start + 100) : undefined;
    return { data: { data, pagination: next ? { cursor: next } : {} } };
  });
  return { get };
}

function adapterOver(client: { get: jest.Mock }): TwitchAdapter {
  const a = new TwitchAdapter('id', 'secret') as unknown as Record<string, unknown>;
  a.client = client;
  a.requestWithRetry = async (fn: () => Promise<unknown>) => fn();
  return a as unknown as TwitchAdapter;
}

describe('TwitchAdapter category listing depth', () => {
  it('reads five pages when no floor is asked for, as before', async () => {
    const client = fakeCategory(2000, 1500);
    const out = await adapterOver(client).searchLiveStreams('1867279146');
    expect(client.get).toHaveBeenCalledTimes(5);
    expect(out).toHaveLength(500);
  });

  it('reads down to the viewer floor and stops at the first page wholly below it', async () => {
    const client = fakeCategory(1000, 3000); // stream i has 1000 - i viewers
    const out = await adapterOver(client).listCategoryToFloor('1867279146', { minViewers: 50, maxPages: 30 });
    // Streams 0..950 are at or above 50; page 10 (1000..1099) is the first wholly below.
    expect(client.get).toHaveBeenCalledTimes(11);
    expect(out.filter((s) => s.concurrentViewers >= 50)).toHaveLength(951);
  });

  it('never reads past the page bound, whatever the floor', async () => {
    const client = fakeCategory(100_000, 5000);
    const out = await adapterOver(client).listCategoryToFloor('1867279146', { minViewers: 50, maxPages: 7 });
    expect(client.get).toHaveBeenCalledTimes(7);
    expect(out).toHaveLength(700);
  });

  it('keeps a stream once when it shows up on two pages', async () => {
    const page = (logins: string[], cursor?: string) => ({
      data: {
        data: logins.map((l, i) => ({ id: l, user_login: l, user_name: l, viewer_count: 500 - i, language: 'en', title: 't', game_name: 'g', started_at: '' })),
        pagination: cursor ? { cursor } : {},
      },
    });
    const get = jest.fn()
      .mockResolvedValueOnce(page(['a', 'b', 'c'], 'p2'))
      .mockResolvedValueOnce(page(['c', 'd']));
    const out = await adapterOver({ get }).searchLiveStreams('1');
    expect(out.map((s) => s.channelIdentifier)).toEqual(['a', 'b', 'c', 'd']);
  });
});
