/**
 * The view counter of a polled YouTube channel is only kept when the API
 * says the video is the channel's own. The /live page's id field can name
 * any video (field bleed) and videos.list answers for every id: on
 * 2026-09-18 night one watch party's readings carried 80 foreign ids with
 * up to 31M views, and the day's live views came out at 155 million.
 */
import { YouTubeAdapter } from '../../src/adapters/youtube';

type Mutable = Record<string, unknown>;
const OWN = 'UCeKu0eugGl2uKyeUvapuX3w';

function adapter(videoOwner: string) {
  const a = new YouTubeAdapter() as unknown as Mutable;
  a.resolveIdentifiers = jest.fn(async () => new Map([[OWN, OWN]]));
  a.scrapeMultipleLiveData = jest.fn(
    async () => new Map([[OWN, { videoId: 'YZTJN6CZfG0', title: 'some live video', channelName: 'Sonycxtv', concurrentViewers: 18, startedAt: null, language: null }]]),
  );
  a.getVideoDetails = jest.fn(async () => [
    {
      id: 'YZTJN6CZfG0',
      snippet: { channelId: videoOwner, channelTitle: 'x', title: 'some live video' },
      liveStreamingDetails: { concurrentViewers: '18', actualStartTime: '2026-09-18T23:00:00Z' },
      statistics: { viewCount: '31232470' },
    },
  ]);
  a.scrapeChannelLiveVideoIds = jest.fn(async () => []);
  return a as unknown as YouTubeAdapter;
}

describe('YouTube adapter: view counter only for the channel\'s own video', () => {
  it('drops the counter of a video that belongs to another channel', async () => {
    const [snap] = await adapter('UCsomeoneElse00000000000').getViewerCounts([OWN]);
    expect(snap.isLive).toBe(true);
    expect(snap.platformViews).toBeUndefined();
  });
  it('keeps the counter when the API names this channel as the owner', async () => {
    const [snap] = await adapter(OWN).getViewerCounts([OWN]);
    expect(snap.platformViews).toBe(31232470);
  });
});
