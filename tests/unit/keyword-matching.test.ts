/**
 * Tests for discovery keyword matching logic.
 *
 * ASCII keywords use word-boundary regex to prevent partial matches
 * ("rpg" must not match "pubg"). Non-ASCII keywords (Hangul etc.) use
 * substring matching, because JS \b does not exist between non-ASCII
 * characters — a pure-Hangul keyword under \b matched nothing, ever.
 */
import { keywordMatches as matchesKeywords } from '../../src/utils/keyword-match';

describe('Keyword matching with word boundaries', () => {

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

  // ── Hangul / non-ASCII keywords (substring semantics) ────────────────
  // These four are the cases the old \b implementation silently failed.

  test('Hangul keyword matches inside a Korean title', () => {
    expect(matchesKeywords(['배틀그라운드'], 'PGS7 배틀그라운드 공식 중계')).toBe(true);
  });

  test('Hangul keyword matches with no surrounding spaces', () => {
    expect(matchesKeywords(['배그'], '오늘도배그한판!')).toBe(true);
  });

  test('Hangul keyword matches in channel name', () => {
    expect(matchesKeywords(['배틀그라운드'], null, 'PUBG 배틀그라운드 코리아')).toBe(true);
  });

  test('Hangul keyword absent returns false', () => {
    expect(matchesKeywords(['배틀그라운드'], '리그 오브 레전드 랭크')).toBe(false);
  });

  test('mixed-script keyword uses substring matching', () => {
    expect(matchesKeywords(['pgs 배그'], 'PGS 배그 그랜드파이널')).toBe(true);
  });

  test('ASCII keywords keep word-boundary strictness alongside Hangul ones', () => {
    expect(matchesKeywords(['rpg', '배틀그라운드'], 'PUBG Tournament')).toBe(false);
  });
});
