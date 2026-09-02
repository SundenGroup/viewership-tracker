/**
 * Ask · Discover surface — vocabulary builder, intent catalog, executor.
 *
 * Mirrors the Explore surface (see explore.ts) for game-tracker pages
 * (/discover/:slug). The model NEVER computes numbers: it picks exactly one
 * intent from the closed catalog below and fills parameters from this
 * tracker's real vocabulary (languages/platforms seen in snapshots, top
 * channels from stored stream sessions). The server resolves the time range,
 * runs the aggregation against Postgres, and answers with either an `answer`
 * envelope (optionally carrying a deep link into the dashboard) or a
 * `refusal`. No URL patches in v1 — the Discover page has no patchable
 * chart state the way Explore does.
 */

import type Anthropic from '@anthropic-ai/sdk';
import db from '../../utils/db';
import type { GameTracker } from '../../models/game-tracker';
import type { AskBlock } from './explore';

// ── Envelope types ──────────────────────────────────────────────────────────

export interface DiscoverDeepLink {
  label: string;
  href: string;
}

export type DiscoverAskEnvelope =
  | {
      kind: 'answer';
      headline: string;
      blocks: AskBlock[];
      resolvedIntent: string[];
      /** Optional jump into the dashboard ("Open in Channels tab"). */
      deepLink?: DiscoverDeepLink;
      /** Data-honesty note rendered in the card footer. */
      footnote?: string;
    }
  | { kind: 'refusal'; message: string; suggestions: string[]; resolvedIntent: string[] };

