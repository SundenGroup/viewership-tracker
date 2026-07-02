/**
 * Ask · deterministic matcher — no-LLM fast path for the Explore surface.
 *
 * Conservative by design: a question only matches when EVERY significant
 * token is consumed by a small gazetteer (language names, tier words,
 * platform names) or fits one of a handful of rigid patterns. Anything with
 * a leftover token returns null and falls through to the model compiler.
 * This keeps simple filter questions instant — and working even when the
 * Anthropic API is unconfigured or out of credits.
 */

import type { AskViewState, ExploreVocabulary } from './explore';

export interface MatchedIntent {
  name: string;
  input: Record<string, unknown>;
}

// ── Gazetteers ──────────────────────────────────────────────────────────────

/** English language names → base codes (matching buildExploreVocabulary). */
const LANGUAGE_NAMES: Record<string, string> = {
  russian: 'ru',
  turkish: 'tr',
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  portuguese: 'pt',
  brazilian: 'pt',
  korean: 'ko',
  japanese: 'ja',
  vietnamese: 'vi',
  thai: 'th',
  chinese: 'tw',
  taiwanese: 'tw',
  hindi: 'hi',
  indonesian: 'id',
  ukrainian: 'uk',
  polish: 'pl',
  hungarian: 'hu',
  finnish: 'fi',
  swedish: 'sv',
  danish: 'da',
  arabic: 'ar',
  italian: 'it',
  czech: 'cs',
  greek: 'el',
  filipino: 'fil',
  tagalog: 'fil',
  malay: 'ms',
  mongolian: 'mn',
  dutch: 'nl',
  norwegian: 'no',
  romanian: 'ro',
};

/** Tier words → tier ids ("watch party/parties" is handled as a bigram). */
const TIER_WORDS: Record<string, string> = {
  watchparty: 'watch_party',
  watchparties: 'watch_party',
  official: 'official',
  officials: 'official',
  player: 'player',
  players: 'player',
  community: 'community',
  partner: 'partner',
  partners: 'partner',
};

/** Platform words → platform ids (only kept when present in the vocab). */
const PLATFORM_WORDS: Record<string, string> = {
  twitch: 'twitch',
  kick: 'kick',
  youtube: 'youtube',
  tiktok: 'tiktok',
  soop: 'soop',
  chzzk: 'chzzk',
  nimotv: 'nimotv',
  nimo: 'nimotv',
  steam: 'steam',
  trovo: 'trovo',
};

/** Filler words that carry no filter meaning and are safe to drop. */
const STOPWORDS = new Set([
  'show', 'me', 'all', 'the', 'filter', 'filters', 'to', 'only', 'on',
  'channel', 'channels', 'stream', 'streams', 'streamer', 'streamers',
  'please',
]);

const CHANNEL_NOUNS = new Set(['channel', 'channels', 'stream', 'streams', 'streamer', 'streamers']);

// ── Token consumption ───────────────────────────────────────────────────────

interface ConsumedFilters {
  languages: string[];
  tiers: string[];
  platforms: string[];
  /** Total distinct gazetteer hits across all dimensions. */
  hits: number;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Consume every token against the gazetteers (stopwords are skipped).
 * Returns null on the first token nothing understands — the caller falls
 * through to the LLM rather than guessing.
 */
function consumeFilterTokens(tokens: string[], vocab: ExploreVocabulary): ConsumedFilters | null {
  const languages: string[] = [];
  const tiers: string[] = [];
  const platforms: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (STOPWORDS.has(token)) continue;
    // "watch party" / "watch parties" bigram (also covers a raw "watch_party"
    // after punctuation stripping).
    if (token === 'watch' && (tokens[i + 1] === 'party' || tokens[i + 1] === 'parties')) {
      tiers.push('watch_party');
      i += 1;
      continue;
    }
    if (TIER_WORDS[token]) {
      tiers.push(TIER_WORDS[token]);
      continue;
    }
    if (LANGUAGE_NAMES[token]) {
      languages.push(LANGUAGE_NAMES[token]);
      continue;
    }
    const platform = PLATFORM_WORDS[token];
    if (platform && vocab.platforms.includes(platform)) {
      platforms.push(platform);
      continue;
    }
    // Raw 2-3 letter language code, but only ones this series actually has.
    if (/^[a-z]{2,3}$/.test(token) && vocab.languages.includes(token)) {
      languages.push(token);
      continue;
    }
    return null; // leftover token → not fully understood
  }

  const uniqueLanguages = dedupe(languages);
  const uniqueTiers = dedupe(tiers);
  const uniquePlatforms = dedupe(platforms);
  return {
    languages: uniqueLanguages,
    tiers: uniqueTiers,
    platforms: uniquePlatforms,
    hits: uniqueLanguages.length + uniqueTiers.length + uniquePlatforms.length,
  };
}

// ── Matcher ─────────────────────────────────────────────────────────────────

/**
 * Deterministically map a question to an Explore intent, or return null when
 * anything about it is not fully understood (→ LLM compiler path).
 */
export function matchExploreQuestion(
  question: string,
  vocab: ExploreVocabulary,
  _viewState: AskViewState,
): MatchedIntent | null {
  const normalized = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  const tokens = normalized.split(' ');

  // 1. "clear filters" / "reset all the filters"
  if (/^(clear|reset)( all)?( the)? filters?$/.test(normalized)) {
    return { name: 'clear_filters', input: {} };
  }

  // 2. Pure filter combos — "show russian watch parties", "turkish twitch
  //    channels". Every non-stopword token must be a gazetteer hit.
  {
    const consumed = consumeFilterTokens(tokens, vocab);
    if (consumed && consumed.hits > 0) {
      const input: Record<string, unknown> = {};
      if (consumed.languages.length > 0) input.languages = consumed.languages;
      if (consumed.tiers.length > 0) input.tiers = consumed.tiers;
      if (consumed.platforms.length > 0) input.platforms = consumed.platforms;
      return { name: 'set_filters', input };
    }
  }

  // 3. "top N channels" (+ optional language/tier/platform words, same
  //    consume rule; at most one value per dimension — the tool takes one).
  if (tokens[0] === 'top' && /^\d{1,2}$/.test(tokens[1] ?? '')) {
    const n = parseInt(tokens[1], 10);
    if (n >= 1 && n <= 20) {
      const rest = tokens.slice(2);
      const hasChannelNoun = rest.some((t) => CHANNEL_NOUNS.has(t));
      const consumed = consumeFilterTokens(rest, vocab);
      if (
        consumed &&
        (hasChannelNoun || consumed.hits > 0) &&
        consumed.languages.length <= 1 &&
        consumed.tiers.length <= 1 &&
        consumed.platforms.length <= 1
      ) {
        const input: Record<string, unknown> = { n };
        if (consumed.languages.length === 1) input.language = consumed.languages[0];
        if (consumed.tiers.length === 1) input.tier = consumed.tiers[0];
        if (consumed.platforms.length === 1) input.platform = consumed.platforms[0];
        return { name: 'top_channels', input };
      }
    }
    return null;
  }

  // 4. One aggregate number for the current scope — "what was the peak",
  //    "average viewers", "show viewed hours".
  const metricMatch = normalized.match(
    /^(?:what was |what is |what s |whats |show )?(?:the )?(peak|average|avg|watch time|viewed hours)(?: viewers?| ccv)?$/,
  );
  if (metricMatch) {
    const raw = metricMatch[1];
    const metric =
      raw === 'peak' ? 'peak' : raw === 'watch time' || raw === 'viewed hours' ? 'watch_time' : 'average';
    return { name: 'scoped_metric', input: { metric } };
  }

  return null;
}
