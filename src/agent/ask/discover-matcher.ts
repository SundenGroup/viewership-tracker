/**
 * Ask · deterministic matcher — no-LLM fast path for the Discover surface.
 *
 * Same philosophy as matcher.ts (Explore): a question only matches when
 * EVERY significant token is consumed by a rigid pattern, a small gazetteer
 * (language names, platform names, metric words) or a recognized range
 * phrase ("in may", "this week", "today"). Anything with a leftover token
 * returns null and falls through to the model compiler. This keeps the
 * common leaderboard questions instant — and working with no API key.
 */

import type { MatchedIntent } from './matcher';
import { LANGUAGE_NAMES, PLATFORM_WORDS } from './matcher';
import type { DiscoverVocabulary, RangePreset } from './discover';

// ── Gazetteers ──────────────────────────────────────────────────────────────

/** Metric words after "by …" → tool metric ids. */
const METRIC_WORDS: Record<string, 'peak' | 'hours' | 'messages' | 'chatters'> = {
  viewers: 'peak',
  viewership: 'peak',
  peak: 'peak',
  ccv: 'peak',
  hours: 'hours',
  watchtime: 'hours',
  messages: 'messages',
  chat: 'messages',
  chats: 'messages',
  chatters: 'chatters',
};

const CHANNEL_NOUNS = new Set(['channel', 'channels', 'stream', 'streams', 'streamer', 'streamers']);

/** Filler words that carry no meaning here and are safe to drop. */
const STOPWORDS = new Set([
  'show', 'me', 'all', 'the', 'a', 'an', 'please', 'only', 'on',
  'was', 'is', 'what', 'which', 'who',
]);

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

// ── Range-phrase consumption ────────────────────────────────────────────────

export interface MatchedRange {
  preset: RangePreset;
  month?: string;
}

/**
 * Try to consume a range phrase starting at tokens[i]. Returns the number of
 * tokens consumed and the parsed range, or null when tokens[i] does not
 * start a range phrase. Recognized forms:
 *   today | this week | this month | last month |
 *   (in|of|for) <monthname> [<yyyy>] | <monthname> [<yyyy>]
 */
function consumeRangePhrase(
  tokens: string[],
  i: number,
  now: Date,
): { consumed: number; range: MatchedRange } | null {
  const t = tokens[i];

  if (t === 'today') return { consumed: 1, range: { preset: 'today' } };
  if (t === 'this' && tokens[i + 1] === 'week') return { consumed: 2, range: { preset: '7d' } };
  if (t === 'this' && tokens[i + 1] === 'month') {
    return { consumed: 2, range: { preset: 'month', month: ymOf(now.getUTCFullYear(), now.getUTCMonth() + 1) } };
  }
  if (t === 'last' && tokens[i + 1] === 'month') {
    const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
    return { consumed: 2, range: { preset: 'month', month: ymOf(y, m) } };
  }

  // (in|of|for)? <monthname> [<yyyy>]
  let j = i;
  if (t === 'in' || t === 'of' || t === 'for') j += 1;
  const monthNum = MONTH_NAMES[tokens[j] ?? ''];
  if (!monthNum) return null;
  let year: number | null = null;
  if (/^(19|20)\d{2}$/.test(tokens[j + 1] ?? '')) {
    year = parseInt(tokens[j + 1], 10);
    j += 1;
  }
  if (year === null) {
    // No year → the most recent occurrence of that month not in the future.
    year = monthNum > now.getUTCMonth() + 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  }
  return { consumed: j + 1 - i, range: { preset: 'month', month: ymOf(year, monthNum) } };
}

function ymOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ── Qualifier consumption (language / platform / metric / range) ───────────

interface ConsumedQualifiers {
  language: string | null;
  platform: string | null;
  metric: 'peak' | 'hours' | 'messages' | 'chatters' | null;
  range: MatchedRange | null;
  hasChannelNoun: boolean;
}

/**
 * Consume every token as a channel noun, stopword, language, platform,
 * "by <metric>" pair, or range phrase. Returns null on the first token
 * nothing understands, or when a dimension is specified twice — the caller
 * falls through to the LLM rather than guessing.
 */
