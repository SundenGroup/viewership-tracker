/**
 * YouTube quota and Scout (2026-09-20).
 *
 * 1. The key pool's per-key counters roll over to a new day before a key is
 *    picked. They used to roll over only while charging a picked key: once
 *    every key was spent no key was picked, the counters never rolled over,
 *    and Scout stayed blind on YouTube after Google's daily reset until a
 *    restart or an admin opening the quota panel.
 * 2. Scout sends its keywords as one merged query (100 units) instead of one
 *    search per keyword (1,100 units per cycle with eleven keywords).
 */
import { YouTubeAdapter, youtubeSearchQueries } from '../../src/adapters/youtube';
import * as KeyModel from '../../src/models/youtube-api-key';

jest.mock('../../src/models/youtube-api-key', () => ({
  pickBestKey: jest.fn(),
  touchLastUsed: jest.fn(async () => undefined),
}));

type Mutable = Record<string, unknown>;
const KEY = { id: 'key-1', label: 'test key', partner: null, secret: 'secret', daily_quota: 10_000 };

const PEC_KEYWORDS = [
  'PEC', 'PUBG EMEA CHAMPIONSHIP', 'PUBG EMEA', 'PECFall', 'PEC2026', 'PUBG Watch party',
  'EMEA championship', 'PUBG PC EMEA', 'PUBG Playoff', 'PUBG playoffs', 'acend watchparty',
];

describe('youtubeSearchQueries', () => {
  it('merges the keywords into one query of quoted phrases joined with the OR operator', () => {
    const queries = youtubeSearchQueries(PEC_KEYWORDS, true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toBe(PEC_KEYWORDS.map((k) => `"${k}"`).join('|'));
  });

  it('leaves a single keyword as it is', () => {
    expect(youtubeSearchQueries(['pubg americas series'], true)).toEqual(['pubg americas series']);
  });

  it('splits a long list so no query passes the length limit, keeping every keyword once', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tournament keyword number ${i}`);
    const queries = youtubeSearchQueries(many, true, 300);
    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) expect(q.length).toBeLessThanOrEqual(300);
    expect(queries.join('|').split('|')).toEqual(many.map((k) => `"${k}"`));
  });

  it('drops empty and repeated keywords and the characters that would break the query', () => {
    expect(youtubeSearchQueries(['PEC', ' pec ', '', 'PUBG "EMEA"', 'a|b'], true)).toEqual(['"PEC"|"PUBG EMEA"|"a b"']);
  });

  it('goes back to one search per keyword when merging is switched off', () => {
    expect(youtubeSearchQueries(['PEC', 'PUBG EMEA'], false)).toEqual(['PEC', 'PUBG EMEA']);
  });
});

describe('YouTube key pool: the daily roll-over', () => {
  const pickBestKey = KeyModel.pickBestKey as jest.Mock;

  function spentAdapter(resetDate?: string) {
    const a = new YouTubeAdapter('test-key') as unknown as Mutable;
    a.savePoolQuotaToDisk = jest.fn();
    a.perKeyUsed = new Map([[KEY.id, KEY.daily_quota]]);
    if (resetDate) a.perKeyResetDate = resetDate;
    return a as unknown as { acquirePoolClient(cost: number, partner: string | null, context: string): Promise<{ keyId: string } | null> } & Mutable;
  }

  beforeEach(() => {
    // The real selection rule: a key is eligible while its remaining quota covers the cost.
    pickBestKey.mockReset();
    pickBestKey.mockImplementation(async (_partner: string | null, cost: number, used: Map<string, number>) =>
      KEY.daily_quota - (used.get(KEY.id) ?? 0) >= cost ? KEY : null,
    );
  });

  it('picks a key again on a new day although every key was spent the day before', async () => {
    const a = spentAdapter('2000-01-01');
    const got = await a.acquirePoolClient(100, null, 'test');
    expect(got?.keyId).toBe(KEY.id);
    expect((a.perKeyUsed as Map<string, number>).get(KEY.id)).toBe(100);
  });

  it('stays exhausted within the same day', async () => {
    const a = spentAdapter();
    expect(await a.acquirePoolClient(100, null, 'test')).toBeNull();
    expect((a.perKeyUsed as Map<string, number>).get(KEY.id)).toBe(KEY.daily_quota);
  });
});

describe('Scout keyword search on YouTube', () => {
  it('spends one search call for eleven keywords', async () => {
    const get = jest.fn(async () => ({ data: { items: [] } }));
    const a = new YouTubeAdapter('test-key') as unknown as Mutable;
    a.acquirePoolClient = jest.fn(async () => ({ client: { get }, keyId: KEY.id, keyLabel: KEY.label }));
    const streams = await (a as unknown as YouTubeAdapter).searchLiveStreams(undefined, PEC_KEYWORDS, undefined, 'Krafton');
    expect(streams).toEqual([]);
    expect(a.acquirePoolClient).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    const [, options] = get.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(options.params.q).toBe(PEC_KEYWORDS.map((k) => `"${k}"`).join('|'));
    expect(options.params.eventType).toBe('live');
  });
});
