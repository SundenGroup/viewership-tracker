/**
 * Language-code normalization for channel rows.
 *
 * Every rollup (dashboard breakdowns, reports, per-language peaks) GROUPs
 * BY the raw language string, so two spellings of the same language
 * silently split it into separate buckets. This happened on PNC2026:
 * live Ukrainian watch parties were tagged 'uk' while idle player
 * channels carried 'ua' — a per-language peak query that looked at 'ua'
 * reported zero Ukrainian viewership.
 *
 * normalizeLanguageCode():
 *   - trims, lowercases, strips region subtags (en-US → en)
 *   - maps common country-code-for-language mistakes to ISO 639-1
 *     (ua→uk, jp→ja, kr→ko, …)
 *   - preserves house conventions that are intentionally NOT ISO 639-1:
 *     'tw' (Taiwanese-Mandarin bucket) and 'fil' (Filipino).
 *
 * Applied at every channel write path (create / bulk / update / discovery)
 * so codes are canonical at rest. scripts/check-language-codes.ts reports
 * rows that predate this.
 */

const ALIASES: Record<string, string> = {
  ua: 'uk', // Ukraine → Ukrainian
  jp: 'ja', // Japan → Japanese
  kr: 'ko', // Korea → Korean
  cz: 'cs', // Czechia → Czech
  dk: 'da', // Denmark → Danish
  se: 'sv', // Sweden → Swedish
  gr: 'el', // Greece → Greek
  vn: 'vi', // Vietnam → Vietnamese
};

/** House codes that must never be "corrected". */
const KEEP_AS_IS = new Set(['tw', 'fil']);

export function normalizeLanguageCode(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let code = raw.trim().toLowerCase();
  if (!code) return null;
  if (KEEP_AS_IS.has(code)) return code;
  code = code.split(/[-_]/)[0] ?? code;
  if (KEEP_AS_IS.has(code)) return code;
  return ALIASES[code] ?? code;
}
