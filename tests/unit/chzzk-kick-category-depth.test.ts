/**
 * Category listings added for the GTA VI tracker (2026-11-18): CHZZK read
 * down to a viewer floor, and Kick read per language past its 100 rows.
 */
import { ChzzkAdapter, chzzkOpenDateToIso } from '../../src/adapters/chzzk';
import { KickAdapter, KICK_LISTING_LANGUAGES } from '../../src/adapters/kick';
import { chzzkCategory, kickLanguageSplit } from '../../src/utils/tracker-metadata';
import type { DiscoveredStream } from '../../src/adapters/types';

type Stub = Record<string, unknown>;

const chzzkItem = (i: number, viewers: number) => ({
  liveId: 1000 + i,
  liveTitle: `GTA6 ${i}`,
  concurrentUserCount: viewers,
  openDate: '2026-11-18 19:24:37',
  liveCategory: 'Grand_Theft_Auto_VI',
  liveCategoryValue: 'GTA 6',
  channel: { channelId: `ch${i}`, channelName: `Chan ${i}`, channelImageUrl: null },
});

function chzzkOver(pages: Array<ReturnType<typeof chzzkItem>[]>) {
  const get = jest.fn(async (_url: string, cfg: { params: Record<string, number | string> }) => {
    const idx = cfg.params.liveId ? Number(cfg.params.liveId) : 0;
    const data = pages[idx] ?? [];
    const next = idx + 1 < pages.length ? { concurrentUserCount: data[data.length - 1]?.concurrentUserCount ?? 0, liveId: idx + 1 } : null;
    return { data: { code: 200, content: { page: { next }, data } } };
  });
  const a = new ChzzkAdapter() as unknown as Stub;
  a.client = { get };
  a.requestWithRetry = async (fn: () => Promise<unknown>) => fn();
  a.delay = async () => {};
  return { adapter: a as unknown as ChzzkAdapter, get };
}

describe('ChzzkAdapter.listCategoryLives', () => {
  it('maps a live to a stream, with the Korea-time start as ISO', async () => {
    const { adapter, get } = chzzkOver([[chzzkItem(1, 1403)]]);
    const out = await adapter.listCategoryLives('Grand_Theft_Auto_VI');
    expect(get.mock.calls[0][0]).toBe('/service/v2/categories/GAME/Grand_Theft_Auto_VI/lives');
    expect(out).toEqual([
      {
        channelIdentifier: 'ch1', displayName: 'Chan 1', concurrentViewers: 1403, language: 'ko', title: 'GTA6 1',
        gameName: 'GTA 6', startedAt: '2026-11-18T10:24:37.000Z', streamId: '1001', platformCategoryId: 'Grand_Theft_Auto_VI',
      },
    ]);
  });

  it('follows the page cursor and stops at the first page wholly below the floor', async () => {
    const { adapter, get } = chzzkOver([
      [chzzkItem(1, 900), chzzkItem(2, 120)],
      [chzzkItem(3, 60), chzzkItem(4, 40)],
      [chzzkItem(5, 30), chzzkItem(6, 20)],
      [chzzkItem(7, 5)],
    ]);
    const out = await adapter.listCategoryLives('Grand_Theft_Auto_VI', { minViewers: 50 });
    expect(get).toHaveBeenCalledTimes(3);
    expect(out.filter((s) => s.concurrentViewers >= 50).map((s) => s.channelIdentifier)).toEqual(['ch1', 'ch2', 'ch3']);
  });

  it('keeps a given category type, and throws when the first page cannot be read', async () => {
    const { adapter, get } = chzzkOver([[chzzkItem(1, 10)]]);
    await adapter.listCategoryLives('ETC/talk');
    expect(get.mock.calls[0][0]).toBe('/service/v2/categories/ETC/talk/lives');

    const broken = new ChzzkAdapter() as unknown as Stub;
    broken.requestWithRetry = async () => null;
    await expect((broken as unknown as ChzzkAdapter).listCategoryLives('Grand_Theft_Auto_VI')).rejects.toThrow('could not be listed');
  });

  it('reads the start time as Korea time', () => {
    expect(chzzkOpenDateToIso('2026-11-18 00:00:05')).toBe('2026-11-17T15:00:05.000Z');
    expect(chzzkOpenDateToIso('yesterday')).toBeNull();
    expect(chzzkOpenDateToIso(null)).toBeNull();
  });
});

const kickStream = (slug: string, viewers: number): DiscoveredStream => ({
  channelIdentifier: slug, displayName: slug, concurrentViewers: viewers, language: 'en', title: 't',
});
const kickRaw = (slug: string, viewers: number, categoryId = 13155) => ({
  slug, viewer_count: viewers, stream_title: 't', language: 'es', started_at: '2026-11-18T10:00:00Z', category: { id: categoryId, name: 'GTA VI' },
});

