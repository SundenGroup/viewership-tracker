/**
 * Live views: the read side. Picks the row that speaks for each channel on
 * each broadcast day (utils/views-math), sums days into a scope and keeps
 * measured, adjusted and estimated apart all the way up.
 */
import type { Knex } from 'knex';
import {
  isLateRead,
  pickBestViews,
  type ShareMethod,
  type ViewsConfidence,
  type ViewsRowLite,
  type ViewsSnapshot,
  type ViewsSource,
} from '../utils/views-math';

export type ViewsTarget =
  | { kind: 'single'; scope: 'day' | 'stage' | 'series'; id: string }
  | { kind: 'multi_stage'; ids: string[] };

export interface ViewsFilter {
  languages?: string[];
  platforms?: string[];
  excludeChannelIds?: string[];
}

export interface ChannelViews {
  channelId: string;
  displayName: string;
  platform: string;
  tier: string | null;
  language: string | null;
  /** What counts for the scope: the best row per day, summed over the days. */
  liveViews: number;
  /** The platform's own number(s) behind it, before any window share. */
  platformViews: number;
  confidence: ViewsConfidence;
  sources: ViewsSource[];
  methods: ShareMethod[];
  note: string | null;
  days: number;
}

export interface ViewsSplit {
  liveViews: number;
  measured: number;
  adjusted: number;
  estimated: number;
  channels: { measured: number; adjusted: number; estimated: number };
}

export interface ViewsDayStatus {
  dayId: string;
  label: string;
  date: string;
  status: string;
  passes: string[];
  collected: boolean;
  /** The 36-hour pass has run, so Twitch's live views are in. */
  complete: boolean;
  channels: { measured: number; adjusted: number; estimated: number };
}

export interface ViewsSummary {
  channels: ChannelViews[];
  totals: ViewsSplit;
  byPlatform: Array<{ platform: string } & ViewsSplit>;
  days: ViewsDayStatus[];
  /** Caveats a reader of the numbers has to know (late reads that include replays). */
  notes: string[];
}

interface JoinedRow {
  channel_id: string;
  broadcast_day_id: string;
  source: ViewsSource;
  snapshot: ViewsSnapshot;
  counted: boolean;
  confidence: ViewsConfidence;
  event_share_method: ShareMethod | null;
  views: string | number | null;
  event_views: string | number | null;
  stream_ref: string;
  note: string | null;
  broadcast_ended_at: Date | string | null;
  fetched_at: Date | string | null;
  extra: Record<string, unknown> | string | null;
  display_name: string;
  platform: string;
  tier: string | null;
  language: string | null;
}

const CONF_ORDER: Record<ViewsConfidence, number> = { measured: 0, adjusted: 1, estimated: 2, replay: 3 };

const PLATFORM_NAME: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', soop: 'SOOP', tiktok: 'TikTok', kick: 'Kick' };

function toDate(v: Date | string | null): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function extraOf(v: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!v) return {};
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function emptySplit(): ViewsSplit {
  return { liveViews: 0, measured: 0, adjusted: 0, estimated: 0, channels: { measured: 0, adjusted: 0, estimated: 0 } };
}

function addToSplit(split: ViewsSplit, confidence: ViewsConfidence, views: number, countChannel: boolean): void {
  split.liveViews += views;
  if (confidence === 'measured' || confidence === 'adjusted' || confidence === 'estimated') {
    split[confidence] += views;
    if (countChannel) split.channels[confidence] += 1;
  }
}

export async function resolveDays(
  db: Knex,
  target: ViewsTarget,
  seriesId?: string,
): Promise<Array<{ id: string; label: string; date: string; status: string }>> {
  const q = db('broadcast_days').select('id', 'label', 'date', 'status').orderBy('date', 'asc');
  // Public callers pass their series: an id from another series resolves to nothing.
  if (seriesId) q.where('series_id', seriesId);
  if (target.kind === 'multi_stage') q.whereIn('stage_id', target.ids);
  else if (target.scope === 'day') q.where('id', target.id);
  else if (target.scope === 'stage') q.where('stage_id', target.id);
  else q.where('series_id', target.id);
  const rows = (await q) as Array<{ id: string; label: string; date: string | Date; status: string }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    status: r.status,
  }));
}

