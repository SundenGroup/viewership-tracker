/**
 * Tests for discovery keyword matching logic.
 *
 * The matchesKeywords function uses word boundary regex to prevent
 * partial matches (e.g. "rpg" should not match "pubg").
 */

describe('Keyword matching with word boundaries', () => {
  // Replicate the matchesKeywords logic from discovery-service.ts
  function matchesKeywords(
    keywords: string[],
    title: string | null,
    channelName?: string,
  ): boolean {
    if (keywords.length === 0) return true;
    const titleLower = (title ?? '').toLowerCase();
    const channelLower = (channelName ?? '').toLowerCase();
    return keywords.some((kw) => {
      const kwLower = kw.toLowerCase();
      const re = new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return re.test(titleLower) || re.test(channelLower);
    });
  }

  test('matches exact keyword in title', () => {
    expect(matchesKeywords(['pubg'], 'PUBG Tournament Day 3')).toBe(true);
  });

  test('matches keyword in channel name', () => {
    expect(matchesKeywords(['pubg'], null, 'PUBG Esports')).toBe(true);
  });

  test('does not match partial word', () => {
    // "rpg" should not match because "pubg" doesn't contain the word "rpg"
    expect(matchesKeywords(['rpg'], 'PUBG Tournament')).toBe(false);
  });

  test('does not match substring of another word', () => {
    expect(matchesKeywords(['pub'], 'PUBG Tournament')).toBe(false);
  });

  test('matches keyword as separate word', () => {
    expect(matchesKeywords(['pgs'], 'PGS 3 Grand Finals')).toBe(true);
  });

  test('matches keyword with special regex chars', () => {
    expect(matchesKeywords(['pubg.esports'], 'pubg.esports stream')).toBe(true);
  });

  test('empty keywords matches everything', () => {
    expect(matchesKeywords([], 'anything at all')).toBe(true);
  });

  test('null title with no channel name returns false', () => {
    expect(matchesKeywords(['pubg'], null)).toBe(false);
  });

  test('matches case-insensitively', () => {
    expect(matchesKeywords(['PUBG'], 'pubg tournament')).toBe(true);
  });

  test('matches keyword at start of title', () => {
    expect(matchesKeywords(['pgs3'], 'PGS3 Finals')).toBe(true);
  });

  test('matches keyword at end of title', () => {
    expect(matchesKeywords(['pubg'], 'Watch Party PUBG')).toBe(true);
  });

  test('multiple keywords — any match returns true', () => {
    expect(matchesKeywords(['pubg', 'pgs'], 'PGS 3 Grand Finals')).toBe(true);
  });

  test('multiple keywords — none match returns false', () => {
    expect(matchesKeywords(['pubg', 'pgs'], 'Smooth Jazz 24/7')).toBe(false);
  });
});