function consumeQualifiers(
  tokens: string[],
  vocab: DiscoverVocabulary,
  now: Date,
): ConsumedQualifiers | null {
  const out: ConsumedQualifiers = {
    language: null,
    platform: null,
    metric: null,
    range: null,
    hasChannelNoun: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (STOPWORDS.has(token)) continue;
    if (CHANNEL_NOUNS.has(token)) {
      out.hasChannelNoun = true;
      continue;
    }
    // "by <metric>" — "by viewers", "by chat", "by watch time". A "by"
    // followed by anything else is ambiguous → bail to the LLM.
    if (token === 'by') {
      if (out.metric) return null;
      if (tokens[i + 1] === 'watch' && tokens[i + 2] === 'time') {
        out.metric = 'hours';
        i += 2;
        continue;
      }
      const metric = METRIC_WORDS[tokens[i + 1] ?? ''];
      if (!metric) return null;
      out.metric = metric;
      i += 1;
      continue;
    }
    const range = consumeRangePhrase(tokens, i, now);
    if (range) {
      if (out.range) return null;
      out.range = range.range;
      i += range.consumed - 1;
      continue;
    }
    if (LANGUAGE_NAMES[token]) {
      if (out.language) return null;
      out.language = LANGUAGE_NAMES[token];
      continue;
    }
    const platform = PLATFORM_WORDS[token];
    if (platform && vocab.platforms.includes(platform)) {
      if (out.platform) return null;
      out.platform = platform;
      continue;
    }
    // Raw 2-3 letter language code, but only ones this tracker actually has.
    if (/^[a-z]{2,3}$/.test(token) && vocab.languages.includes(token)) {
      if (out.language) return null;
      out.language = token;
      continue;
    }
    return null; // leftover token → not fully understood
  }
  return out;
}

// ── Matcher ─────────────────────────────────────────────────────────────────

/**
 * Deterministically map a question to a Discover intent, or return null when
 * anything about it is not fully understood (→ LLM compiler path).
 */
export function matchDiscoverQuestion(
  question: string,
  vocab: DiscoverVocabulary,
  now = new Date(),
): MatchedIntent | null {
  const normalized = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  const tokens = normalized.split(' ');

  // 1. "who is trending" / "whats trending (now|today)" / "trending this week"
  {
    const m = normalized.match(
      /^(?:(?:who|what)(?:s| s| is)? )?trending(?: right now| now| today| this week)?$/,
    );
    if (m) {
      const hours = normalized.endsWith('this week') ? 168 : 24;
      return { name: 'trending', input: { hours } };
    }
  }

  // 2. "most chatted( streamer)?( in may( 2026)?)?"
  if (tokens[0] === 'most' && tokens[1] === 'chatted') {
    const rest = tokens.slice(2);
    const consumed = consumeQualifiers(rest, vocab, now);
    // most_chatted takes only a range — language/platform/metric leftovers
    // fall through to the LLM (top_channels can express them).
    if (consumed && !consumed.language && !consumed.platform && !consumed.metric) {
      const input: Record<string, unknown> = {};
      if (consumed.range) input.range = consumed.range;
      return { name: 'most_chatted', input };
    }
    return null;
  }

  // 3. "biggest stream( this week| in <month> <year>| today)?"
  if (/^(biggest|largest|best|top) stream$/.test(`${tokens[0]} ${tokens[1] ?? ''}`)) {
    const rest = tokens.slice(2);
    if (rest.length === 0) return { name: 'biggest_stream', input: {} };
    const range = consumeRangePhrase(rest, 0, now);
    if (range && range.consumed === rest.length) {
      return { name: 'biggest_stream', input: { range: range.range } };
    }
    return null;
  }

  // 4. "top N (channels|streamers)( by <metric>)?( <language|platform>)?( in <month>)?"
  if (tokens[0] === 'top' && /^\d{1,2}$/.test(tokens[1] ?? '')) {
    const n = parseInt(tokens[1], 10);
    if (n >= 1 && n <= 20) {
      const rest = tokens.slice(2);
      const consumed = consumeQualifiers(rest, vocab, now);
      if (consumed && (consumed.hasChannelNoun || consumed.language || consumed.platform)) {
        const input: Record<string, unknown> = { limit: n };
        if (consumed.metric) input.metric = consumed.metric;
        if (consumed.language) input.language = consumed.language;
        if (consumed.platform) input.platform = consumed.platform;
        if (consumed.range) input.range = consumed.range;
        return { name: 'top_channels', input };
      }
    }
    return null;
  }

  return null;
}
