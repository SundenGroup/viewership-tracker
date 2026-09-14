/**
 * The /live page's video id field can bleed from another page while its
 * viewer count is still the channel's featured stream. For a multi-stream
 * channel whose own live list names exactly one stream, the reading is
 * filed under that stream, never under the bled id (2026-09-14 02:29 UTC:
 * PUBGEsports' last two readings minted "(Stream 3)/(Stream 4)" children
 * under a NASA broadcast id and a Minecraft video id).
 */
import { YouTubeAdapter } from '../../src/adapters/youtube';

type Mutable = Record<string, unknown>;
const ID = 'UCLgYa1O5NodobOaDK6xj5aQ';

function adapter(ownLive: string[]) {
  const a = new YouTubeAdapter() as unknown as Mutable;
  a.resolveIdentifiers = jest.fn(async () => new Map([[ID, ID]]));
  a.scrapeMultipleLiveData = jest.fn(
    async () =>
      new Map([
        [
          ID,
          {
            videoId: 'nfhDuOHMp0A',
            title: 'NASA Artemis II Crew Comes Home',
            channelName: 'PUBG Esports',
            concurrentViewers: 283,
            startedAt: null,
            language: null,
          },
        ],
      ]),
  );
  a.getVideoDetails = jest.fn(async () => []);
  a.scrapeChannelLiveVideoIds = jest.fn(async () => ownLive);
  (a as unknown as YouTubeAdapter).setMultiStreamChannels([ID]);
  return a as unknown as YouTubeAdapter;
}

describe("YouTube adapter: a lone /live reading is filed under the channel's own live stream", () => {
  it('substitutes the own live id when the page named another video', async () => {
    const [s] = await adapter(['6608yoWqQzg']).getViewerCounts([ID]);
    expect(s.isLive).toBe(true);
    expect(s.concurrentViewers).toBe(283);
    expect(s.streamId).toBe('6608yoWqQzg');
    expect(s.title).toBeNull();
  });

  it('keeps the page id when it matches the own live list', async () => {
    const [s] = await adapter(['nfhDuOHMp0A']).getViewerCounts([ID]);
    expect(s.streamId).toBe('nfhDuOHMp0A');
    expect(s.title).toBe('NASA Artemis II Crew Comes Home');
  });

  it('keeps the page id when the own live list is empty (nothing to anchor to)', async () => {
    const [s] = await adapter([]).getViewerCounts([ID]);
    expect(s.streamId).toBe('nfhDuOHMp0A');
  });
});
