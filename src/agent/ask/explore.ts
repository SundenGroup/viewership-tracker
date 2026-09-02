/**
 * Ask · Explore surface — vocabulary builder, intent catalog, executor.
 *
 * The model NEVER computes numbers. It picks exactly one intent from the
 * closed tool catalog below and fills parameters from a server-provided
 * vocabulary (this series' real stages/days/channels/languages). The server
 * then either executes the query against Postgres (via the same model
 * functions the dashboard uses) or emits a URL-state patch the Explore page
 * applies — the page re-rendering IS the answer. Every envelope carries a
 * resolved-intent footer describing what was actually understood.
 */

import type Anthropic from '@anthropic-ai/sdk';
import db from '../../utils/db';
import * as StageModel from '../../models/stage';
import * as BroadcastDayModel from '../../models/broadcast-day';
import * as ViewershipSnapshotModel from '../../models/viewership-snapshot';
import type { TournamentSeries } from '../../models/tournament-series';
import type { Scope } from '../../models/viewership-snapshot';

// ── Envelope types ──────────────────────────────────────────────────────────

/** URL-state patch: keys to set (comma-joined values) and keys to delete. */
export interface AskPatch {
  set: Record<string, string>;
  del: string[];
}

export type AskBlock =
  | { type: 'stat'; label: string; value: number; sub?: string }
  | { type: 'table'; columns: string[]; rows: Array<Array<string | number>> };

export type AskEnvelope =
  | { kind: 'patch'; patch: AskPatch; headline: string; resolvedIntent: string[] }
  | {
      kind: 'answer';
      headline: string;
      blocks: AskBlock[];
      resolvedIntent: string[];
      /** Opt-in follow-up actions the answer card offers ("Filter to RU"). */
      suggestions?: Array<{ label: string; patch: AskPatch }>;
      /** Patch the client auto-applies so the answer is visible on the chart. */
      chartPatch?: AskPatch;
    }
  | { kind: 'refusal'; message: string; suggestions: string[]; resolvedIntent: string[] };