function kickOver(base: DiscoveredStream[], byLanguage: Record<string, ReturnType<typeof kickRaw>[]>, failOn?: string) {
  const get = jest.fn(async (_url: string, cfg: { params: { language: string } }) => {
    if (cfg.params.language === failOn) throw new Error('timeout');
    return { data: { data: byLanguage[cfg.params.language] ?? [] } };
  });
  const a = new KickAdapter() as unknown as Stub;
  a.client = { get };
  a.searchLiveStreams = jest.fn(async () => base);
  return { adapter: a as unknown as KickAdapter, get };
}

const fullBase = (smallest: number) => Array.from({ length: 100 }, (_, i) => kickStream(`top${i}`, smallest + 100 - i));

describe('KickAdapter.listCategoryByLanguage', () => {
  it('returns the plain listing when it is not full', async () => {
    const { adapter, get } = kickOver([kickStream('a', 500), kickStream('b', 20)], {});
    expect(await adapter.listCategoryByLanguage('13155', { minViewers: 5 })).toHaveLength(2);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns the plain listing when it already reaches below the floor', async () => {
    const { adapter, get } = kickOver(fullBase(1), {});
    expect(await adapter.listCategoryByLanguage('13155', { minViewers: 50 })).toHaveLength(100);
    expect(get).not.toHaveBeenCalled();
  });

  it('adds every language list when the plain listing is full and above the floor', async () => {
    const { adapter, get } = kickOver(fullBase(1200), {
      es: [kickRaw('top0', 9999), kickRaw('es1', 700), kickRaw('es2', 60)],
      tr: [kickRaw('tr1', 300), kickRaw('other-game', 5000, 15)],
    });
    const out = await adapter.listCategoryByLanguage('13155', { minViewers: 50 });
    expect(get).toHaveBeenCalledTimes(KICK_LISTING_LANGUAGES.length);
    expect(out).toHaveLength(103);
    const slugs = out.map((s) => s.channelIdentifier);
    expect(slugs).toEqual(expect.arrayContaining(['es1', 'es2', 'tr1']));
    expect(slugs).not.toContain('other-game');
    // The plain listing's own row wins for a stream that is in both.
    expect(out.find((s) => s.channelIdentifier === 'top0')?.concurrentViewers).toBe(1300);
  });

  it('asks only the languages that had rows until the next full probe', async () => {
    const { adapter, get } = kickOver(fullBase(1200), { es: [kickRaw('es1', 700)], tr: [kickRaw('tr1', 300)] });
    await adapter.listCategoryByLanguage('13155', { minViewers: 50 });
    get.mockClear();
    const out = await adapter.listCategoryByLanguage('13155', { minViewers: 50 });
    expect(get.mock.calls.map((c) => c[1].params.language).sort()).toEqual(['es', 'tr']);
    expect(out).toHaveLength(102);
  });

  it('keeps the plain listing when a language request fails', async () => {
    const { adapter } = kickOver(fullBase(1200), { es: [kickRaw('es1', 700)] }, 'en');
    const out = await adapter.listCategoryByLanguage('13155', { minViewers: 50 });
    expect(out.length).toBeGreaterThanOrEqual(100);
    expect(out.slice(0, 100).map((s) => s.channelIdentifier)).toEqual(fullBase(1200).map((s) => s.channelIdentifier));
  });
});

describe('tracker metadata settings', () => {
  it('reads the CHZZK category from an object or stored JSON text', () => {
    const meta = { chzzk_category_id: 'Grand_Theft_Auto_VI', chzzk_category_name: 'GTA 6' };
    expect(chzzkCategory(meta)).toEqual({ id: 'Grand_Theft_Auto_VI', name: 'GTA 6' });
    expect(chzzkCategory(JSON.stringify(meta))).toEqual({ id: 'Grand_Theft_Auto_VI', name: 'GTA 6' });
    expect(chzzkCategory({ chzzk_category_id: 'ETC/talk' })).toEqual({ id: 'ETC/talk', name: null });
  });

  it('rejects anything that is not a category id', () => {
    expect(chzzkCategory({ chzzk_category_id: '../lives?x=1' })).toBeNull();
    expect(chzzkCategory({ chzzk_category_id: '' })).toBeNull();
    expect(chzzkCategory({ chzzk_category_id: 42 })).toBeNull();
    expect(chzzkCategory(null)).toBeNull();
  });

  it('turns the Kick language split on only for an explicit true', () => {
    expect(kickLanguageSplit({ kick_language_split: true })).toBe(true);
    expect(kickLanguageSplit({ kick_language_split: 'true' })).toBe(false);
    expect(kickLanguageSplit({})).toBe(false);
    expect(kickLanguageSplit('not json')).toBe(false);
  });
});
