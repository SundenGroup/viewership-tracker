/**
 * The per-series YouTube search depth (2026-09-26). Every Google project
 * allows 100 searches a day and one keyword could fetch four pages, so a
 * PAS2 cycle cost 8 to 9 searches instead of 5. The series setting
 * `metadata.youtube_search_pages` caps the pages per keyword; the empty-pool
 * log lines, which repeated every poll all night, are throttled.
 */
import axios, { type AxiosInstance } from 'axios';
import { YouTubeAdapter, youtubeSearchPageCap } from '../../src/adapters/youtube';
import type { YouTubeApiKeyRow } from '../../src/models/youtube-api-key';
import logger from '../../src/utils/logger';

jest.mock('../../src/models/youtube-api-key', () => {
  const actual = jest.requireActual('../../src/models/youtube-api-key');
  return {
    ...actual,
    pickBestKey: jest.fn(async (partner: string | null, cost: number, used: Map<string, number>, refused: Set<string> = new Set()) => {
      const pick = actual.choosePoolKey(mockRows(), partner, cost, used, refused);
      return pick ? { id: pick.row.id, label: pick.row.label, partner: pick.row.partner, secret: pick.row.id, daily_quota: pick.row.daily_quota, overEstimate: pick.overEstimate } : null;
    }),
    touchLastUsed: jest.fn(async () => undefined),
  };
});
function mockRows(): YouTubeApiKeyRow[] {
  return [{ id: 'shared-a', label: 'shared-a', partner: null, secret_encrypted: '', secret_last4: '0000', daily_quota: 10_000, is_active: true, created_by: null, created_at: '', updated_at: '', last_used_at: null }];
}

interface TestAdapter {
  perKeyUsed: Map<string, number>;
  poolRefused: Map<string, string>;
  savePoolQuotaToDisk: unknown;
  getVideoDetails: unknown;
  logPoolEmpty(key: string, message: string, level?: 'error' | 'warn'): void;
  acquirePoolClient(cost: number, partner: string | null, context: string): Promise<{ keyId: string } | null>;
  searchLiveStreams(gameId?: string, keywords?: string[], categoryIds?: string[], partner?: string | null, options?: { youtubeSearchPages?: number }): Promise<Array<{ channelIdentifier: string }>>;
}
// One search per keyword, as production runs it (YOUTUBE_SCOUT_MERGED=0 on the server).
process.env.YOUTUBE_SCOUT_MERGED = '0';
const realCreate = axios.create.bind(axios);
let searchCalls = 0;
const page = (n: number) => ({ items: [{ id: { videoId: `v${n}` }, snippet: { channelId: `UC${n}`, channelTitle: 'ch', title: 'PEC watch party', publishedAt: '' } }], nextPageToken: `t${n + 1}` });

function adapter(): TestAdapter {
  const a = new YouTubeAdapter('test-key') as unknown as TestAdapter;
  a.savePoolQuotaToDisk = jest.fn();
  a.getVideoDetails = jest.fn(async () => []);
  return a;
}
beforeEach(() => {
  searchCalls = 0;
  jest.spyOn(axios, 'create').mockImplementation((cfg?: { params?: { key?: string } }) => {
    if (cfg?.params?.key !== 'shared-a') return realCreate(cfg);
    return { get: jest.fn(async () => ({ data: page(++searchCalls) })) } as unknown as AxiosInstance;
  });
});
afterEach(() => jest.restoreAllMocks());

describe('youtubeSearchPageCap', () => {
  it('reads the series setting and keeps it between 1 and 4, the full 4 when unset', () => {
    expect(youtubeSearchPageCap(undefined)).toBe(4);
    expect(youtubeSearchPageCap(null)).toBe(4);
    expect(youtubeSearchPageCap('abc')).toBe(4);
    expect(youtubeSearchPageCap(1)).toBe(1);
    expect(youtubeSearchPageCap('1')).toBe(1);
    expect(youtubeSearchPageCap(0)).toBe(1);
    expect(youtubeSearchPageCap(9)).toBe(4);
    expect(youtubeSearchPageCap(2.6)).toBe(3);
  });
});

describe('Scout search on YouTube: pages per keyword', () => {
  it('fetches every page when the series has no setting', async () => {
    const streams = await adapter().searchLiveStreams(undefined, ['PEC'], undefined, null);
    expect(searchCalls).toBe(4);
    expect(streams).toHaveLength(4);
  });
  it('stops after the first page when the series caps it at one', async () => {
    const a = adapter();
    const streams = await a.searchLiveStreams(undefined, ['PEC', 'PUBG EMEA'], undefined, null, { youtubeSearchPages: 1 });
    expect(searchCalls).toBe(2);
    expect(streams).toHaveLength(2);
    expect(a.perKeyUsed.get('shared-a')).toBe(200);
  });
});

describe('empty-pool log lines are throttled', () => {
  it('logs once, then again only after ten minutes', () => {
    const a = adapter();
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    a.logPoolEmpty('exhausted:shared', 'pool empty');
    a.logPoolEmpty('exhausted:shared', 'pool empty');
    a.logPoolEmpty('exhausted:Krafton', 'pool empty for Krafton');
    now.mockReturnValue(1_000_000 + 11 * 60_000);
    a.logPoolEmpty('exhausted:shared', 'pool empty');
    expect(error).toHaveBeenCalledTimes(3);
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