/** URL params the Explore page sends as its current view state. */
export interface AskViewState {
  stage?: string;
  day?: string;
  channels?: string;
  languages?: string;
  platforms?: string;
  tiers?: string;
  regions?: string;
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

export interface ExploreVocabulary {
  stages: Array<{ id: string; name: string }>;
  days: Array<{ id: string; label: string; date: string; stage_id: string }>;
  languages: string[];
  platforms: string[];
  tiers: string[];
  regions: string[];
  /** Top channels by viewership — the only channel ids the model may pick. */
  channels: Array<{ id: string; name: string; platform: string; language: string | null; tier: string }>;
}

/** Base language code ('ru-RU' → 'ru'), matching buildFilterClauses semantics. */
function baseLang(lang: string | null | undefined): string | null {
  const trimmed = (lang ?? '').trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.split('-')[0] || null;
}

/**
 * Fetch the per-series vocabulary the model is allowed to fill parameters
 * from. Everything comes from existing models / the channels table — no new
 * aggregation paths.
 */
export async function buildExploreVocabulary(series: TournamentSeries): Promise<ExploreVocabulary> {
  const [stages, days, channelDims, leaderboard] = await Promise.all([
    StageModel.findAll({ series_id: series.id }),
    BroadcastDayModel.findAll({ series_id: series.id }),
    db('channels')
      .where({ series_id: series.id })
      .select('language', 'platform', 'tier', 'region') as Promise<
      Array<{ language: string | null; platform: string; tier: string; region: string | null }>
    >,
    ViewershipSnapshotModel.getChannelLeaderboard({ level: 'series', id: series.id }, 150),
  ]);

  const languages = new Set<string>();
  const platforms = new Set<string>();
  const tiers = new Set<string>();
  const regions = new Set<string>();
  for (const c of channelDims) {
    const lang = baseLang(c.language);
    if (lang) languages.add(lang);
    if (c.platform) platforms.add(c.platform.toLowerCase());
    if (c.tier) tiers.add(c.tier);
    const region = (c.region ?? '').trim();
    if (region) regions.add(region);
  }

  return {
    stages: stages.map((s) => ({ id: s.id, name: s.name })),
    days: days.map((d) => ({ id: d.id, label: d.label, date: d.date, stage_id: d.stage_id })),
    languages: Array.from(languages).sort(),
    platforms: Array.from(platforms).sort(),
    tiers: Array.from(tiers).sort(),
    regions: Array.from(regions).sort(),
    channels: leaderboard.map((e) => ({
      id: e.channel_id,
      name: e.display_name,
      platform: e.platform,
      language: baseLang(e.language),
      tier: e.tier,
    })),
  };
}

/** Compact text rendering of the vocabulary + current view for the model. */
export function renderAskContext(
  series: TournamentSeries,
  vocab: ExploreVocabulary,
  viewState: AskViewState,
): string {
  const lines: string[] = [];
  lines.push(`SERIES: ${series.name} (timezone ${series.timezone})`);
  lines.push(`STAGES: ${vocab.stages.map((s) => `${s.id}=${s.name}`).join(' | ') || '(none)'}`);
  lines.push(`DAYS: ${vocab.days.map((d) => `${d.id}=${d.label} ${d.date}`).join(' | ') || '(none)'}`);
  lines.push(`LANGUAGES: ${vocab.languages.join(', ') || '(none)'}`);
  lines.push(`PLATFORMS: ${vocab.platforms.join(', ') || '(none)'}`);
  lines.push(`TIERS: ${vocab.tiers.join(', ') || '(none)'}`);
  lines.push(`REGIONS: ${vocab.regions.join(', ') || '(none)'}`);
  lines.push('CHANNELS (id | name | platform | lang | tier):');
  for (const c of vocab.channels) {
    lines.push(`${c.id} | ${c.name} | ${c.platform} | ${c.language ?? '-'} | ${c.tier}`);
  }

  const scope = resolveScope(vocab, viewState);
  const view: string[] = [`scope=${scope.label}`];
  if (viewState.languages) view.push(`languages=${viewState.languages}`);
  if (viewState.platforms) view.push(`platforms=${viewState.platforms}`);
  if (viewState.tiers) view.push(`tiers=${viewState.tiers}`);
  if (viewState.regions) view.push(`regions=${viewState.regions}`);
  if (viewState.channels) view.push(`selected_channels=${viewState.channels}`);
  lines.push(`CURRENT VIEW: ${view.join(', ')}`);
  return lines.join('\n');
}

// ── Intent catalog (tools) ──────────────────────────────────────────────────

/** Only add `enum` when the list is non-empty — empty enums are invalid. */
function enumProp(description: string, values: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = { type: 'string', description };
  if (values.length > 0) p.enum = values;
  return p;
}

function enumArrayProp(description: string, values: string[]): Record<string, unknown> {
  const items: Record<string, unknown> = { type: 'string' };
  if (values.length > 0) items.enum = values;
  return { type: 'array', description, items };
}

/**
 * Build the closed intent catalog with this series' vocabulary injected as
 * enums. Plain JSON-schema tools (no `strict` field).
 */
export function buildExploreTools(vocab: ExploreVocabulary): Anthropic.Tool[] {
  const dayIds = vocab.days.map((d) => d.id);
  const stageIds = vocab.stages.map((s) => s.id);
  return [
    {
      name: 'set_filters',
      description:
        'Apply channel filters to the current Explore view (the page re-renders with them). Only include the dimensions the user asked about; pass an empty array to clear one dimension.',
      input_schema: {
        type: 'object',
        properties: {
          languages: enumArrayProp('Language codes to filter to', vocab.languages),
          platforms: enumArrayProp('Platforms to filter to', vocab.platforms),
          tiers: enumArrayProp('Channel tiers to filter to (watch_party = watch parties)', vocab.tiers),
          regions: enumArrayProp('Regions to filter to', vocab.regions),
          search: { type: 'string', description: 'Free-text channel name search' },
        },
        required: [],
      },
    },
    {
      name: 'clear_filters',
      description: 'Remove every active filter (languages, platforms, tiers, regions, search).',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_scope',
      description:
        'Change which slice of the tournament the page shows: one broadcast day, one stage, or the whole series. Provide exactly one of day_id / stage_id / series.',
      input_schema: {
        type: 'object',
        properties: {
          day_id: enumProp('Broadcast day id from DAYS', dayIds),
          stage_id: enumProp('Stage id from STAGES', stageIds),
          series: { type: 'boolean', description: 'true = scope to the full series' },
        },
        required: [],
      },
    },
    {
      name: 'select_channels',
      description: 'Overlay 1-8 channels on the chart. Use channel ids from CHANNELS only.',
      input_schema: {
        type: 'object',
        properties: {
          channel_ids: {
            type: 'array',
            description: 'Channel ids from CHANNELS (1-8)',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 8,
          },
        },
        required: ['channel_ids'],
      },
    },
    {
      name: 'compare_with',
      description:
        'Overlay another scope of the SAME level for comparison: another day when currently viewing a day (day_id), another stage when viewing a stage (stage_id).',
      input_schema: {
        type: 'object',
        properties: {
          day_id: enumProp('Broadcast day id from DAYS to compare against', dayIds),
          stage_id: enumProp('Stage id from STAGES to compare against', stageIds),
        },
        required: [],
      },
    },
    {
      name: 'pin_time',
      description:
        'Pin a single moment on the timeline (shows every channel at that minute). HH:MM wall-clock in the series timezone on the currently selected broadcast day. Only valid when the current view is scoped to a day.',
      input_schema: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '24h wall-clock time, e.g. "21:30"' },
        },
        required: ['time'],
      },
    },
    {
      name: 'select_range',
      description:
        'Select a time window on the timeline. HH:MM wall-clock times in the series timezone on the currently selected broadcast day. Only valid when the current view is scoped to a day.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Window start, 24h "HH:MM"' },
          to: { type: 'string', description: 'Window end, 24h "HH:MM"' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'top_channels',
      description:
        'Rank channels within the current scope by a metric and answer with a table. Optional language/tier/platform narrowing.',
      input_schema: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'How many channels (1-20, default 5)', minimum: 1, maximum: 20 },
          metric: {
            type: 'string',
            description: 'Ranking metric (default peak)',
            enum: ['peak', 'avg', 'watch_time'],
          },
          language: enumProp('Only channels of this language', vocab.languages),
          tier: enumProp('Only channels of this tier', vocab.tiers),
          platform: enumProp('Only channels on this platform', vocab.platforms),
        },
        required: [],
      },
    },
    {
      name: 'scoped_metric',
      description:
        'One aggregate number for the CURRENT scope: peak concurrent viewers, average concurrent viewers, or total viewed hours.',
      input_schema: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['peak', 'average', 'watch_time'] },
        },
        required: ['metric'],
      },
    },
    {
      name: 'language_peak',
      description: 'Peak moment, average and viewed hours for ONE language within the current scope.',
      input_schema: {
        type: 'object',
        properties: {
          language: enumProp('Language code from LANGUAGES', vocab.languages),
        },
        required: ['language'],
      },
    },
    {
      name: 'refuse',
      description:
        'Use when the question is off-topic, about a different event/series, unanswerable with these tools, or needs a day scope the view does not have.',
      input_schema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['off_topic', 'other_series', 'unsupported', 'need_day_scope'],
          },
          message: { type: 'string', description: 'One short sentence telling the user why' },
        },
        required: ['reason', 'message'],
      },
    },
  ];
}

