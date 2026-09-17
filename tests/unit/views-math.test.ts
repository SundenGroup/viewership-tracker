/**
 * Live views: which number counts, how much of a long broadcast belongs to
 * the event, and when the collector is due. The figures in the comments are
 * the real cases they were written for (GeoGuessr WC 2026, PAS2, PEC Fall).
 */
import {
  estimateViews,
  eventShare,
  groupRank,
  isLateRead,
  overlaps,
  parseSoopBroadNo,
  pickBestViews,
  windowedViews,
  type ViewsRowLite,
} from '../../src/utils/views-math';
import { ViewsCollector, viewsFactor } from '../../src/services/views-collector';

const at = (iso: string) => new Date(iso);
const row = (o: Partial<ViewsRowLite>): ViewsRowLite => ({
  source: 'twitch_vod',
  snapshot: 'plus_36h',
  counted: true,
  confidence: 'measured',
  eventShareMethod: 'full',
  views: 100,
  eventViews: 100,
  streamRef: 'v1',
  ...o,
});

describe('overlaps', () => {
  it('matches an archive that covers the tracked span', () => {
    expect(overlaps(at('2026-09-05T11:46Z'), at('2026-09-05T21:00Z'), at('2026-09-05T11:50Z'), at('2026-09-05T20:40Z'))).toBe(true);
  });
  it('leaves out a stream that started after the day ended, beyond the margin', () => {
    // chessbrah's 01:20 stream the night after GeoGuessr Day 4
    expect(overlaps(at('2026-09-06T01:20Z'), at('2026-09-06T04:46Z'), at('2026-09-05T12:00Z'), at('2026-09-05T21:30Z'), 15 * 60_000)).toBe(false);
  });
  it('the margin catches a restart a few minutes before the first tracked minute', () => {
    expect(overlaps(at('2026-09-05T11:00Z'), at('2026-09-05T11:52Z'), at('2026-09-05T12:00Z'), at('2026-09-05T21:00Z'), 15 * 60_000)).toBe(true);
  });
});

describe('eventShare', () => {
  it('a broadcast about as long as the tracked span counts in full', () => {
    expect(eventShare({ trackedMinutes: 552, trackedViewerMinutes: 1, broadcastMinutes: 554 })).toEqual({ share: 1, method: 'full' });
  });
  it('a long broadcast with Discover coverage uses viewer-minutes (Lightshimi: 2%)', () => {
    const s = eventShare({ trackedMinutes: 572, trackedViewerMinutes: 12_100, broadcastMinutes: 1961, fullViewerMinutes: 514_500, fullCoverage: 0.97 });
    expect(s.method).toBe('viewer_minutes');
    expect(s.share).toBeCloseTo(0.0235, 3);
  });
  it('without coverage it falls back to the time share (ohnepixel: 160 of 462 minutes)', () => {
    const s = eventShare({ trackedMinutes: 160, trackedViewerMinutes: 7_000_000, broadcastMinutes: 462, fullViewerMinutes: 2_000_000, fullCoverage: 0.35 });
    expect(s.method).toBe('time_share');
    expect(s.share).toBeCloseTo(0.346, 3);
  });
  it('never exceeds 1 when Discover saw less audience than we did', () => {
    expect(eventShare({ trackedMinutes: 300, trackedViewerMinutes: 9_000, broadcastMinutes: 600, fullViewerMinutes: 5_000, fullCoverage: 0.9 }).share).toBe(1);
  });
});

describe('estimateViews', () => {
  it('viewer-hours times the factor', () => {
    expect(estimateViews(60 * 1_159, 5.5)).toBe(6_375);
    expect(estimateViews(0)).toBe(0);
  });
  it('TikTok counts every room entry, so its default factor is higher', () => {
    expect(viewsFactor('tiktok')).toBe(20);
    expect(viewsFactor('twitch')).toBe(5.5);
  });
});

describe('windowedViews', () => {
  const w0 = at('2026-09-05T11:30Z');
  const w1 = at('2026-09-05T21:30Z');
  it('a stream already running at the window start only counts what it gained inside', () => {
    const r = windowedViews(
      [
        { readAt: at('2026-09-05T11:31Z'), views: 40_000 },
        { readAt: at('2026-09-05T16:00Z'), views: 90_000 },
        { readAt: at('2026-09-05T21:29Z'), views: 140_000 },
      ],
      w0,
      w1,
    );
    expect(r).toEqual({ views: 100_000, last: 140_000, method: 'windowed' });
  });
  it('a stream that started inside the window keeps its whole count', () => {
    const r = windowedViews(
      [
        { readAt: at('2026-09-05T13:40Z'), views: 1_200 },
        { readAt: at('2026-09-05T21:20Z'), views: 250_000 },
      ],
      w0,
      w1,
    );
    expect(r).toEqual({ views: 250_000, last: 250_000, method: 'full' });
  });
  it('no readings inside the window gives nothing', () => {
    expect(windowedViews([{ readAt: at('2026-09-05T22:00Z'), views: 5 }], w0, w1)).toBeNull();
  });
});