/** URL params the Discover page sends as its current view state. */
export interface DiscoverAskViewState {
  tab?: string;
  platform?: string;
  language?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** stream_sessions chat finals exist only from this date (migration date). */
const CHAT_METRICS_SINCE = new Date('2026-07-09T00:00:00Z');
const CHAT_FOOTNOTE = 'chat metrics collected from 2026-07-09';

const MAX_RANGE_DAYS = 92;
const VOCAB_WINDOW_DAYS = 90;
const VOCAB_CHANNEL_LIMIT = 200;

const METRIC_LABELS: Record<string, string> = {
  peak: 'peak CCV',
  hours: 'viewed hours',
  messages: 'chat messages',
  chatters: 'unique chatters',
};

// ── Vocabulary ──────────────────────────────────────────────────────────────

export interface DiscoverVocabulary {
  /** Base language codes seen in snapshots in the last 90d (lowercase). */
  languages: string[];
  /** Platforms seen in snapshots in the last 90d (lowercase). */
  platforms: string[];
  /** Top channels by recent session peak — the only ids the model may pick. */
  channels: Array<{ id: string; identifier: string; name: string; platform: string }>;
  /** Oldest snapshot for this tracker — ranges are clamped to it. */
  firstSnapshotAt: Date | null;
}

/** Base language code ('ru-RU' → 'ru'), matching the Explore semantics. */
function baseLang(lang: string | null | undefined): string | null {
  const trimmed = (lang ?? '').trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.split('-')[0] || null;
}

/**
 * Fetch the per-tracker vocabulary the model is allowed to fill parameters
 * from: dimension values actually seen in game_tracker_snapshots (90d, one
 * grouped scan) + the top 200 streamers by session peak (grouped by streamer
 * identity, matching the Channels tab dedup) + the first-snapshot clamp.
 */
export async function buildDiscoverVocabulary(tracker: GameTracker): Promise<DiscoverVocabulary> {
  const [dims, channels, first] = await Promise.all([
    db.raw<{ rows: Array<{ language: string | null; platform: string | null }> }>(
      `
      SELECT LOWER(split_part(language, '-', 1)) AS language, LOWER(platform) AS platform
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ?
        AND "timestamp" >= now() - interval '${VOCAB_WINDOW_DAYS} days'
      GROUP BY 1, 2
      `,
      [tracker.id],
    ),
    db.raw<{
      rows: Array<{ id: string; identifier: string; name: string; platform: string }>;
    }>(
      `
      SELECT
        (array_agg(s.channel_id ORDER BY s.peak_ccv DESC))[1] AS id,
        (array_agg(c.channel_identifier ORDER BY s.peak_ccv DESC))[1] AS identifier,
        (array_agg(c.display_name ORDER BY s.peak_ccv DESC))[1] AS name,
        c.platform,
        MAX(s.peak_ccv) AS peak
      FROM stream_sessions s
      JOIN channels c ON c.id = s.channel_id
      WHERE s.game_tracker_id = ?
        AND s.started_at >= now() - interval '${VOCAB_WINDOW_DAYS} days'
      GROUP BY c.platform, LOWER(c.channel_identifier)
      ORDER BY peak DESC
      LIMIT ${VOCAB_CHANNEL_LIMIT}
      `,
      [tracker.id],
    ),
    db.raw<{ rows: Array<{ first: Date | null }> }>(
      `SELECT MIN("timestamp") AS first FROM game_tracker_snapshots WHERE game_tracker_id = ?`,
      [tracker.id],
    ),
  ]);

  const languages = new Set<string>();
  const platforms = new Set<string>();
  for (const d of dims.rows) {
    const lang = baseLang(d.language);
    if (lang) languages.add(lang);
    if (d.platform) platforms.add(d.platform);
  }

  const firstRaw = first.rows[0]?.first;
  return {
    languages: Array.from(languages).sort(),
    platforms: Array.from(platforms).sort(),
    channels: channels.rows.map((c) => ({
      id: c.id,
      identifier: c.identifier,
      name: c.name,
      platform: c.platform,
    })),
    firstSnapshotAt: firstRaw ? new Date(firstRaw) : null,
  };
}

/** Compact text rendering of the vocabulary + current view for the model. */
export function renderDiscoverAskContext(
  tracker: GameTracker,
  vocab: DiscoverVocabulary,
  viewState: DiscoverAskViewState,
): string {
  const lines: string[] = [];
  lines.push(`GAME TRACKER: ${tracker.name} (all times UTC)`);
  lines.push(
    `DATA: streams tracked since ${vocab.firstSnapshotAt ? isoDate(vocab.firstSnapshotAt) : '(no data yet)'}; ` +
      `chat metrics (messages/chatters) collected from ${isoDate(CHAT_METRICS_SINCE)}.`,
  );
  lines.push(`LANGUAGES: ${vocab.languages.join(', ') || '(none)'}`);
  lines.push(`PLATFORMS: ${vocab.platforms.join(', ') || '(none)'}`);
  lines.push('CHANNELS (id | identifier | name | platform):');
  for (const c of vocab.channels) {
    lines.push(`${c.id} | ${c.identifier} | ${c.name} | ${c.platform}`);
  }

  const view: string[] = [`tab=${viewState.tab || 'live'}`];
  if (viewState.platform) view.push(`platform=${viewState.platform}`);
  if (viewState.language) view.push(`language=${viewState.language}`);
  lines.push(`CURRENT VIEW: ${view.join(', ')}`);
  return lines.join('\n');
}

// ── Range resolution ────────────────────────────────────────────────────────

export type RangePreset = 'today' | '24h' | '7d' | '30d' | 'month';
const RANGE_PRESETS: RangePreset[] = ['today', '24h', '7d', '30d', 'month'];

export interface ResolvedRange {
  from: Date;
  to: Date;
  label: string;
  preset: RangePreset;
  /** Set when `from` was pulled forward to the tracker's first snapshot. */
  clampedToFirstSnapshot: boolean;
  /** 'YYYY-MM' for the month preset (deep links). */
  month?: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map((v) => parseInt(v, 10));
  return `${MONTH_LABELS[m - 1]} ${y}`;
}

/**
 * Resolve a raw `range` parameter (model- or matcher-provided; never
 * trusted) into a concrete UTC window. Presets are UTC; `month` is a UTC
 * calendar month; every range is clamped to ≤92 days and not before the
 * tracker's first snapshot. Returns an error string for unusable input.
 */
export function resolveRange(
  raw: unknown,
  firstSnapshotAt: Date | null,
  now = new Date(),
): ResolvedRange | { error: string } {
  let preset: RangePreset = '7d';
  let monthStr: string | undefined;

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'I could not read that time range.' };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.month === 'string' && r.month.trim()) monthStr = r.month.trim();
    if (r.preset !== undefined) {
      if (typeof r.preset !== 'string' || !RANGE_PRESETS.includes(r.preset as RangePreset)) {
        return { error: 'I could not read that time range.' };
      }
      preset = r.preset as RangePreset;
    } else if (monthStr) {
      preset = 'month';
    }
  }

  let from: Date;
  let to: Date;
  let label: string;
  let month: string | undefined;

  if (preset === 'month') {
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      return { error: 'Tell me which month as a calendar month (e.g. "May 2026").' };
    }
    const [y, m] = monthStr.split('-').map((v) => parseInt(v, 10));
    if (m < 1 || m > 12 || y < 2000 || y > 2100) {
      return { error: 'I could not read that month.' };
    }
    from = new Date(Date.UTC(y, m - 1, 1));
    if (from.getTime() > now.getTime()) {
      return { error: `${monthLabel(monthStr)} is in the future.` };
    }
    const monthEnd = new Date(Date.UTC(y, m, 1));
    to = monthEnd.getTime() < now.getTime() ? monthEnd : now;
    label = monthLabel(monthStr);
    month = monthStr;
  } else if (preset === 'today') {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    to = now;
    label = 'today (UTC)';
  } else {
    const hours = preset === '24h' ? 24 : preset === '7d' ? 24 * 7 : 24 * 30;
    from = new Date(now.getTime() - hours * 3_600_000);
    to = now;
    label = preset === '24h' ? 'last 24 hours' : preset === '7d' ? 'last 7 days' : 'last 30 days';
  }

  // Belt-and-braces: no current preset exceeds 92 days, but future ones must
  // not silently open unbounded scans.
  const maxMs = MAX_RANGE_DAYS * 24 * 3_600_000;
  if (to.getTime() - from.getTime() > maxMs) {
    from = new Date(to.getTime() - maxMs);
  }

  let clampedToFirstSnapshot = false;
  if (firstSnapshotAt && from.getTime() < firstSnapshotAt.getTime()) {
    from = firstSnapshotAt;
    clampedToFirstSnapshot = true;
  }

  return { from, to, label, preset, clampedToFirstSnapshot, month };
}

