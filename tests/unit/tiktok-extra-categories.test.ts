/**
 * Neighbouring TikTok categories read from a tracker's metadata.
 */
import { tiktokExtraCategories } from '../../src/utils/tiktok-extra-categories';

describe('tiktokExtraCategories', () => {
  it('reads the list from an object or from stored JSON text', () => {
    const meta = { tiktok_extra_categories: ['gaming/Grand_Theft_Auto_V'] };
    expect(tiktokExtraCategories(meta)).toEqual(['gaming/Grand_Theft_Auto_V']);
    expect(tiktokExtraCategories(JSON.stringify(meta))).toEqual(['gaming/Grand_Theft_Auto_V']);
  });

  it('drops anything that is not a category path, and repeats', () => {
    const meta = {
      tiktok_extra_categories: [' gaming/PUBG:_BATTLEGROUNDS ', 'gaming/PUBG:_BATTLEGROUNDS', 'a b', '../x?y=1', 7, null, ''],
    };
    expect(tiktokExtraCategories(meta)).toEqual(['gaming/PUBG:_BATTLEGROUNDS']);
  });

  it('returns nothing when the key is missing or the metadata is unreadable', () => {
    expect(tiktokExtraCategories({ bound_series_id: 'x' })).toEqual([]);
    expect(tiktokExtraCategories(null)).toEqual([]);
    expect(tiktokExtraCategories('not json')).toEqual([]);
    expect(tiktokExtraCategories({ tiktok_extra_categories: 'gaming/X' })).toEqual([]);
  });
});