describe('pickBestViews', () => {
  it('a Twitch archive beats the estimate', () => {
    const best = pickBestViews([
      row({ source: 'estimate', snapshot: 'estimate', confidence: 'estimated', eventShareMethod: 'none', views: null, eventViews: 640 }),
      row({ views: 8_635, eventViews: 8_635 }),
    ]);
    expect(best?.source).toBe('twitch_vod');
    expect(best?.eventViews).toBe(8_635);
    expect(best?.confidence).toBe('measured');
  });
  it('two archives on one day (a restart) are summed', () => {
    const best = pickBestViews([row({ streamRef: 'a', views: 730, eventViews: 730 }), row({ streamRef: 'b', views: 148, eventViews: 148 })]);
    expect(best?.eventViews).toBe(878);
    expect(best?.streams).toBe(2);
  });
  it('Kick replay views never speak for a channel, the estimate does', () => {
    const best = pickBestViews([
      row({ source: 'kick_vod', counted: false, confidence: 'replay', eventShareMethod: 'none', views: 15_859, eventViews: null }),
      row({ source: 'estimate', snapshot: 'estimate', confidence: 'estimated', eventShareMethod: 'none', views: null, eventViews: 31_351 }),
    ]);
    expect(best?.source).toBe('estimate');
    expect(best?.eventViews).toBe(31_351);
  });
  it('the owner’s number (TikTok LIVE Center) beats everything public', () => {
    const best = pickBestViews([
      row({ source: 'estimate', snapshot: 'estimate', confidence: 'estimated', eventViews: 23_180, views: null }),
      row({ source: 'tiktok_livecenter', snapshot: 'manual', views: 23_425, eventViews: 23_425 }),
    ]);
    expect(best?.source).toBe('tiktok_livecenter');
  });
  it('YouTube: the settled 3-hour read wins for a normal stream, the windowed live reading for a long one', () => {
    expect(
      pickBestViews([
        row({ source: 'youtube_public', snapshot: 'plus_3h', views: 24_353, eventViews: 24_353 }),
        row({ source: 'youtube_live', snapshot: 'live_end', views: 21_000, eventViews: 21_000 }),
        row({ source: 'youtube_public', snapshot: 'plus_36h', views: 31_000, eventViews: 31_000 }),
      ])?.snapshot,
    ).toBe('plus_3h');
    expect(
      pickBestViews([
        row({ source: 'youtube_public', snapshot: 'plus_3h', views: 603_760, eventViews: 204_723, eventShareMethod: 'time_share', confidence: 'adjusted' }),
        row({ source: 'youtube_live', snapshot: 'live_end', views: 590_000, eventViews: 260_000, eventShareMethod: 'windowed', confidence: 'adjusted' }),
      ])?.source,
    ).toBe('youtube_live');
  });
  it('nothing counted, nothing reported', () => {
    expect(pickBestViews([row({ counted: false })])).toBeNull();
    expect(groupRank({ source: 'kick_vod', snapshot: 'plus_36h', eventShareMethod: 'none', counted: true })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isLateRead', () => {
  const end = at('2026-09-13T19:31:00Z');
  it('YouTube three hours after the stream is a live figure, the catch-up read four days later is not', () => {
    expect(isLateRead('youtube', 'youtube_public', end, at('2026-09-13T22:40:00Z'))).toBe(false);
    expect(isLateRead('youtube', 'youtube_public', end, at('2026-09-17T10:40:00Z'))).toBe(true);
  });
  it('Twitch at 36 hours is the live figure; past three days the replays count', () => {
    expect(isLateRead('twitch', 'twitch_vod', end, at('2026-09-15T07:40:00Z'))).toBe(false);
    expect(isLateRead('twitch', 'twitch_vod', end, at('2026-09-17T10:40:00Z'))).toBe(true);
  });
  it('owner numbers, estimates and streams without an end time are never late', () => {
    expect(isLateRead('tiktok', 'tiktok_livecenter', end, at('2026-09-20T00:00:00Z'))).toBe(false);
    expect(isLateRead('twitch', 'estimate', end, at('2026-09-20T00:00:00Z'))).toBe(false);
    expect(isLateRead('youtube', 'youtube_public', null, at('2026-09-20T00:00:00Z'))).toBe(false);
  });
  it('the best group carries the flag', () => {
    expect(pickBestViews([row({ late: true }), row({ source: 'estimate', snapshot: 'estimate', confidence: 'estimated', eventViews: 5 })])?.late).toBe(true);
    expect(pickBestViews([row({})])?.late).toBe(false);
  });
});

describe('parseSoopBroadNo', () => {
  it('reads the broadcast number out of the replay thumbnail', () => {
    expect(parseSoopBroadNo('//videoimg.sooplive.com/php/SnapshotLoad.php?rowKey=20260916_96BD7129_297164031_6_r')).toBe('297164031');
    expect(parseSoopBroadNo('')).toBeNull();
  });
});

describe('ViewsCollector.duePass', () => {
  const end = at('2026-09-13T19:31:00Z');
  it('nothing in the first three hours', () => {
    expect(ViewsCollector.duePass(end, new Set(), at('2026-09-13T22:00:00Z'))).toBeNull();
  });
  it('the 3-hour pass once, then the 36-hour pass once Twitch has added the live views', () => {
    expect(ViewsCollector.duePass(end, new Set(), at('2026-09-13T22:40:00Z'))).toBe('plus_3h');
    expect(ViewsCollector.duePass(end, new Set(['plus_3h']), at('2026-09-14T10:00:00Z'))).toBeNull();
    expect(ViewsCollector.duePass(end, new Set(['plus_3h']), at('2026-09-15T07:40:00Z'))).toBe('plus_36h');
  });
  it('a day first seen after 36 hours skips straight to the 36-hour pass, and later the 7-day one', () => {
    expect(ViewsCollector.duePass(end, new Set(), at('2026-09-16T12:00:00Z'))).toBe('plus_36h');
    expect(ViewsCollector.duePass(end, new Set(['plus_36h']), at('2026-09-20T19:40:00Z'))).toBe('plus_7d');
    expect(ViewsCollector.duePass(end, new Set(['plus_36h', 'plus_7d']), at('2026-09-21T00:00:00Z'))).toBeNull();
  });
});
