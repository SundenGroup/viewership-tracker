/**
 * Neighbouring TikTok categories read from a tracker's metadata.
 */
import { tiktokExtraCategories, tiktokExtraRule, tiktokWideSweep } from '../../src/utils/tiktok-extra-categories';
import { titleExcluded, titleNamesGame } from '../../src/services/youtube-game-tracker';

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

describe('tiktokExtraRule', () => {
  it('defaults to counting only rooms that name the game', () => {
    expect(tiktokExtraRule({})).toBe('named');
    expect(tiktokExtraRule(null)).toBe('named');
    expect(tiktokExtraRule({ tiktok_extra_rule: 'everything' })).toBe('named');
  });
  it('reads the wider rule from an object or stored JSON text', () => {
    expect(tiktokExtraRule({ tiktok_extra_rule: 'all_but_excluded' })).toBe('all_but_excluded');
    expect(tiktokExtraRule(JSON.stringify({ tiktok_extra_rule: 'all_but_excluded' }))).toBe('all_but_excluded');
  });
});

describe('rooms of the GTA V category on GTA VI launch day', () => {
  // Titles as TikTok's feed gave them on 2026-11-18.
  const cfg = { strongPhrases: ['gta 6', 'gta vi', 'vice city'], exclude: ['gta 5', 'gta v ', 'fivem'] };
  const counted = (title: string) => !titleExcluded(title, cfg);

  it('counts rooms whose title names no game at all', () => {
    for (const title of ['Lets Go LIVE!', 'Te doy la bienvenida a mi LIVE', 'เจ้าเก่า', 'ON', '']) {
      expect(counted(title)).toBe(true);
      expect(titleNamesGame(title, cfg)).toBe(false); // the old rule left them out
    }
  });
  it('counts a misspelt GTA VI title the vocabulary would miss', () => {
    expect(counted('🛬FLYING INTO VISE CITY GET HEA')).toBe(true);
  });
  it('leaves out a title that ends in the other game, and never mistakes VI for V', () => {
    expect(counted('Playing GTA V')).toBe(false);
    expect(counted('GTA V')).toBe(false);
    expect(counted('GTA VI')).toBe(true);
    expect(counted('Playing GTA VI')).toBe(true);
  });
  it('still leaves out rooms whose title names GTA 5', () => {
    expect(counted('GTA V MOD DE POLIA')).toBe(false);
    expect(counted('FiveM Unive Roleplay')).toBe(false);
    expect(counted('GTA 6 LAUNCH DAY+ BYE GTA 5')).toBe(false);
  });
});

describe('tiktokWideSweep', () => {
  it('is on only for an explicit true', () => {
    expect(tiktokWideSweep({ tiktok_wide_sweep: true })).toBe(true);
    expect(tiktokWideSweep(JSON.stringify({ tiktok_wide_sweep: true }))).toBe(true);
    expect(tiktokWideSweep({ tiktok_wide_sweep: 'true' })).toBe(false);
    expect(tiktokWideSweep({})).toBe(false);
    expect(tiktokWideSweep('not json')).toBe(false);
  });
});