// ── Intent catalog (tools) ──────────────────────────────────────────────────

/** Only add `enum` when the list is non-empty — empty enums are invalid. */
function enumProp(description: string, values: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = { type: 'string', description };
  if (values.length > 0) p.enum = values;
  return p;
}

/** Shared `range` sub-schema. The server re-validates via resolveRange(). */
const RANGE_PROP = {
  type: 'object',
  description:
    'Time range (UTC). Omit for the default (last 7 days). For a calendar ' +
    "month use preset 'month' plus month as 'YYYY-MM'.",
  properties: {
    preset: { type: 'string', enum: ['today', '24h', '7d', '30d', 'month'] },
    month: { type: 'string', description: "Calendar month 'YYYY-MM', only with preset 'month'" },
  },
  required: ['preset'],
} as const;

/**
 * Build the closed intent catalog with this tracker's vocabulary injected as
 * enums. Plain JSON-schema tools (no `strict` field) — the compiler validates
 * top-level shapes and the executor re-validates everything (ranges, ids).
 */
export function buildDiscoverTools(vocab: DiscoverVocabulary): Anthropic.Tool[] {
  return [
    {
      name: 'top_channels',
      description:
        'Rank channels/streamers of this game in a time range by one metric and answer with a table. ' +
        'Metrics: peak = highest concurrent viewers, hours = total viewed hours, ' +
        'messages = chat messages, chatters = unique chatters.',
      input_schema: {
        type: 'object',
        properties: {
          range: RANGE_PROP as unknown as Record<string, unknown>,
          metric: {
            type: 'string',
            description: 'Ranking metric (default peak)',
            enum: ['peak', 'hours', 'messages', 'chatters'],
          },
          language: enumProp('Only channels of this language', vocab.languages),
          platform: enumProp('Only channels on this platform', vocab.platforms),
          limit: { type: 'integer', description: 'How many channels (1-20, default 10)', minimum: 1, maximum: 20 },
        },
        required: [],
      },
    },
    {
      name: 'biggest_stream',
      description:
        'The single biggest individual stream (one broadcast) in the range, by peak viewers or viewed hours.',
      input_schema: {
        type: 'object',
        properties: {
          range: RANGE_PROP as unknown as Record<string, unknown>,
          metric: { type: 'string', description: 'default peak', enum: ['peak', 'hours'] },
        },
        required: [],
      },
    },
    {
      name: 'channel_stat',
      description:
        "One channel's aggregate stats in the range: peak viewers, viewed hours, chat messages, number of streams. " +
        'channel_id MUST be an id from CHANNELS.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel id from CHANNELS' },
          range: RANGE_PROP as unknown as Record<string, unknown>,
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'trending',
      description:
        'Channels rising right now: each channel\'s peak in the last N hours vs the N hours before. ' +
        'Use for "who is trending / blowing up / appeared from nowhere".',
      input_schema: {
        type: 'object',
        properties: {
          hours: { type: 'integer', description: 'Window size (default 24)', enum: [24, 48, 168] },
        },
        required: [],
      },
    },
    {
      name: 'most_chatted',
      description: 'Top 10 channels by chat messages in the range (shortcut for top_channels metric=messages).',
      input_schema: {
        type: 'object',
        properties: {
          range: RANGE_PROP as unknown as Record<string, unknown>,
        },
        required: [],
      },
    },
    {
      name: 'breakdown',
      description: 'Total viewed hours split by language or platform over the range.',
      input_schema: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: ['language', 'platform'] },
          range: RANGE_PROP as unknown as Record<string, unknown>,
        },
        required: ['dimension'],
      },
    },
    {
      name: 'refuse',
      description:
        'Use when the question is off-topic, about a different game or event, or unanswerable with these tools.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['off_topic', 'other_game', 'unsupported'] },
          message: { type: 'string', description: 'One short sentence telling the user why' },
        },
        required: ['reason', 'message'],
      },
    },
  ];
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Three example questions built from the real vocabulary, for refusals. */
function buildSuggestions(vocab: DiscoverVocabulary): string[] {
  const out: string[] = ['Top 10 channels by peak viewers'];
  if (vocab.languages.length > 0) {
    out.push(`Top 5 ${vocab.languages[0].toUpperCase()} streamers this week`);
  } else {
    out.push('Biggest stream this week');
  }
  out.push('Who is trending?');
  return out;
}

