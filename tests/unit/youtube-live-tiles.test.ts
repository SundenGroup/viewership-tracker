import { extractLiveTileIds } from '../../src/utils/youtube-live-tiles';

const tile = (id: string, live: boolean, title: string) =>
  `"lockupViewModel":{"contentImage":{"thumbnail":{"sources":[{"url":"https://i.ytimg.com/vi/${id}/hq.jpg"}]},` +
  (live ? `"overlays":[{"thumbnailBadgeViewModel":{"icon":{"sources":[{"clientResource":{"imageName":"LIVE"}}]},"text":"LIVE"}}]` : `"overlays":[{"thumbnailOverlayBadgeViewModel":{"text":"12:34"}}]`) +
  `},"metadata":{"lockupMetadataViewModel":{"title":{"content":"${title}"}}},"rendererContext":{"commandContext":{"onTap":{"innertubeCommand":{"watchEndpoint":{"videoId":"${id}"}}}}}}`;

describe('extractLiveTileIds', () => {
  it('returns one id per live tile, skipping ended videos', () => {
    const html = 'x' + tile('HpnyjsOt01I', true, 'DAY 1') + tile('BMpiMMWNK0o', true, 'B-STREAM') +
      tile('PaiQPmDjXQs', false, 'yesterday') + tile('NlKkqsKr_Vc', true, 'C-STREAM');
    expect(extractLiveTileIds(html)).toEqual(['HpnyjsOt01I', 'BMpiMMWNK0o', 'NlKkqsKr_Vc']);
  });
  it('returns nothing for the old markup so the caller can fall back', () => {
    expect(extractLiveTileIds('"videoRenderer":{"videoId":"HpnyjsOt01I"}')).toEqual([]);
  });
});
