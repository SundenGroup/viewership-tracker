/**
 * Keyword matcher — cases replayed from real PGS7 titles, including the
 * Unicode math-bold styling Thai/Korean watch parties use, which made
 * nine channels invisible to Scout for the whole event.
 */
import { keywordMatches } from '../../src/utils/keyword-match';

const KW = ['PGS', 'PGS7', 'PGS8', 'PGS9', 'pubg global series', 'pubg global'];

describe('keywordMatches', () => {
  it('matches the plain variants every language actually used', () => {
    expect(keywordMatches(KW, 'PGS7 | Winner Stage')).toBe(true);
    expect(keywordMatches(KW, '2026 PGS 7 파이널 DAY 2 한국팀 응원방')).toBe(true);
    expect(keywordMatches(KW, 'PGS 7 | FINAL STAGE  DAY 2')).toBe(true);
    expect(keywordMatches(KW, 'Hanh trinh pgs ngay 1')).toBe(true);
    expect(keywordMatches(KW, '#เชื่อชล นั่งเชียร์ทีมไทย 4 ทีม PGS7 #5')).toBe(true);
    expect(keywordMatches(KW, 'PUBG Global Series 7 - Fase Final Dia 1')).toBe(true);
  });

  it('folds Unicode math-bold titles to ASCII (the PGS7 blind spot)', () => {
    expect(
      keywordMatches(KW, '🔴LIVE สด! 𝐏𝐔𝐁𝐆 𝐆𝐋𝐎𝐁𝐀𝐋 𝐒𝐄𝐑𝐈𝐄𝐒 𝟐𝟎𝟐𝟔 𝐂𝐈𝐑𝐂𝐔𝐈𝐓 𝟑 𝐒𝐄𝐑𝐈𝐄𝐒 𝟕 | 𝑊𝐼𝑁𝑁𝐸𝑅𝑆 𝑆𝑇𝐴𝐺𝐸'),
    ).toBe(true);
    expect(keywordMatches(KW, '𝐏𝐔𝐁𝐆 𝐆𝐋𝐎𝐁𝐀𝐋 𝐒𝐄𝐑𝐈𝐄𝐒 𝟐𝟎𝟐𝟔 𝐂𝐈𝐑𝐂𝐔𝐈𝐓 𝟑 𝐒𝐄𝐑𝐈𝐄𝐒')).toBe(true);
    expect(keywordMatches(KW, 'ＰＧＳ８ ウォッチパーティー')).toBe(true);
  });

  it('keeps word boundaries — acronyms cannot hide inside other words', () => {
    expect(keywordMatches(KW, 'VODS AND STREAMS | RPGS | REPLAYS')).toBe(false);
    expect(keywordMatches(KW, 'speedrunning JRPGS all night')).toBe(false);
  });

  it('still substring-matches non-ASCII keywords', () => {
    expect(keywordMatches(['배틀그라운드'], '배틀그라운드 이스포츠 중계')).toBe(true);
  });
});
