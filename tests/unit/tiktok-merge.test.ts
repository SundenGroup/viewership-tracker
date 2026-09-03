import { StaleSourceTracker, normalizeSource, shouldReplace, sourceRank } from '../../src/utils/tiktok-merge';

describe('TikTok source ranking', () => {
  it('ranks live sockets above page fetches above DOM fallbacks; untagged relays count as page scrapes', () => {
    expect(sourceRank('browser-ws')).toBeGreaterThan(sourceRank('server-page'));
    expect(sourceRank('server-page')).toBe(sourceRank('page-scrape'));
    expect(sourceRank('unknown')).toBe(sourceRank('page-scrape'));
    expect(sourceRank('browser-dom')).toBeLessThan(sourceRank('page-scrape'));
    expect(normalizeSource('Page-Scrape')).toBe('page-scrape');
    expect(normalizeSource(undefined)).toBe('unknown');
  });

  it('a DOM reading never replaces a page reading, whatever its size', () => {
    expect(shouldReplace({ value: 150, source: 'page-scrape' }, { value: 728, source: 'browser-dom' })).toBe(false);
    expect(shouldReplace({ value: 728, source: 'browser-dom' }, { value: 150, source: 'server-page' })).toBe(true);
  });

  it('equal ranks keep the larger value, as before', () => {
    expect(shouldReplace({ value: 150, source: 'page-scrape' }, { value: 152, source: 'server-page' })).toBe(true);
    expect(shouldReplace({ value: 152, source: 'page-scrape' }, { value: 150, source: 'server-page' })).toBe(false);
    expect(shouldReplace({ value: 150, source: null }, { value: 151, source: 'page-scrape' })).toBe(true);
  });
});

describe('StaleSourceTracker', () => {
  const minute = (i: number) => i * 60_000;

  it('flags a source repeating one value for five minutes while another source moves', () => {
    const t = new StaleSourceTracker();
    let verdict = { stale: false, repeats: 0 };
    for (let i = 0; i < 5; i++) {
      t.observe('geoguessr', 'page-scrape', 300 + i, minute(i), minute(i) + 10);
      verdict = t.observe('geoguessr', 'browser-dom', 728, minute(i), minute(i) + 20);
    }
    expect(verdict.repeats).toBe(5);
    expect(verdict.stale).toBe(true);
  });

  it('does not flag a repeated value when no other source disagrees', () => {
    const t = new StaleSourceTracker();
    let verdict = { stale: false, repeats: 0 };
    for (let i = 0; i < 8; i++) verdict = t.observe('room', 'page-scrape', 42, minute(i), minute(i) + 5);
    expect(verdict.stale).toBe(false);
  });

  it('resets the count when the value changes', () => {
    const t = new StaleSourceTracker();
    for (let i = 0; i < 4; i++) t.observe('room', 'browser-dom', 728, minute(i), minute(i) + 5);
    const v = t.observe('room', 'browser-dom', 730, minute(4), minute(4) + 5);
    expect(v.repeats).toBe(1);
  });
});