// ── Timezone helpers (copied from api/routes/viewership-import.ts) ─────────

/** Minutes east of UTC for an IANA timezone at a given UTC instant. */
function tzOffsetMinutes(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second,
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Convert local wall-clock time in an IANA tz to a UTC Date (DST-safe). */
function zonedToUtc(dateStr: string, h: number, m: number, s: number, timeZone: string): Date {
  const [y, mo, d] = dateStr.split('-').map((v) => parseInt(v, 10));
  const guess = Date.UTC(y, mo - 1, d, h, m, s);
  // Two-pass: offset at the guess, then re-evaluate at the corrected instant
  // so times right at a DST transition resolve to the correct side.
  const off1 = tzOffsetMinutes(timeZone, guess);
  const corrected = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(timeZone, corrected);
  return new Date(guess - off2 * 60_000);
}

/** "21:42 · Apr 26" in the series timezone, for stat subs. */
function formatInTz(date: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'short', day: 'numeric',
  }).format(date);
  return `${time} · ${day}`;
}

/** 'HH:MM' → {h, m} or null. */
function parseHHMM(v: unknown): { h: number; m: number } | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** 'YYYY-MM-DD' + 1 day (calendar arithmetic in UTC, safe for date strings). */
function nextDate(dateStr: string): string {
  const [y, mo, d] = dateStr.split('-').map((v) => parseInt(v, 10));
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

// ── Scope resolution ────────────────────────────────────────────────────────

interface ResolvedScope {
  scope: Scope;
  level: 'day' | 'stage' | 'series';
  label: string;
  day?: ExploreVocabulary['days'][number];
  stage?: ExploreVocabulary['stages'][number];
}

/**
 * Resolve the view state to a query scope. Ids that don't belong to this
 * series (stale URLs, cross-series links) are ignored → series scope.
 */
function resolveScope(vocab: ExploreVocabulary, viewState: AskViewState): ResolvedScope {
  if (viewState.day) {
    const day = vocab.days.find((d) => d.id === viewState.day);
    if (day) {
      return { scope: { level: 'day', id: day.id }, level: 'day', label: day.label, day };
    }
  }
  if (viewState.stage) {
    const stage = vocab.stages.find((s) => s.id === viewState.stage);
    if (stage) {
      return { scope: { level: 'stage', id: stage.id }, level: 'stage', label: stage.name, stage };
    }
  }
  return { scope: { level: 'series', id: '' }, level: 'series', label: 'Full series' };
}

// ── Small helpers ───────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  official: 'Official',
  partner: 'Partner',
  player: 'Player POV',
  community: 'Community',
  watch_party: 'Watch Parties',
};

