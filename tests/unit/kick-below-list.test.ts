/**
 * Kick streams below a language's 100-row list: noted when they start,
 * then followed by channel id.
 */
import { KickAdapter } from '../../src/adapters/kick';
import { KickTailRoster } from '../../src/utils/kick-tail-roster';
import type { DiscoveredStream } from '../../src/adapters/types';

const MIN = 60_000;
const policy = { hotAtLeast: 10, youngForMs: 20 * MIN, coldEveryMs: 5 * MIN };

describe('KickTailRoster', () => {
  it('reads large and young streams on every poll, small old ones every few minutes', () => {
    const r = new KickTailRoster();
    const t0 = 1_000_000_000;
    r.observe(1, 80, t0); // large
    r.observe(2, 3, t0); // small
    const later = t0 + 30 * MIN; // nobody is young any more
    r.markRead([1, 2], later);
    expect(r.due(later + MIN, new Set(), policy)).toEqual([1]);
    expect(r.due(later + 5 * MIN, new Set(), policy).sort()).toEqual([1, 2]);
  });

  it('reads a stream that just started on every poll, however small', () => {
    const r = new KickTailRoster();
    const t0 = 1_000_000_000;
    r.observe(7, 0, t0);
    r.markRead([7], t0);
    expect(r.due(t0 + MIN, new Set(), policy)).toEqual([7]);
  });

  it('skips streams a list already returned this poll', () => {
    const r = new KickTailRoster();
    r.observe(1, 500, 1_000);
    r.observe(2, 400, 1_000);
    expect(r.due(2_000, new Set([1]), policy)).toEqual([2]);
  });

  it('forgets a stream that has not been seen live for the time limit', () => {
    const r = new KickTailRoster();
    const t0 = 1_000_000_000;
    r.observe(1, 50, t0);
    r.observe(2, 50, t0);
    r.observe(2, 60, t0 + 10 * MIN); // still live
    expect(r.prune(t0 + 13 * MIN, 12 * MIN)).toBe(1);
    expect(r.has(1)).toBe(false);
    expect(r.has(2)).toBe(true);
  });

  it('survives a restart through its saved rows, without the stale ones', () => {
    const r = new KickTailRoster();
    const t0 = 1_000_000_000;
    r.observe(1, 50, t0);
    r.observe(2, 70, t0 + 11 * MIN);
    const restored = KickTailRoster.load(JSON.parse(JSON.stringify(r.dump())), t0 + 13 * MIN, 12 * MIN);
    expect(restored.size).toBe(1);
    expect(restored.has(2)).toBe(true);
    expect(KickTailRoster.load('garbage', t0, MIN).size).toBe(0);
    expect(KickTailRoster.load([[1, 2], ['x', 1, 2, 3]], t0, MIN).size).toBe(0);
  });
});

// ── The adapter: lists, newly started, read by id ─────────────────────────

type Raw = {
  broadcaster_user_id: number; slug: string; viewer_count: number; stream_title: string; language: string;
  started_at: string; category: { id: number; name: string };
};
const raw = (id: number, viewers: number, language = 'en', categoryId = 13155): Raw => ({
  broadcaster_user_id: id, slug: `ch${id}`, viewer_count: viewers, stream_title: 't', language,
  started_at: '2026-11-18T10:00:00Z', category: { id: categoryId, name: 'GTA VI' },
});
const baseStream = (i: number): DiscoveredStream => ({
  channelIdentifier: `top${i}`, displayName: `top${i}`, concurrentViewers: 5000 - i, language: 'en', title: 't',
});

