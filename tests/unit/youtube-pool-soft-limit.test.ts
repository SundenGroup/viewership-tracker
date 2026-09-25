/**
 * The key pool's counters are an estimate and never a stop (2026-09-25):
 * the pool called itself empty at 48,854 units while every key still
 * answered 200 OK, and Scout stopped searching YouTube for the night. Now a
 * key we count as spent is tried anyway, Google's quotaExceeded answer is
 * what retires a key for the day, and the next key takes over the call.
 */
import axios, { type AxiosInstance } from 'axios';
import { YouTubeAdapter } from '../../src/adapters/youtube';
import { choosePoolKey, type YouTubeApiKeyRow } from '../../src/models/youtube-api-key';
import * as KeyModel from '../../src/models/youtube-api-key';

jest.mock('../../src/models/youtube-api-key', () => {
  const actual = jest.requireActual('../../src/models/youtube-api-key');
  return {
    ...actual,
    pickBestKey: jest.fn(async (partner: string | null, cost: number, used: Map<string, number>, refused: Set<string> = new Set()) => {
      const pick = actual.choosePoolKey(mockRows(), partner, cost, used, refused);
      // The secret doubles as the key id, so the fake axios client below knows which key it serves.
      return pick ? { id: pick.row.id, label: pick.row.label, partner: pick.row.partner, secret: pick.row.id, daily_quota: pick.row.daily_quota, overEstimate: pick.overEstimate } : null;
    }),
    touchLastUsed: jest.fn(async () => undefined),
  };
});

function row(id: string, partner: string | null, daily_quota = 10_000): YouTubeApiKeyRow {
  return { id, label: id, partner, secret_encrypted: '', secret_last4: '0000', daily_quota, is_active: true, created_by: null, created_at: '', updated_at: '', last_used_at: null };
}
function mockRows(): YouTubeApiKeyRow[] {
  return [row('krafton', 'Krafton'), row('shared-a', null), row('shared-b', null)];
}

const pickBestKey = KeyModel.pickBestKey as jest.Mock;
type Answer = () => unknown;
let answers: Record<string, Answer>;
const realCreate = axios.create.bind(axios);
const googleQuotaError = (reason = 'quotaExceeded') =>
  Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { error: { errors: [{ reason }], message: reason === 'quotaExceeded' ? 'The request cannot be completed because you have exceeded your quota.' : 'Forbidden' } } },
  });
const oneStream = () => ({ items: [{ id: { videoId: 'v1' }, snippet: { channelId: 'UC1', channelTitle: 'Some channel', title: 'PEC watch party', publishedAt: '' } }] });

/** The adapter's private pool state, as the tests read and set it. */
interface TestAdapter {
  perKeyUsed: Map<string, number>;
  poolRefused: Map<string, string>;
  perKeyResetDate: string;
  savePoolQuotaToDisk: unknown;
  getVideoDetails: unknown;
  acquirePoolClient(cost: number, partner: string | null, context: string): Promise<{ keyId: string } | null>;
  searchLiveStreams(gameId?: string, keywords?: string[], categoryIds?: string[], partner?: string | null): Promise<Array<{ channelIdentifier: string }>>;
}

function adapter(): TestAdapter {
  const a = new YouTubeAdapter('test-key') as unknown as TestAdapter;
  a.savePoolQuotaToDisk = jest.fn();
  a.getVideoDetails = jest.fn(async () => []);
  return a;
}

beforeEach(() => {
  answers = {};
  pickBestKey.mockClear();
  jest.spyOn(axios, 'create').mockImplementation((cfg?: { params?: { key?: string } }) => {
    const key = cfg?.params?.key;
    if (!key || !(key in answers)) return realCreate(cfg);
    return { get: jest.fn(async () => ({ data: answers[key]() })) } as unknown as AxiosInstance;
  });
});
afterEach(() => jest.restoreAllMocks());