function prettyTier(tier: string): string {
  return TIER_LABELS[tier] ?? tier.replace(/_/g, ' ');
}

const METRIC_LABELS: Record<string, string> = {
  peak: 'peak CCV',
  avg: 'average CCV',
  average: 'average CCV',
  watch_time: 'viewed hours',
};

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/** Three example questions built from the real vocabulary, for refusals. */
function buildSuggestions(vocab: ExploreVocabulary, scope: ResolvedScope): string[] {
  const out: string[] = [];
  const tier = vocab.tiers.includes('watch_party') ? 'watch parties' : 'channels';
  out.push(`Top 5 ${tier} by peak viewers`);
  if (vocab.languages.length > 0) {
    out.push(`Show ${vocab.languages[0].toUpperCase()} channels only`);
  }
  const day = scope.day ?? vocab.days[vocab.days.length - 1];
  if (day) out.push(`What was the peak on ${day.label}?`);
  else out.push('What was the peak for the whole series?');
  return out.slice(0, 3);
}

function refusal(
  message: string,
  vocab: ExploreVocabulary,
  scope: ResolvedScope,
  chips: string[],
): AskEnvelope {
  return {
    kind: 'refusal',
    message,
    suggestions: buildSuggestions(vocab, scope),
    resolvedIntent: chips,
  };
}

// ── Executor ────────────────────────────────────────────────────────────────

export interface ExploreAskContext {
  series: TournamentSeries;
  vocab: ExploreVocabulary;
  viewState: AskViewState;
}

/**
 * Execute a validated intent. URL-patch intents return the patch for the
 * client to apply; query intents run against Postgres via the same model
 * functions the dashboard uses. Never throws for user-shaped problems —
 * those become refusal envelopes.
 */