export async function loadViewsSummary(
  db: Knex,
  target: ViewsTarget,
  filter?: ViewsFilter,
  seriesId?: string,
): Promise<ViewsSummary> {
  const days = await resolveDays(db, target, seriesId);
  const dayIds = days.map((d) => d.id);
  if (dayIds.length === 0) return { channels: [], totals: emptySplit(), byPlatform: [], days: [], notes: [] };

  const q = db('stream_views as sv')
    .join('channels as c', 'c.id', 'sv.channel_id')
    .whereIn('sv.broadcast_day_id', dayIds)
    .select(
      'sv.channel_id',
      'sv.broadcast_day_id',
      'sv.source',
      'sv.snapshot',
      'sv.counted',
      'sv.confidence',
      'sv.event_share_method',
      'sv.views',
      'sv.event_views',
      'sv.stream_ref',
      'sv.note',
      'sv.broadcast_ended_at',
      'sv.fetched_at',
      'sv.extra',
      'c.display_name',
      'c.platform',
      'c.tier',
      'c.language',
    );
  if (filter?.languages?.length) q.whereRaw('lower(c.language) = ANY(?)', [filter.languages.map((l) => l.toLowerCase())]);
  if (filter?.platforms?.length) q.whereRaw('lower(c.platform::text) = ANY(?)', [filter.platforms.map((p) => p.toLowerCase())]);
  if (filter?.excludeChannelIds?.length) q.whereNotIn('sv.channel_id', filter.excludeChannelIds);
  const rows = (await q) as JoinedRow[];

  const runs = (await db('stream_views_runs').whereIn('broadcast_day_id', dayIds).select('broadcast_day_id', 'snapshot')) as Array<{
    broadcast_day_id: string;
    snapshot: string;
  }>;
  const passesByDay = new Map<string, string[]>();
  for (const r of runs) passesByDay.set(r.broadcast_day_id, [...(passesByDay.get(r.broadcast_day_id) ?? []), r.snapshot]);

  // group rows by channel and day
  const byChannelDay = new Map<string, JoinedRow[]>();
  for (const r of rows) {
    const k = `${r.channel_id}|${r.broadcast_day_id}`;
    const list = byChannelDay.get(k);
    if (list) list.push(r);
    else byChannelDay.set(k, [r]);
  }

  const channels = new Map<string, ChannelViews>();
  const dayCounts = new Map<string, { measured: number; adjusted: number; estimated: number }>();
  // Views go into the split day by day: a channel measured on Day 1 and
  // estimated on Day 2 contributes to both buckets, not to the weaker one.
  const totals = emptySplit();
  const platforms = new Map<string, ViewsSplit>();
  const lateReads = new Map<string, number>();
  for (const [k, list] of byChannelDay) {
    const lite: ViewsRowLite[] = list.map((r) => ({
      source: r.source,
      snapshot: r.snapshot,
      counted: r.counted,
      confidence: r.confidence,
      eventShareMethod: r.event_share_method,
      views: r.views == null ? null : Number(r.views),
      eventViews: r.event_views == null ? null : Number(r.event_views),
      streamRef: r.stream_ref,
      note: r.note,
      late:
        isLateRead(String(r.platform), r.source, toDate(r.broadcast_ended_at), toDate(r.fetched_at)) ||
        extraOf(r.extra).includes_replays === true,
    }));
    const best = pickBestViews(lite);
    if (!best) continue;
    // Public counters keep growing with replays: a read after the live window says so.
    if (best.late) lateReads.set(String(list[0].platform), (lateReads.get(String(list[0].platform)) ?? 0) + 1);
    const [channelId, dayId] = k.split('|');
    const head = list[0];
    const dc = dayCounts.get(dayId) ?? { measured: 0, adjusted: 0, estimated: 0 };
    if (best.confidence !== 'replay') dc[best.confidence] += 1;
    dayCounts.set(dayId, dc);
    addToSplit(totals, best.confidence, best.eventViews, false);
    const ps = platforms.get(String(head.platform)) ?? emptySplit();
    addToSplit(ps, best.confidence, best.eventViews, false);
    platforms.set(String(head.platform), ps);
    const cur = channels.get(channelId);
    if (!cur) {
      channels.set(channelId, {
        channelId,
        displayName: head.display_name,
        platform: String(head.platform),
        tier: head.tier,
        language: head.language,
        liveViews: best.eventViews,
        platformViews: best.views,
        confidence: best.confidence,
        sources: [best.source],
        methods: best.method ? [best.method] : [],
        note: best.note,
        days: 1,
      });
    } else {
      cur.liveViews += best.eventViews;
      cur.platformViews += best.views;
      if (CONF_ORDER[best.confidence] > CONF_ORDER[cur.confidence]) cur.confidence = best.confidence;
      if (!cur.sources.includes(best.source)) cur.sources.push(best.source);
      if (best.method && !cur.methods.includes(best.method)) cur.methods.push(best.method);
      if (best.note && !(cur.note ?? '').includes(best.note)) cur.note = cur.note ? `${cur.note}; ${best.note}` : best.note;
      cur.days += 1;
    }
  }

  const list = [...channels.values()].sort((a, b) => b.liveViews - a.liveViews);
  // Channel counts use the channel's weakest day: one estimated day makes it an estimated channel.
  for (const c of list) {
    if (c.confidence === 'replay') continue;
    totals.channels[c.confidence] += 1;
    const ps = platforms.get(c.platform);
    if (ps) ps.channels[c.confidence] += 1;
  }

  const notes: string[] = [];
  const lateTotal = [...lateReads.values()].reduce((a, n) => a + n, 0);
  if (lateTotal > 0) {
    const parts = [...lateReads.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} on ${PLATFORM_NAME[p] ?? p}`);
    notes.push(
      `${lateTotal} stream${lateTotal === 1 ? ' was' : 's were'} first read after the live window (${parts.join(', ')}), so ${lateTotal === 1 ? 'its count includes' : 'their counts include'} replay views since then: about 2% a day on Twitch, more on YouTube.`,
    );
  }

  return {
    channels: list,
    totals,
    notes,
    byPlatform: [...platforms.entries()]
      .map(([platform, split]) => ({ platform, ...split }))
      .sort((a, b) => b.liveViews - a.liveViews),
    days: days.map((d) => {
      const passes = passesByDay.get(d.id) ?? [];
      return {
        dayId: d.id,
        label: d.label,
        date: d.date,
        status: d.status,
        passes,
        collected: passes.length > 0 || dayCounts.has(d.id),
        complete: passes.includes('plus_36h') || passes.includes('plus_7d'),
        channels: dayCounts.get(d.id) ?? { measured: 0, adjusted: 0, estimated: 0 },
      };
    }),
  };
}