describe('choosePoolKey', () => {
  const rows = mockRows();
  const none = new Set<string>();

  it('prefers a key with estimated room, the most room first', () => {
    const used = new Map([['krafton', 10_000], ['shared-a', 9_000], ['shared-b', 8_000]]);
    expect(choosePoolKey(rows, 'Krafton', 100, used, none)).toMatchObject({ row: { id: 'shared-b' }, overEstimate: false });
  });

  it('still returns a key we count as spent when no key has room, the partner key first', () => {
    const used = new Map([['krafton', 10_000], ['shared-a', 9_950], ['shared-b', 9_990]]);
    expect(choosePoolKey(rows, 'Krafton', 100, used, none)).toMatchObject({ row: { id: 'krafton' }, overEstimate: true });
    expect(choosePoolKey(rows, null, 100, used, none)).toMatchObject({ row: { id: 'shared-a' }, overEstimate: true });
  });

  it('skips keys Google refused today, and gives up only when every eligible key is refused', () => {
    const used = new Map([['krafton', 10_000], ['shared-a', 10_000], ['shared-b', 10_000]]);
    expect(choosePoolKey(rows, 'Krafton', 100, used, new Set(['krafton']))).toMatchObject({ row: { id: 'shared-a' } });
    expect(choosePoolKey(rows, 'Krafton', 100, used, new Set(['krafton', 'shared-a', 'shared-b']))).toBeNull();
    expect(choosePoolKey(rows, null, 100, new Map(), new Set(['shared-a', 'shared-b']))).toBeNull();
  });
});

describe('YouTube key pool: the estimate never stops a call', () => {
  it('acquires a key although our count says every key is spent', async () => {
    const a = adapter();
    a.perKeyUsed = new Map([['krafton', 10_000], ['shared-a', 10_000], ['shared-b', 10_000]]);
    const got = await a.acquirePoolClient(100, 'Krafton', 'test');
    expect(got?.keyId).toBe('krafton');
    expect(a.perKeyUsed.get('krafton')).toBe(10_100);
  });

  it('retires a key Google refuses and finishes the call with the next key', async () => {
    const a = adapter();
    answers = { 'shared-a': () => { throw googleQuotaError(); }, 'shared-b': oneStream };
    const streams = await a.searchLiveStreams(undefined, ['PEC'], undefined, null);
    expect(streams.map((s) => s.channelIdentifier)).toEqual(['UC1']);
    expect([...a.poolRefused.keys()]).toEqual(['shared-a']);
    expect(a.perKeyUsed.get('shared-a')).toBe(10_000);
    // the next search does not touch the refused key at all
    const refusedSets = pickBestKey.mock.calls.map((c) => [...(c[3] as Set<string>)]);
    expect(refusedSets).toEqual([[], ['shared-a']]);
    await a.searchLiveStreams(undefined, ['PEC'], undefined, null);
    expect(pickBestKey.mock.calls[pickBestKey.mock.calls.length - 1][3]).toEqual(new Set(['shared-a']));
  });

  it('gives up only when every key has been refused', async () => {
    const a = adapter();
    answers = { 'shared-a': () => { throw googleQuotaError(); }, 'shared-b': () => { throw googleQuotaError(); } };
    expect(await a.searchLiveStreams(undefined, ['PEC'], undefined, null)).toEqual([]);
    expect([...a.poolRefused.keys()].sort()).toEqual(['shared-a', 'shared-b']);
  });

  it('treats a 403 for another reason as a failed call, not a refusal', async () => {
    const a = adapter();
    answers = { 'shared-a': () => { throw googleQuotaError('forbidden'); }, 'shared-b': oneStream };
    expect(await a.searchLiveStreams(undefined, ['PEC'], undefined, null)).toEqual([]);
    expect(a.poolRefused.size).toBe(0);
  });

  it('forgets the refusals on a new day', async () => {
    const a = adapter();
    a.poolRefused = new Map([['shared-a', '2000-01-01']]);
    a.perKeyUsed = new Map([['shared-a', 10_000]]);
    a.perKeyResetDate = '2000-01-01';
    const got = await a.acquirePoolClient(100, null, 'test');
    expect(got?.keyId).toBe('shared-a');
    expect(a.poolRefused.size).toBe(0);
  });
});
