/**
 * The explanation behind the live views number: short enough for a
 * question-mark popover, and honest about what is estimated.
 */
import { viewsInfo, type ViewsSplit } from '../../src/services/views-read';

const split = (measured: number, adjusted: number, estimated: number): ViewsSplit => ({
  liveViews: measured + adjusted + estimated,
  measured,
  adjusted,
  estimated,
  channels: { measured: 0, adjusted: 0, estimated: 0 },
});

describe('viewsInfo', () => {
  it('names the platforms that publish no count (PEC Fall Playoffs 1)', () => {
    const info = viewsInfo(
      split(594_549, 57_566, 186_611),
      [
        { platform: 'twitch', ...split(300_000, 50_000, 25_929) },
        { platform: 'tiktok', ...split(0, 0, 87_906) },
        { platform: 'kick', ...split(0, 0, 70_493) },
        { platform: 'steam', ...split(0, 0, 25_331) },
      ],
      0,
    );
    expect(info).toHaveLength(2);
    expect(info[1]).toBe('About 22% is estimated from watch time, because TikTok, Kick and Steam publish no live view count.');
  });
  it('one blind platform reads in the singular', () => {
    const info = viewsInfo(split(900, 0, 100), [{ platform: 'twitch', ...split(900, 0, 0) }, { platform: 'tiktok', ...split(0, 0, 100) }], 0);
    expect(info[1]).toBe('About 10% is estimated from watch time, because TikTok publishes no live view count.');
  });
  it('estimates on a platform that does publish counts are a missing channel, not a blind platform', () => {
    const info = viewsInfo(split(900, 0, 100), [{ platform: 'twitch', ...split(900, 0, 100) }], 0);
    expect(info[1]).toBe("About 10% is estimated from watch time where a channel's count was not available.");
  });
  it('late reads add one sentence, fully measured scopes stay at one', () => {
    expect(viewsInfo(split(1000, 0, 0), [{ platform: 'twitch', ...split(1000, 0, 0) }], 0)).toHaveLength(1);
    expect(viewsInfo(split(1000, 0, 0), [{ platform: 'twitch', ...split(1000, 0, 0) }], 3)[1]).toBe(
      'Some counts were read days after the broadcast, so they include replay views.',
    );
  });
  it('nothing to explain without views', () => {
    expect(viewsInfo(split(0, 0, 0), [], 0)).toEqual([]);
  });
});