export async function executeExploreIntent(
  name: string,
  input: Record<string, unknown>,
  ctx: ExploreAskContext,
): Promise<AskEnvelope> {
  const { series, vocab, viewState } = ctx;
  const scope = resolveScope(vocab, viewState);

  switch (name) {
    // ── URL-patch intents ─────────────────────────────────────────────
    case 'set_filters': {
      const set: Record<string, string> = {};
      const del: string[] = [];
      const chips: string[] = ['Filter'];
      const parts: string[] = [];
      const dims: Array<{ param: string; values: string[] | undefined; vocabList: string[]; pretty: (v: string) => string }> = [
        { param: 'languages', values: asStringArray(input.languages), vocabList: vocab.languages, pretty: (v) => v.toUpperCase() },
        { param: 'platforms', values: asStringArray(input.platforms), vocabList: vocab.platforms, pretty: (v) => v },
        { param: 'tiers', values: asStringArray(input.tiers), vocabList: vocab.tiers, pretty: prettyTier },
        { param: 'regions', values: asStringArray(input.regions), vocabList: vocab.regions, pretty: (v) => v },
      ];
      for (const dim of dims) {
        if (dim.values === undefined) continue; // untouched dimension
        const valid = dim.values
          .map((v) => v.trim())
          .filter((v) => dim.vocabList.some((x) => x.toLowerCase() === v.toLowerCase()))
          .map((v) => dim.vocabList.find((x) => x.toLowerCase() === v.toLowerCase())!);
        if (valid.length > 0) {
          set[dim.param] = Array.from(new Set(valid)).join(',');
          for (const v of valid) {
            chips.push(dim.pretty(v));
            parts.push(dim.pretty(v));
          }
        } else {
          del.push(dim.param);
        }
      }
      if (typeof input.search === 'string') {
        const q = input.search.trim();
        if (q) {
          set.q = q;
          chips.push(`"${q}"`);
          parts.push(`"${q}"`);
        } else {
          del.push('q');
        }
      }
      if (Object.keys(set).length === 0 && del.length === 0) {
        return refusal(
          'I could not match that to any filter this series actually has.',
          vocab, scope, ['Filter', 'no match'],
        );
      }
      chips.push(scope.label);
      const headline =
        parts.length > 0 ? `Filtered to ${parts.join(' · ')}` : 'Cleared the mentioned filters';
      return { kind: 'patch', patch: { set, del }, headline, resolvedIntent: chips };
    }

    case 'clear_filters':
      return {
        kind: 'patch',
        patch: { set: {}, del: ['languages', 'platforms', 'tiers', 'regions', 'q'] },
        headline: 'Cleared all filters',
        resolvedIntent: ['Clear filters', scope.label],
      };

    case 'set_scope': {
      // Scope switches also drop pinned time/range/compare — they belong to
      // the previous scope's timeline.
      const del = ['at', 'from', 'to', 'compare'];
      if (typeof input.day_id === 'string') {
        const day = vocab.days.find((d) => d.id === input.day_id);
        if (!day) return refusal('That broadcast day does not belong to this series.', vocab, scope, ['Scope', 'unknown day']);
        return {
          kind: 'patch',
          patch: { set: { day: day.id }, del: [...del, 'stage'] },
          headline: `Scoped to ${day.label} · ${day.date}`,
          resolvedIntent: ['Scope', day.label],
        };
      }
      if (typeof input.stage_id === 'string') {
        const stage = vocab.stages.find((s) => s.id === input.stage_id);
        if (!stage) return refusal('That stage does not belong to this series.', vocab, scope, ['Scope', 'unknown stage']);
        return {
          kind: 'patch',
          patch: { set: { stage: stage.id }, del: [...del, 'day'] },
          headline: `Scoped to ${stage.name}`,
          resolvedIntent: ['Scope', stage.name],
        };
      }
      if (input.series === true) {
        return {
          kind: 'patch',
          patch: { set: {}, del: [...del, 'day', 'stage'] },
          headline: 'Scoped to the full series',
          resolvedIntent: ['Scope', 'Full series'],
        };
      }
      return refusal('Tell me which day, stage, or "whole series" to scope to.', vocab, scope, ['Scope', 'ambiguous']);
    }

    case 'select_channels': {
      const ids = asStringArray(input.channel_ids) ?? [];
      const matched = ids
        .map((id) => vocab.channels.find((c) => c.id === id))
        .filter((c): c is ExploreVocabulary['channels'][number] => Boolean(c));
      if (matched.length === 0) {
        return refusal('None of those channels are tracked in this series.', vocab, scope, ['Overlay', 'no match']);
      }
      const limited = matched.slice(0, 8);
      const names = limited.map((c) => c.name);
      return {
        kind: 'patch',
        patch: { set: { channels: limited.map((c) => c.id).join(',') }, del: [] },
        headline: `Overlaying ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`,
        resolvedIntent: ['Overlay', ...names.slice(0, 4), scope.label],
      };
    }

    case 'compare_with': {
      // Compare must match the CURRENT scope level: day vs day, stage vs stage.
      if (typeof input.day_id === 'string') {
        if (scope.level !== 'day') {
          return refusal(
            'Comparing a day needs the view scoped to a day first. Say e.g. "show Day 2" and then compare.',
            vocab, scope, ['Compare', 'needs day scope'],
          );
        }
        const day = vocab.days.find((d) => d.id === input.day_id);
        if (!day) return refusal('That broadcast day does not belong to this series.', vocab, scope, ['Compare', 'unknown day']);
        if (day.id === scope.day?.id) {
          return refusal('That is the day already on screen. Pick a different day to compare against.', vocab, scope, ['Compare', 'same day']);
        }
        return {
          kind: 'patch',
          patch: { set: { compare: day.id }, del: [] },
          headline: `Comparing ${scope.label} vs ${day.label}`,
          resolvedIntent: ['Compare', scope.label, 'vs', day.label],
        };
      }
      if (typeof input.stage_id === 'string') {
        if (scope.level !== 'stage') {
          return refusal(
            'Comparing a stage needs the view scoped to a stage first. Switch to a stage and then compare.',
            vocab, scope, ['Compare', 'needs stage scope'],
          );
        }
        const stage = vocab.stages.find((s) => s.id === input.stage_id);
        if (!stage) return refusal('That stage does not belong to this series.', vocab, scope, ['Compare', 'unknown stage']);
        if (stage.id === scope.stage?.id) {
          return refusal('That is the stage already on screen. Pick a different stage to compare against.', vocab, scope, ['Compare', 'same stage']);
        }
        return {
          kind: 'patch',
          patch: { set: { compare: stage.id }, del: [] },
          headline: `Comparing ${scope.label} vs ${stage.name}`,
          resolvedIntent: ['Compare', scope.label, 'vs', stage.name],
        };
      }
      return refusal('Tell me which day or stage to compare against.', vocab, scope, ['Compare', 'ambiguous']);
    }

    case 'pin_time': {
      if (!scope.day) {
        return refusal(
          'Pinning a time needs the view scoped to a single broadcast day first.',
          vocab, scope, ['Pin time', 'needs day scope'],
        );
      }
      const t = parseHHMM(input.time);
      if (!t) return refusal('I could not read that time. Use 24h HH:MM.', vocab, scope, ['Pin time', 'bad time']);
      const iso = zonedToUtc(scope.day.date, t.h, t.m, 0, series.timezone).toISOString();
      const label = `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
      return {
        kind: 'patch',
        // A pinned moment and a pinned range are mutually exclusive.
        patch: { set: { at: iso }, del: ['from', 'to'] },
        headline: `Pinned ${label} (${series.timezone}) on ${scope.day.label}`,
        resolvedIntent: ['Pin time', label, scope.day.label],
      };
    }

    case 'select_range': {
      if (!scope.day) {
        return refusal(
          'Selecting a time range needs the view scoped to a single broadcast day first.',
          vocab, scope, ['Range', 'needs day scope'],
        );
      }
      const from = parseHHMM(input.from);
      const to = parseHHMM(input.to);
      if (!from || !to) return refusal('I could not read those times. Use 24h HH:MM.', vocab, scope, ['Range', 'bad time']);
      const fromDate = zonedToUtc(scope.day.date, from.h, from.m, 0, series.timezone);
      // A window ending "past midnight" (23:00-01:00) rolls to the next date.
      let toDate = zonedToUtc(scope.day.date, to.h, to.m, 0, series.timezone);
      if (toDate.getTime() <= fromDate.getTime()) {
        toDate = zonedToUtc(nextDate(scope.day.date), to.h, to.m, 0, series.timezone);
      }
      const fromLabel = `${String(from.h).padStart(2, '0')}:${String(from.m).padStart(2, '0')}`;
      const toLabel = `${String(to.h).padStart(2, '0')}:${String(to.m).padStart(2, '0')}`;
      return {
        kind: 'patch',
        patch: {
          set: { from: fromDate.toISOString(), to: toDate.toISOString() },
          del: ['at'],
        },
        headline: `Selected ${fromLabel}–${toLabel} (${series.timezone}) on ${scope.day.label}`,
        resolvedIntent: ['Range', `${fromLabel}–${toLabel}`, scope.day.label],
      };
    }

    // ── Query intents (numbers ALWAYS from Postgres) ──────────────────
    case 'top_channels': {
      const n = Math.min(20, Math.max(1, typeof input.n === 'number' ? Math.round(input.n) : 5));
      const metric = typeof input.metric === 'string' && ['peak', 'avg', 'watch_time'].includes(input.metric)
        ? (input.metric as 'peak' | 'avg' | 'watch_time')
        : 'peak';
      const language = typeof input.language === 'string' ? baseLang(input.language) : null;
      const tier = typeof input.tier === 'string' ? input.tier : null;
      const platform = typeof input.platform === 'string' ? input.platform.toLowerCase() : null;

      const queryScope: Scope = scope.level === 'series'
        ? { level: 'series', id: series.id }
        : scope.scope;
      const rows = await ViewershipSnapshotModel.getChannelLeaderboard(queryScope, 9999);
      const filtered = rows.filter((r) => {
        if (language && baseLang(r.language) !== language) return false;
        if (tier && r.tier !== tier) return false;
        if (platform && (r.platform ?? '').toLowerCase() !== platform) return false;
        return true;
      });
      const metricOf = (r: ViewershipSnapshotModel.LeaderboardEntry): number =>
        metric === 'peak' ? parseFloat(r.peak_ccv)
          : metric === 'avg' ? parseFloat(r.avg_ccv)
            : parseFloat(r.total_viewed_minutes) / 60;
      const top = filtered.sort((a, b) => metricOf(b) - metricOf(a)).slice(0, n);

      const chips = [`Top ${n}`, `by ${METRIC_LABELS[metric]}`];
      if (language) chips.push(language.toUpperCase());
      if (tier) chips.push(prettyTier(tier));
      if (platform) chips.push(platform);
      chips.push(scope.label);

      const qualifiers = [
        language ? language.toUpperCase() : null,
        tier ? prettyTier(tier).toLowerCase() : null,
        platform,
      ].filter(Boolean).join(' ');

      if (top.length === 0) {
        return {
          kind: 'answer',
          headline: `No ${qualifiers || ''} channels with data in ${scope.label}`.replace(/\s+/g, ' '),
          blocks: [],
          resolvedIntent: chips,
        };
      }

      // Follow-up actions: overlay the ranked channels on the chart (opt-in,
      // ≤8 lines), and the equivalent table filters when the ranking was
      // narrowed by language/tier/platform.
      const overlayIds = top.slice(0, 8).map((r) => r.channel_id);
      const suggestions: Array<{ label: string; patch: AskPatch }> = [
        {
          label: `Overlay top ${overlayIds.length} on chart`,
          patch: { set: { channels: overlayIds.join(',') }, del: [] },
        },
      ];
      const suggestionSet: Record<string, string> = {};
      if (language) suggestionSet.languages = language;
      if (tier) suggestionSet.tiers = tier;
      if (platform) suggestionSet.platforms = platform;
      if (Object.keys(suggestionSet).length > 0) {
        suggestions.push({ label: 'Apply as filters', patch: { set: suggestionSet, del: [] } });
      }

      return {
        kind: 'answer',
        headline: `Top ${top.length}${qualifiers ? ` ${qualifiers}` : ''} channels by ${METRIC_LABELS[metric]} · ${scope.label}`,
        blocks: [
          {
            type: 'table',
            columns: ['Channel', 'Platform', 'Tier', 'Lang', 'Peak', 'Avg', 'Hours'],
            rows: top.map((r) => [
              r.display_name,
              r.platform ?? '—',
              prettyTier(r.tier ?? 'community'),
              (baseLang(r.language) ?? '—').toUpperCase(),
              Math.round(parseFloat(r.peak_ccv) || 0),
              Math.round(parseFloat(r.avg_ccv) || 0),
              Math.round((parseFloat(r.total_viewed_minutes) || 0) / 60),
            ]),
          },
        ],
        resolvedIntent: chips,
        suggestions,
      };
    }

    case 'scoped_metric': {
      const metric = input.metric as 'peak' | 'average' | 'watch_time';
      const queryScope: Scope = scope.level === 'series'
        ? { level: 'series', id: series.id }
        : scope.scope;
      const chips = [METRIC_LABELS[metric] ?? String(metric), scope.label];

      if (metric === 'peak') {
        const peak = await ViewershipSnapshotModel.getPeakCCV(queryScope);
        if (!peak) {
          return { kind: 'answer', headline: `No viewership data in ${scope.label}`, blocks: [], resolvedIntent: chips };
        }
        return {
          kind: 'answer',
          headline: `Peak concurrent viewers · ${scope.label}`,
          blocks: [{
            type: 'stat',
            label: 'Peak CCV',
            value: Math.round(parseFloat(peak.total_ccv) || 0),
            sub: `at ${formatInTz(new Date(peak.timestamp), series.timezone)} (${series.timezone})`,
          }],
          resolvedIntent: chips,
          // Pin the peak minute on the timeline (a pinned moment and a
          // pinned range are mutually exclusive).
          chartPatch: { set: { at: new Date(peak.timestamp).toISOString() }, del: ['from', 'to'] },
        };
      }
      if (metric === 'average') {
        const avg = await ViewershipSnapshotModel.getAverageCCV(queryScope);
        return {
          kind: 'answer',
          headline: `Average concurrent viewers · ${scope.label}`,
          blocks: [{
            type: 'stat',
            label: 'Average CCV',
            value: Math.round(parseFloat(avg) || 0),
            sub: 'average of per-minute totals across live minutes',
          }],
          resolvedIntent: chips,
        };
      }
      const hours = await ViewershipSnapshotModel.getTotalViewedHours(queryScope);
      return {
        kind: 'answer',
        headline: `Total viewed hours · ${scope.label}`,
        blocks: [{
          type: 'stat',
          label: 'Viewed hours',
          value: Math.round(parseFloat(hours) || 0),
          sub: 'sum of every channel-minute of viewership',
        }],
        resolvedIntent: chips,
      };
    }

    case 'language_peak': {
      const language = baseLang(typeof input.language === 'string' ? input.language : null);
      if (!language || !vocab.languages.includes(language)) {
        return refusal('That language has no tracked channels in this series.', vocab, scope, ['Language peak', 'unknown language']);
      }
      const queryScope: Scope = scope.level === 'series'
        ? { level: 'series', id: series.id }
        : scope.scope;
      const rows = await ViewershipSnapshotModel.getLanguagePeaks(queryScope);
      const row = rows.find((r) => baseLang(r.language) === language);
      const chips = ['Language peak', language.toUpperCase(), scope.label];
      if (!row) {
        return {
          kind: 'answer',
          headline: `No ${language.toUpperCase()} viewership recorded in ${scope.label}`,
          blocks: [],
          resolvedIntent: chips,
        };
      }
      return {
        kind: 'answer',
        headline: `${language.toUpperCase()} viewership · ${scope.label}`,
        blocks: [
          {
            type: 'stat',
            label: `${language.toUpperCase()} peak CCV`,
            value: Math.round(parseFloat(row.peak_ccv) || 0),
            sub: `at ${formatInTz(new Date(row.peak_at), series.timezone)} (${series.timezone})`,
          },
          {
            type: 'stat',
            label: 'Average CCV',
            value: Math.round(parseFloat(row.avg_ccv) || 0),
          },
          {
            type: 'stat',
            label: 'Viewed hours',
            value: Math.round((parseFloat(row.viewer_minutes) || 0) / 60),
          },
        ],
        resolvedIntent: chips,
        // Pin the language's peak minute on the timeline.
        chartPatch: { set: { at: new Date(row.peak_at).toISOString() }, del: ['from', 'to'] },
        suggestions: [
          { label: `Filter to ${language.toUpperCase()}`, patch: { set: { languages: language }, del: [] } },
        ],
      };
    }

    case 'refuse': {
      const message = typeof input.message === 'string' && input.message.trim()
        ? input.message.trim()
        : 'I can only answer questions about this tournament’s viewership.';
      const reason = typeof input.reason === 'string' ? input.reason : 'unsupported';
      return refusal(message, vocab, scope, ['Refused', reason.replace(/_/g, ' ')]);
    }

    default:
      // Unknown intent name — the compiler validates against the catalog, so
      // this is a belt-and-braces fallback, not a user-visible path.
      return refusal('I could not map that question onto anything this page can do.', vocab, scope, ['Refused', 'unknown intent']);
  }
}
