/**
 * Discovery keyword matching.
 *
 * ASCII keywords are matched with word boundaries so a short acronym
 * can't hide inside another word ("rpg" must not match "pubg"). But JS
 * `\b` only exists at [A-Za-z0-9_] transitions — a pure-Hangul keyword
 * like 배틀그라운드 sits between non-word characters on both sides, so
 * `\b배틀그라운드\b` matches NOTHING, ever. Any keyword containing a
 * non-ASCII character therefore falls back to plain substring matching:
 * CJK scripts don't delimit words with spaces anyway, so substring is
 * the correct semantics there, and the false-positive risk that word
 * boundaries exist to prevent is an ASCII-acronym problem.
 *
 * Titles are NFKC-folded before matching: Thai and Korean watch parties
 * style event names in Unicode math-bold (𝐏𝐔𝐁𝐆 𝐆𝐋𝐎𝐁𝐀𝐋 𝐒𝐄𝐑𝐈𝐄𝐒), which
 * plain-ASCII keywords can never hit — nine such channels were invisible
 * to Scout across the whole of PGS7.
 */
export function keywordMatches(
  keywords: string[],
  title: string | null,
  channelName?: string,
): boolean {
  if (keywords.length === 0) return true; // No keywords = accept all
  const titleLower = (title ?? '').normalize('NFKC').toLowerCase();
  const channelLower = (channelName ?? '').normalize('NFKC').toLowerCase();
  return keywords.some((kw) => {
    const kwLower = kw.toLowerCase().trim();
    if (kwLower.length === 0) return false;
    if (/[^\x00-\x7F]/.test(kwLower)) {
      return titleLower.includes(kwLower) || channelLower.includes(kwLower);
    }
    const re = new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(titleLower) || re.test(channelLower);
  });
}