function refusal(message: string, vocab: DiscoverVocabulary, chips: string[]): DiscoverAskEnvelope {
  return { kind: 'refusal', message, suggestions: buildSuggestions(vocab), resolvedIntent: chips };
}

/** "21:42 · Apr 26" (UTC) for stat subs. */
function formatUtc(date: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric',
  }).format(date);
  return `${time} · ${day}`;
}

/** Merge optional footnote fragments into one footer line. */
function buildFootnote(range: ResolvedRange, opts: { chat?: boolean } = {}): string | undefined {
  const parts: string[] = [];
  if (opts.chat && range.from.getTime() < CHAT_METRICS_SINCE.getTime()) parts.push(CHAT_FOOTNOTE);
  if (range.clampedToFirstSnapshot) parts.push(`tracking began ${isoDate(range.from)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Deep link into the Channels tab reproducing the ranked view: mode/from/to
 * (DiscoverChannelsTab's own URL params — 24h/7d map to its presets, every
 * other range becomes a custom date window) + platform/language filters.
 */
function channelsTabHref(
  slug: string,
  range: ResolvedRange,
  filters: { platform?: string | null; language?: string | null },
): string {
  const params = new URLSearchParams();
  params.set('tab', 'channels');
  if (range.preset === '24h' || range.preset === '7d') {
    params.set('mode', range.preset);
  } else {
    params.set('mode', 'custom');
    params.set('from', isoDate(range.from));
    // Inclusive end date (range.to is a boundary instant, e.g. midnight of
    // the first day AFTER a calendar month).
    params.set('to', isoDate(new Date(range.to.getTime() - 1)));
  }
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.language) params.set('language', filters.language);
  return `/discover/${slug}?${params.toString()}`;
}

/** Overlap predicate + params for sessions within a resolved range. */
const SESSION_OVERLAP_SQL = 's.started_at <= ? AND COALESCE(s.ended_at, s.last_seen_at) >= ?';

// ── Executor ────────────────────────────────────────────────────────────────

export interface DiscoverAskContext {
  tracker: GameTracker;
  vocab: DiscoverVocabulary;
  viewState: DiscoverAskViewState;
}

interface TopChannelsParams {
  range: ResolvedRange;
  metric: 'peak' | 'hours' | 'messages' | 'chatters';
  language: string | null;
  platform: string | null;
  limit: number;
}

/**
 * Shared top-channels aggregation (top_channels + most_chatted). Sessions
 * overlapping the range, grouped by streamer identity (platform + lowercased
 * identifier) to match the Channels tab dedup, ranked by the chosen metric.
 */
async function runTopChannels(
  ctx: DiscoverAskContext,
  p: TopChannelsParams,
  chipsPrefix: string[],
): Promise<DiscoverAskEnvelope> {
  const { tracker } = ctx;
  const orderExpr =
    p.metric === 'peak' ? 'MAX(s.peak_ccv)'
      : p.metric === 'hours' ? 'SUM(s.ccv_minutes)'
        : p.metric === 'messages' ? 'SUM(s.messages)'
          : 'SUM(s.unique_chatters)';

  const params: unknown[] = [tracker.id, p.range.to, p.range.from];
  let filterSql = '';
  if (p.language) {
    filterSql += " AND LOWER(split_part(COALESCE(c.language, ''), '-', 1)) = ?";
    params.push(p.language);
  }
  if (p.platform) {
    // channels.platform is a Postgres enum — cast before LOWER().
    filterSql += ' AND LOWER(c.platform::text) = ?';
    params.push(p.platform);
  }
  params.push(p.limit);

  const result = await db.raw<{
    rows: Array<{
      channel_id: string;
      display_name: string;
      platform: string;
      language: string | null;
      peak_ccv: string;
      ccv_minutes: string;
      messages: string;
      chatters: string;
    }>;
  }>(
    `
    SELECT
      (array_agg(s.channel_id ORDER BY s.peak_ccv DESC))[1] AS channel_id,
      (array_agg(c.display_name ORDER BY s.peak_ccv DESC))[1] AS display_name,
      c.platform,
      (array_agg(c.language ORDER BY s.peak_ccv DESC))[1] AS language,
      MAX(s.peak_ccv) AS peak_ccv,
      COALESCE(SUM(s.ccv_minutes), 0) AS ccv_minutes,
      COALESCE(SUM(s.messages), 0) AS messages,
      COALESCE(SUM(s.unique_chatters), 0) AS chatters
    FROM stream_sessions s
    JOIN channels c ON c.id = s.channel_id
    WHERE s.game_tracker_id = ?
      AND ${SESSION_OVERLAP_SQL}
      ${filterSql}
    GROUP BY c.platform, LOWER(c.channel_identifier)
    ORDER BY ${orderExpr} DESC
    LIMIT ?
    `,
    params,
  );
  const rows = result.rows;

  const chips = [...chipsPrefix, `by ${METRIC_LABELS[p.metric]}`];
  if (p.language) chips.push(p.language.toUpperCase());
  if (p.platform) chips.push(p.platform);
  chips.push(p.range.label);

  const qualifiers = [p.language ? p.language.toUpperCase() : null, p.platform]
    .filter(Boolean)
    .join(' ');
  const chat = p.metric === 'messages' || p.metric === 'chatters';

  if (rows.length === 0) {
    return {
      kind: 'answer',
      headline: `No ${qualifiers ? `${qualifiers} ` : ''}streams found in ${p.range.label}`,
      blocks: [],
      resolvedIntent: chips,
      footnote: buildFootnote(p.range, { chat }),
    };
  }

  return {
    kind: 'answer',
    headline: `Top ${rows.length}${qualifiers ? ` ${qualifiers}` : ''} channels by ${METRIC_LABELS[p.metric]} · ${p.range.label}`,
    blocks: [
      {
        type: 'table',
        columns: ['Channel', 'Platform', 'Lang', 'Peak', 'Hours', 'Messages', 'Chatters'],
        rows: rows.map((r) => [
          r.display_name,
          r.platform,
          (baseLang(r.language) ?? '—').toUpperCase(),
          Math.round(Number(r.peak_ccv) || 0),
          Math.round((Number(r.ccv_minutes) || 0) / 60),
          Math.round(Number(r.messages) || 0),
          Math.round(Number(r.chatters) || 0),
        ]),
      },
    ],
    resolvedIntent: chips,
    deepLink: {
      label: 'Open in Channels tab',
      href: channelsTabHref(tracker.slug, p.range, { platform: p.platform, language: p.language }),
    },
    footnote: buildFootnote(p.range, { chat }),
  };
}

/**
 * Execute a validated intent. Numbers always come from Postgres; user-shaped
 * problems (future months, ids outside the vocabulary) become refusal
 * envelopes, never throws.
 */
export async function executeDiscoverIntent(
  name: string,
  input: Record<string, unknown>,
  ctx: DiscoverAskContext,
): Promise<DiscoverAskEnvelope> {
  const { tracker, vocab } = ctx;

  switch (name) {
    case 'top_channels':
    case 'most_chatted': {
      const range = resolveRange(input.range, vocab.firstSnapshotAt);
      if ('error' in range) return refusal(range.error, vocab, ['Top channels', 'bad range']);

      const isMostChatted = name === 'most_chatted';
      const metric = isMostChatted
        ? 'messages'
        : typeof input.metric === 'string' && ['peak', 'hours', 'messages', 'chatters'].includes(input.metric)
          ? (input.metric as TopChannelsParams['metric'])
          : 'peak';
      const limit = isMostChatted
        ? 10
        : Math.min(20, Math.max(1, typeof input.limit === 'number' ? Math.round(input.limit) : 10));
      const language = !isMostChatted && typeof input.language === 'string' ? baseLang(input.language) : null;
      const platform = !isMostChatted && typeof input.platform === 'string' ? input.platform.trim().toLowerCase() || null : null;

      return runTopChannels(
        ctx,
        { range, metric, language, platform, limit },
        [isMostChatted ? 'Most chatted' : `Top ${limit}`],
      );
    }

    case 'biggest_stream': {
      const range = resolveRange(input.range, vocab.firstSnapshotAt);
      if ('error' in range) return refusal(range.error, vocab, ['Biggest stream', 'bad range']);
      const metric = typeof input.metric === 'string' && ['peak', 'hours'].includes(input.metric)
        ? (input.metric as 'peak' | 'hours')
        : 'peak';

      const result = await db.raw<{
        rows: Array<{
          channel_id: string;
          stream_id: string;
          display_name: string;
          platform: string;
          started_at: Date;
          peak_ccv: string;
          ccv_minutes: string;
          minutes_live: string;
          title: string | null;
        }>;
      }>(
        `
        SELECT s.channel_id, s.stream_id, c.display_name, c.platform, s.started_at,
               s.peak_ccv, s.ccv_minutes, s.minutes_live,
               (s.titles -> (jsonb_array_length(s.titles) - 1)) ->> 'title' AS title
        FROM stream_sessions s
        JOIN channels c ON c.id = s.channel_id
        WHERE s.game_tracker_id = ?
          AND ${SESSION_OVERLAP_SQL}
        ORDER BY ${metric === 'peak' ? 's.peak_ccv' : 's.ccv_minutes'} DESC
        LIMIT 1
        `,
        [tracker.id, range.to, range.from],
      );
      const row = result.rows[0];
      const chips = ['Biggest stream', `by ${METRIC_LABELS[metric]}`, range.label];
      if (!row) {
        return {
          kind: 'answer',
          headline: `No streams found in ${range.label}`,
          blocks: [],
          resolvedIntent: chips,
          footnote: buildFootnote(range),
        };
      }
      const startedAt = new Date(row.started_at);
      return {
        kind: 'answer',
        headline: `Biggest stream by ${METRIC_LABELS[metric]} · ${range.label}`,
        blocks: [
          {
            type: 'stat',
            label: `${row.display_name} (${row.platform}), peak CCV`,
            value: Math.round(Number(row.peak_ccv) || 0),
            sub: `started ${formatUtc(startedAt)} UTC${row.title ? ` · ${row.title.slice(0, 80)}` : ''}`,
          },
          {
            type: 'stat',
            label: 'Viewed hours',
            value: Math.round((Number(row.ccv_minutes) || 0) / 60),
          },
          {
            type: 'stat',
            label: 'Minutes live',
            value: Math.round(Number(row.minutes_live) || 0),
          },
        ],
        resolvedIntent: chips,
        deepLink: {
          label: 'Open stream page',
          href: `/discover/${tracker.slug}/channel/${row.channel_id}/stream/${encodeURIComponent(row.stream_id)}`,
        },
        footnote: buildFootnote(range),
      };
    }

    case 'channel_stat': {
      const channelId = typeof input.channel_id === 'string' ? input.channel_id.trim() : '';
      const channel = vocab.channels.find((c) => c.id === channelId);
      if (!channel) {
        return refusal(
          'That channel is not among the tracked channels of this game.',
          vocab,
          ['Channel', 'unknown channel'],
        );
      }
      const range = resolveRange(input.range, vocab.firstSnapshotAt);
      if ('error' in range) return refusal(range.error, vocab, ['Channel', 'bad range']);

      // Aggregate across every channel row sharing this streamer identity
      // (same dedup rule as the Channels tab / vocabulary).
      const result = await db.raw<{
        rows: Array<{
          sessions: string;
          peak_ccv: string | null;
          ccv_minutes: string | null;
          messages: string | null;
          chatters: string | null;
        }>;
      }>(
        `
        SELECT COUNT(*) AS sessions,
               MAX(s.peak_ccv) AS peak_ccv,
               SUM(s.ccv_minutes) AS ccv_minutes,
               SUM(s.messages) AS messages,
               SUM(s.unique_chatters) AS chatters
        FROM stream_sessions s
        JOIN channels c ON c.id = s.channel_id
        JOIN channels me ON me.id = ?
        WHERE s.game_tracker_id = ?
          AND c.platform = me.platform
          AND LOWER(c.channel_identifier) = LOWER(me.channel_identifier)
          AND ${SESSION_OVERLAP_SQL}
        `,
        [channel.id, tracker.id, range.to, range.from],
      );
      const row = result.rows[0];
      const sessions = Math.round(Number(row?.sessions) || 0);
      const chips = ['Channel', channel.name, range.label];
      if (sessions === 0) {
        return {
          kind: 'answer',
          headline: `${channel.name}: no streams in ${range.label}`,
          blocks: [],
          resolvedIntent: chips,
          deepLink: {
            label: 'Open channel page',
            href: `/discover/${tracker.slug}/channel/${channel.id}`,
          },
          footnote: buildFootnote(range),
        };
      }
      return {
        kind: 'answer',
        headline: `${channel.name} (${channel.platform}) · ${range.label}`,
        blocks: [
          { type: 'stat', label: 'Peak CCV', value: Math.round(Number(row?.peak_ccv) || 0) },
          { type: 'stat', label: 'Viewed hours', value: Math.round((Number(row?.ccv_minutes) || 0) / 60) },
          { type: 'stat', label: 'Chat messages', value: Math.round(Number(row?.messages) || 0) },
          { type: 'stat', label: 'Streams', value: sessions },
        ],
        resolvedIntent: chips,
        deepLink: {
          label: 'Open channel page',
          href: `/discover/${tracker.slug}/channel/${channel.id}`,
        },
        footnote: buildFootnote(range, { chat: true }),
      };
    }

    case 'trending': {
      const hours = typeof input.hours === 'number' && [24, 48, 168].includes(input.hours)
        ? input.hours
        : 24;
      // Same query as GET /api/game-trackers/:slug/trending — peak in the
      // last N hours vs the N hours before, ≥50 CCV floor, biggest absolute
      // gains first.
      const now = Date.now();
      const curFrom = new Date(now - hours * 3_600_000);
      const prevFrom = new Date(now - 2 * hours * 3_600_000);
      const result = await db.raw<{
        rows: Array<{
          channel_id: string;
          cur_peak: number;
          prev_peak: number;
          is_new: boolean;
          display_name: string | null;
          platform: string | null;
        }>;
      }>(
        `
        WITH cur AS (
          SELECT channel_id, max(concurrent_viewers) AS peak
          FROM game_tracker_snapshots
          WHERE game_tracker_id = ? AND timestamp >= ?
          GROUP BY channel_id
        ),
        prev AS (
          SELECT channel_id, max(concurrent_viewers) AS peak
          FROM game_tracker_snapshots
          WHERE game_tracker_id = ? AND timestamp >= ? AND timestamp < ?
          GROUP BY channel_id
        )
        SELECT c.channel_id,
               c.peak            AS cur_peak,
               COALESCE(p.peak, 0) AS prev_peak,
               (p.channel_id IS NULL) AS is_new,
               ch.display_name,
               ch.platform
        FROM cur c
        LEFT JOIN prev p ON p.channel_id = c.channel_id
        LEFT JOIN channels ch ON ch.id = c.channel_id
        WHERE c.peak >= 50 AND c.peak > COALESCE(p.peak, 0)
        ORDER BY (c.peak - COALESCE(p.peak, 0)) DESC
        LIMIT 10
        `,
        [tracker.id, curFrom, tracker.id, prevFrom, curFrom],
      );
      const rows = result.rows;
      const chips = ['Trending', `last ${hours}h vs previous ${hours}h`];
      if (rows.length === 0) {
        return {
          kind: 'answer',
          headline: `Nobody is trending in the last ${hours}h`,
          blocks: [],
          resolvedIntent: chips,
        };
      }
      return {
        kind: 'answer',
        headline: `Trending: last ${hours}h vs the ${hours}h before`,
        blocks: [
          {
            type: 'table',
            columns: ['Channel', 'Platform', 'Prev peak', 'Peak', 'Gain', 'New'],
            rows: rows.map((r) => [
              r.display_name ?? r.channel_id.slice(0, 8),
              r.platform ?? '—',
              Math.round(Number(r.prev_peak) || 0),
              Math.round(Number(r.cur_peak) || 0),
              Math.round((Number(r.cur_peak) || 0) - (Number(r.prev_peak) || 0)),
              r.is_new ? 'NEW' : '',
            ]),
          },
        ],
        resolvedIntent: chips,
        deepLink: { label: 'Open Trends tab', href: `/discover/${tracker.slug}?tab=trends` },
      };
    }

    case 'breakdown': {
      const dimension = input.dimension === 'platform' ? 'platform' : 'language';
      const range = resolveRange(input.range, vocab.firstSnapshotAt);
      if ('error' in range) return refusal(range.error, vocab, ['Breakdown', 'bad range']);

      // channels.platform is a Postgres enum — cast before LOWER().
      const dimExpr = dimension === 'platform'
        ? 'LOWER(c.platform::text)'
        : "NULLIF(LOWER(split_part(COALESCE(c.language, ''), '-', 1)), '')";
      const result = await db.raw<{
        rows: Array<{ dim: string | null; ccv_minutes: string; peak_ccv: string; sessions: string }>;
      }>(
        `
        SELECT ${dimExpr} AS dim,
               COALESCE(SUM(s.ccv_minutes), 0) AS ccv_minutes,
               MAX(s.peak_ccv) AS peak_ccv,
               COUNT(*) AS sessions
        FROM stream_sessions s
        JOIN channels c ON c.id = s.channel_id
        WHERE s.game_tracker_id = ?
          AND ${SESSION_OVERLAP_SQL}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 20
        `,
        [tracker.id, range.to, range.from],
      );
      const rows = result.rows;
      const chips = ['Breakdown', `by ${dimension}`, range.label];
      if (rows.length === 0) {
        return {
          kind: 'answer',
          headline: `No streams found in ${range.label}`,
          blocks: [],
          resolvedIntent: chips,
          footnote: buildFootnote(range),
        };
      }
      return {
        kind: 'answer',
        headline: `Viewed hours by ${dimension} · ${range.label}`,
        blocks: [
          {
            type: 'table',
            columns: [dimension === 'platform' ? 'Platform' : 'Language', 'Hours', 'Peak CCV', 'Streams'],
            rows: rows.map((r) => [
              dimension === 'language' ? (r.dim ?? '—').toUpperCase() : (r.dim ?? '—'),
              Math.round((Number(r.ccv_minutes) || 0) / 60),
              Math.round(Number(r.peak_ccv) || 0),
              Math.round(Number(r.sessions) || 0),
            ]),
          },
        ],
        resolvedIntent: chips,
        footnote: buildFootnote(range),
      };
    }

    case 'refuse': {
      const message = typeof input.message === 'string' && input.message.trim()
        ? input.message.trim()
        : `I can only answer questions about ${tracker.name} viewership.`;
      const reason = typeof input.reason === 'string' ? input.reason : 'unsupported';
      return refusal(message, vocab, ['Refused', reason.replace(/_/g, ' ')]);
    }

    default:
      // The compiler validates against the catalog — belt-and-braces only.
      return refusal('I could not map that question onto anything this page can do.', vocab, [
        'Refused',
        'unknown intent',
      ]);
  }
}
