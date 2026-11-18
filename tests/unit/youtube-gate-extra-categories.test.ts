/**
 * YouTube gate: accepted extra categories, the auto-deny re-test, the
 * strict title test, and the roster cut.
 *
 * The stakes (GTA VI launch, 2026-11-18): a 104k-viewer stream titled
 * "GTA 6 O ÍNICIO!" was filed under Entertainment and denied outright,
 * and a full roster was cut in arrival order, so a new large stream
 * could be kept out by small ones that got there first.
 */
import { gateVideo, orderRoster, titleNamesGame } from '../../src/services/youtube-game-tracker';
import type { YouTubeLiveVideo } from '../../src/adapters/youtube';
import type { StoredDecision } from '../../src/models/game-tracker-youtube-channel';

const video = (over: Partial<YouTubeLiveVideo> = {}): YouTubeLiveVideo => ({
  videoId: 'v1',
  channelId: 'UCx',
  channelTitle: 'Chan',
  title: 'GTA 6 O ÍNICIO! 🔴',
  description: '',
  tags: [],
  concurrentViewers: 500,
  language: 'pt',
  categoryId: '20',
  startedAt: null,
  activeLiveChatId: null,
  ...over,
});

const cfg = {
  strongPhrases: ['gta 6', 'gta vi'],
  exclude: ['gta 5', 'gta vice city'],
  alwaysReviewAboveCcv: 1_000_000,
  escalateDeniedAboveCcv: 20_000,
  denyRetestDays: 0,
  extraCategoryIds: ['22', '24'],
};

const autoDenied = (decidedAt: Date): StoredDecision => ({
  decision: 'deny',
  human: false,
  scope: 'matching',
  reason: 'category 24 is not Gaming',
  decidedAt,
});

describe('gateVideo: accepted extra categories', () => {
  it('counts a stream filed under Entertainment when its title names the game', () => {
    expect(gateVideo(video({ categoryId: '24' }), cfg, undefined).decision).toBe('allow');
  });

  it('still denies an Entertainment stream whose title does not name the game', () => {
    const out = gateVideo(video({ categoryId: '24', title: 'Late night talk' }), cfg, undefined);
    expect(out.decision).toBe('deny');
    expect(out.reason).toBe('category 24 is not Gaming');
  });

  it('denies a category the tracker does not list, whatever the title', () => {
    expect(gateVideo(video({ categoryId: '25' }), cfg, undefined).decision).toBe('deny');
  });

  it('leaves trackers without the setting unchanged', () => {
    const { extraCategoryIds: _unused, ...plain } = cfg;
    expect(gateVideo(video({ categoryId: '24' }), plain, undefined).decision).toBe('deny');
  });

  it('applies to an approved channel too, title permitting', () => {
    const approved: StoredDecision = { decision: 'allow', human: true, scope: 'matching' };
    expect(gateVideo(video({ categoryId: '22' }), cfg, approved).decision).toBe('allow');
    expect(gateVideo(video({ categoryId: '22', title: 'Vlog' }), cfg, approved).decision).toBe('deny');
  });
});

describe('gateVideo: re-testing an automatic denial', () => {
  it('clears a large, previously denied channel on its own title once the re-test is due', () => {
    const out = gateVideo(
      video({ categoryId: '24', concurrentViewers: 104_324 }),
      cfg,
      autoDenied(new Date(Date.now() - 60_000)),
    );
    expect(out.decision).toBe('allow');
  });

  it('queues a large denied channel whose title does not name the game', () => {
    const out = gateVideo(
      video({ title: 'THE DAY IS HERE', concurrentViewers: 50_000 }),
      cfg,
      autoDenied(new Date(Date.now() - 60_000)),
    );
    expect(out.decision).toBe('pending');
    expect(out.reason).toContain('auto-denied channel seen with 50000 viewers');
  });

  it('keeps queueing a large denied channel while the re-test is not due', () => {
    const out = gateVideo(
      video({ concurrentViewers: 50_000 }),
      { ...cfg, denyRetestDays: 7 },
      autoDenied(new Date()),
    );
    expect(out.decision).toBe('pending');
  });

  it('keeps a small denied channel denied until the re-test is due', () => {
    const out = gateVideo(video(), { ...cfg, denyRetestDays: 7 }, autoDenied(new Date()));
    expect(out).toMatchObject({ decision: 'deny', evaluated: false });
  });
});

describe('titleNamesGame', () => {
  it('needs the game in the title and no excluded word', () => {
    expect(titleNamesGame('نلعب GTA 6', cfg)).toBe(true);
    expect(titleNamesGame('🔴| LIVE |🔴GTA 6', cfg)).toBe(true);
    expect(titleNamesGame('GTA 5 ONLINE!!', cfg)).toBe(false);
    expect(titleNamesGame('GTA 5 one last ride before GTA 6', cfg)).toBe(false);
    expect(titleNamesGame('musica romantica', cfg)).toBe(false);
    expect(titleNamesGame(null, cfg)).toBe(false);
  });

  it('matches nothing when the tracker has no vocabulary', () => {
    expect(titleNamesGame('GTA 6', {})).toBe(false);
  });
});

describe('orderRoster', () => {
  it('keeps the biggest audiences when over the cap, wherever they came from', () => {
    const known = new Map([['small-old', 600], ['mid-old', 900], ['new-giant', 300_000], ['tiny', 20]]);
    expect(orderRoster(known, [], 2)).toEqual(['new-giant', 'mid-old']);
  });

  it('reserves a share for ids whose audience is not known yet', () => {
    const known = new Map(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1000 - i] as [string, number]));
    const ids = orderRoster(known, ['u1', 'u2', 'u3'], 20);
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 18)).toEqual(Array.from({ length: 18 }, (_, i) => `k${i}`));
    expect(ids.slice(18)).toEqual(['u1', 'u2']);
  });

  it('takes everything when it all fits, without repeating an id', () => {
    const known = new Map([['a', 5], ['b', 50]]);
    expect(orderRoster(known, ['c', 'a', 'c'], 300)).toEqual(['b', 'a', 'c']);
  });
});