interface Params { language?: string; sort?: string; broadcaster_user_id?: number[] }
function kick(world: { english: Raw[]; started: Raw[]; live: Map<number, Raw> }) {
  const calls: Params[] = [];
  const get = jest.fn(async (_url: string, cfg: { params: Params }) => {
    const p = cfg.params;
    calls.push(p);
    if (p.broadcaster_user_id) {
      return { data: { data: p.broadcaster_user_id.map((id) => world.live.get(id)).filter(Boolean) } };
    }
    if (p.language !== 'en') return { data: { data: [] } };
    return { data: { data: p.sort === 'started_at' ? world.started : world.english } };
  });
  const a = new KickAdapter() as unknown as {
    client: unknown; searchLiveStreams: unknown;
    listCategoryByLanguage: KickAdapter['listCategoryByLanguage'];
  };
  a.client = { get };
  a.searchLiveStreams = jest.fn(async () => Array.from({ length: 100 }, (_, i) => baseStream(i)));
  return { adapter: a, calls };
}

describe('KickAdapter below a full language list', () => {
  // English: 100 streams from 300 down to 201 viewers, so the list is cut above a floor of 25.
  const english = Array.from({ length: 100 }, (_, i) => raw(1000 + i, 300 - i));

  it('adds newly started streams and keeps following them by id', async () => {
    const newcomer = raw(5001, 4); // just started, below the floor for now
    const world = { english, started: [newcomer], live: new Map<number, Raw>([[5001, newcomer]]) };
    const { adapter, calls } = kick(world);

    let out = await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    expect(out.map((s) => s.channelIdentifier)).toContain('ch5001');
    expect(calls.some((c) => c.sort === 'started_at' && c.language === 'en')).toBe(true);

    // Twenty-five minutes on: it has left the newly-started list and grown to 60 viewers.
    world.started = [];
    world.live.set(5001, raw(5001, 60));
    calls.length = 0;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * MIN);
    out = await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    const byId = calls.filter((c) => c.broadcaster_user_id);
    expect(byId.flatMap((c) => c.broadcaster_user_id)).toContain(5001);
    expect(out.find((s) => s.channelIdentifier === 'ch5001')?.concurrentViewers).toBe(60);
    jest.restoreAllMocks();
  });

  it('follows a stream that drops out of the top 100', async () => {
    const world = { english: [...english], started: [] as Raw[], live: new Map<number, Raw>() };
    const { adapter, calls } = kick(world);
    await adapter.listCategoryByLanguage('13155', { minViewers: 25 });

    // ch1099 (201 viewers) is pushed out of the list by a new, larger stream.
    world.english = [raw(9000, 900), ...english.slice(0, 99)];
    world.live.set(1099, raw(1099, 190));
    calls.length = 0;
    const out = await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    expect(calls.filter((c) => c.broadcaster_user_id).flatMap((c) => c.broadcaster_user_id)).toContain(1099);
    expect(out.find((s) => s.channelIdentifier === 'ch1099')?.concurrentViewers).toBe(190);
  });

  it('does not count a followed stream that moved to another category', async () => {
    const moved = raw(5002, 80);
    const world = { english, started: [moved], live: new Map<number, Raw>([[5002, moved]]) };
    const { adapter } = kick(world);
    await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    world.started = [];
    world.live.set(5002, raw(5002, 80, 'en', 15)); // now streaming another game
    const out = await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    expect(out.map((s) => s.channelIdentifier)).not.toContain('ch5002');
  });

  it('asks nothing extra for a language whose list is not full', async () => {
    const world = { english: english.slice(0, 60), started: [] as Raw[], live: new Map<number, Raw>() };
    const { adapter, calls } = kick(world);
    await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    expect(calls.some((c) => c.sort === 'started_at' || c.broadcaster_user_id)).toBe(false);
  });

  it('reads ids 50 to a call', async () => {
    const started = Array.from({ length: 100 }, (_, i) => raw(7000 + i, 30));
    const world = { english, started, live: new Map<number, Raw>(started.map((r) => [r.broadcaster_user_id, r])) };
    const { adapter, calls } = kick(world);
    await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    world.started = [];
    calls.length = 0;
    await adapter.listCategoryByLanguage('13155', { minViewers: 25 });
    const byId = calls.filter((c) => c.broadcaster_user_id);
    expect(byId).toHaveLength(2);
    expect(byId.every((c) => (c.broadcaster_user_id as number[]).length <= 50)).toBe(true);
  });
});
