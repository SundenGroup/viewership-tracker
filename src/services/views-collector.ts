/**
 * Views collector (plan: docs/plans/2026-09-16-views-roundup.md).
 *
 * After a broadcast day has completed, read what each platform says about
 * the streams we tracked that day and store it in `stream_views`:
 *
 *   plus_3h   YouTube's public counter once it has settled (it lags while a
 *             stream is live), SOOP's cumulative viewers from the replay.
 *   plus_36h  Twitch archives: the live views land on the VOD in a daily
 *             batch 18 to 24 hours after the stream, so this is the first
 *             pass that can see them. YouTube, SOOP and Kick again.
 *   plus_7d   Twitch and YouTube once more, so the replay growth is visible.
 *
 * Every pass also writes an estimate per channel (our viewer-hours times a
 * platform factor). Reads pick the best row per channel and day; estimates
 * only speak when nothing measured exists. Kick's number counts replays
 * only and is stored uncounted.
 *
 * The collector never deletes: a VOD that vanished before the 7-day pass
 * keeps its 36-hour row.
 */
import axios from 'axios';
import type { Knex } from 'knex';
import logger from '../utils/logger';
import type { AdapterRegistry } from '../adapters';
import type { TwitchAdapter, TwitchArchiveVideo } from '../adapters/twitch';
import type { YouTubeAdapter, YouTubeVideoFacts } from '../adapters/youtube';
import {
  DEFAULT_VIEWS_PER_VIEWER_HOUR,
  estimateViews,
  eventShare,
  overlaps,
  parseSoopBroadNo,
  windowedViews,
  type ShareMethod,
  type ViewsConfidence,
  type ViewsSnapshot,
  type ViewsSource,
} from '../utils/views-math';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MATCH_MARGIN_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

export type CollectorPass = 'plus_3h' | 'plus_36h' | 'plus_7d';

/** Views per viewer-hour per platform. TikTok counts every room entry (about 20, PEC Fall Playoffs 1 Day 3). */
const DEFAULT_FACTORS: Record<string, number> = { tiktok: 20 };

/** Why a platform has no measured number; the estimate row says so. */
const NO_SOURCE_REASON: Record<string, string> = {
  tiktok: 'TikTok has no public view count: enter the LIVE Center "Total views" to replace this estimate',
  steam: 'Steam publishes no view count',
  kick: 'Kick publishes replay views only; live views are estimated',
};

function noSourceReason(platform: string): string {
  return NO_SOURCE_REASON[platform] ?? 'no public view count on this platform';
}

export function viewsFactor(platform: string): number {
  try {
    const raw = process.env.VIEWS_FACTORS;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = Number(parsed[platform]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    // fall through to the defaults
  }
  return DEFAULT_FACTORS[platform] ?? DEFAULT_VIEWS_PER_VIEWER_HOUR;
}

interface DayRow {
  id: string;
  series_id: string;
  stage_id: string;
  label: string;
  status: string;
  broadcast_start: Date | null;
  broadcast_end: Date | null;
}

interface ChannelDay {
  channelId: string;
  platform: string;
  identifier: string;
  displayName: string;
  trackedMinutes: number;
  viewerMinutes: number;
  t0: Date;
  t1: Date;
  /** Stream ids stored on the day's snapshots, most frequent first. */
  streamIds: string[];
  /** How many snapshots carried each stored stream id. */
  streamIdCounts: Map<string, number>;
}

interface ViewsRow {
  channel_id: string;
  broadcast_day_id: string;
  series_id: string;
  stage_id: string;
  platform: string;
  stream_ref: string;
  source: ViewsSource;
  snapshot: ViewsSnapshot;
  views: number | null;
  counted: boolean;
  broadcast_started_at: Date | null;
  broadcast_ended_at: Date | null;
  broadcast_minutes: number | null;
  tracked_minutes: number | null;
  event_share: number | null;
  event_share_method: ShareMethod | null;
  event_views: number | null;
  confidence: ViewsConfidence;
  extra: string;
  note: string | null;
  fetched_at: Date;
}

export interface CollectSummary {
  dayId: string;
  label: string;
  pass: CollectorPass;
  channels: number;
  rowsBySource: Record<string, number>;
  missing: Array<{ channel: string; platform: string; reason: string }>;
  durationMs: number;
}

export interface ManualViewsEntry {
  channelId: string;
  source: 'tiktok_livecenter' | 'twitch_stream_summary' | 'csv_import';
  views: number;
  extra?: Record<string, unknown>;
  note?: string;
}

interface Span {
  start: Date;
  end: Date;
}

export class ViewsCollector {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly db: Knex,
  ) {}

  // ── Scheduling ───────────────────────────────────────────────────────

  /** Which pass a day is due for at `now`, given the passes already run. */
  static duePass(broadcastEnd: Date, ran: Set<string>, now: Date): CollectorPass | null {
    const age = now.getTime() - broadcastEnd.getTime();
    if (age >= 7 * 24 * HOUR_MS) return ran.has('plus_7d') ? null : 'plus_7d';
    if (age >= 36 * HOUR_MS) return ran.has('plus_36h') ? null : 'plus_36h';
    if (age >= 3 * HOUR_MS) return ran.has('plus_3h') ? null : 'plus_3h';
    return null;
  }

  /**
   * Run whatever is due. Skipped entirely while a broadcast day is live:
   * the reads are light, but nothing here is worth a slower poll.
   */
  async collectDue(now = new Date(), maxDays = 6): Promise<CollectSummary[]> {
    const live = await this.db('broadcast_days').where('status', 'live').first('id');
    if (live) {
      logger.info('[Views] a broadcast day is live, collector pass skipped');
      return [];
    }
    const days = (await this.db('broadcast_days')
      .where('status', 'completed')
      .whereNotNull('broadcast_end')
      .where('broadcast_end', '>=', new Date(now.getTime() - 10 * 24 * HOUR_MS))
      .where('broadcast_end', '<=', new Date(now.getTime() - 3 * HOUR_MS))
      .orderBy('broadcast_end', 'asc')
      .select('id', 'broadcast_end')) as Array<{ id: string; broadcast_end: Date }>;
    if (days.length === 0) return [];
    const runs = (await this.db('stream_views_runs')
      .whereIn('broadcast_day_id', days.map((d) => d.id))
      .select('broadcast_day_id', 'snapshot')) as Array<{ broadcast_day_id: string; snapshot: string }>;
    const ranByDay = new Map<string, Set<string>>();
    for (const r of runs) {
      const set = ranByDay.get(r.broadcast_day_id) ?? new Set<string>();
      set.add(r.snapshot);
      ranByDay.set(r.broadcast_day_id, set);
    }
    const out: CollectSummary[] = [];
    for (const d of days) {
      if (out.length >= maxDays) break;
      const pass = ViewsCollector.duePass(new Date(d.broadcast_end), ranByDay.get(d.id) ?? new Set(), now);
      if (!pass) continue;
      try {
        out.push(await this.collectDay(d.id, pass));
      } catch (err) {
        logger.error('[Views] collector pass failed', { dayId: d.id, pass, error: (err as Error).message });
      }
    }
    return out;
  }

  /** The pass a manual run stands in for, by the day's age. */
  static passForAge(broadcastEnd: Date | null, now = new Date()): CollectorPass {
    if (!broadcastEnd) return 'plus_36h';
    const age = now.getTime() - broadcastEnd.getTime();
    if (age >= 7 * 24 * HOUR_MS) return 'plus_7d';
    if (age >= 36 * HOUR_MS) return 'plus_36h';
    return 'plus_3h';
  }

  // ── One day ──────────────────────────────────────────────────────────

  async collectDay(dayId: string, pass?: CollectorPass): Promise<CollectSummary> {
    const started = Date.now();
    const day = (await this.db('broadcast_days').where('id', dayId).first()) as DayRow | undefined;
    if (!day) throw new Error('broadcast day not found');
    if (day.status !== 'completed') throw new Error('views are collected for completed broadcast days only');
    const snapshot: CollectorPass = pass ?? ViewsCollector.passForAge(day.broadcast_end);

    const cds = await this.loadChannelDays(dayId);
    const rows: ViewsRow[] = [];
    const reasons = new Map<string, string>();

    await this.step('live readings', () => this.collectLiveReadings(day, cds, rows));
    await this.step('youtube', () => this.collectYouTube(day, cds, snapshot, rows, reasons));
    await this.step('soop', () => this.collectSoop(day, cds, snapshot, rows, reasons));
    if (snapshot !== 'plus_3h') {
      await this.step('twitch', () => this.collectTwitch(day, cds, snapshot, rows, reasons));
    } else {
      for (const cd of cds) {
        if (cd.platform === 'twitch') reasons.set(cd.channelId, 'Twitch adds the live views to the VOD about a day after the stream');
      }
    }
    if (snapshot === 'plus_36h') {
      await this.step('kick', () => this.collectKick(day, cds, snapshot, rows, reasons));
    }
    this.addEstimates(day, cds, rows, reasons);

    await this.upsert(rows);
    const rowsBySource: Record<string, number> = {};
    for (const r of rows) rowsBySource[r.source] = (rowsBySource[r.source] ?? 0) + 1;
    const measured = new Set(rows.filter((r) => r.counted && r.source !== 'estimate').map((r) => r.channel_id));
    const missing = cds
      .filter((cd) => !measured.has(cd.channelId))
      .map((cd) => ({
        channel: cd.displayName,
        platform: cd.platform,
        reason: reasons.get(cd.channelId) ?? noSourceReason(cd.platform),
      }));
    const summary: CollectSummary = {
      dayId,
      label: day.label,
      pass: snapshot,
      channels: cds.length,
      rowsBySource,
      missing,
      durationMs: Date.now() - started,
    };
    await this.db('stream_views_runs')
      .insert({
        broadcast_day_id: dayId,
        snapshot,
        ran_at: new Date(),
        summary: JSON.stringify({ channels: cds.length, rowsBySource, missing: missing.length }),
      })
      .onConflict(['broadcast_day_id', 'snapshot'])
      .merge();
    logger.info(`[Views] ${day.label} ${snapshot}: ${cds.length} channels, ${JSON.stringify(rowsBySource)}, ${missing.length} without a measured source, ${summary.durationMs}ms`);
    return summary;
  }

  /** Numbers the channel owner handed over (TikTok LIVE Center card, Twitch Stream Summary, a CSV). */
  async importManual(dayId: string, entries: ManualViewsEntry[]): Promise<number> {
    const day = (await this.db('broadcast_days').where('id', dayId).first()) as DayRow | undefined;
    if (!day) throw new Error('broadcast day not found');
    const channels = (await this.db('channels')
      .whereIn('id', entries.map((e) => e.channelId))
      .where('series_id', day.series_id)
      .select('id', 'platform')) as Array<{ id: string; platform: string }>;
    const platformOf = new Map(channels.map((c) => [c.id, c.platform]));
    const now = new Date();
    const rows: ViewsRow[] = [];
    for (const e of entries) {
      const platform = platformOf.get(e.channelId);
      if (!platform) throw new Error(`channel ${e.channelId} is not part of this series`);
      if (!Number.isFinite(e.views) || e.views < 0) throw new Error('views must be a number of zero or more');
      rows.push({
        channel_id: e.channelId,
        broadcast_day_id: day.id,
        series_id: day.series_id,
        stage_id: day.stage_id,
        platform,
        stream_ref: '',
        source: e.source,
        snapshot: 'manual',
        views: Math.round(e.views),
        counted: true,
        broadcast_started_at: null,
        broadcast_ended_at: null,
        broadcast_minutes: null,
        tracked_minutes: null,
        event_share: 1,
        event_share_method: 'full',
        event_views: Math.round(e.views),
        confidence: 'measured',
        extra: JSON.stringify(e.extra ?? {}),
        note: e.note ?? null,
        fetched_at: now,
      });
    }
    await this.upsert(rows);
    return rows.length;
  }

  // ── Loading ──────────────────────────────────────────────────────────

  private async loadChannelDays(dayId: string): Promise<ChannelDay[]> {
    const base = (await this.db('viewership_minute_rollup as r')
      .join('channels as c', 'c.id', 'r.channel_id')
      .where('r.broadcast_day_id', dayId)
      .where('r.ccv', '>', 0)
      .groupBy('c.id', 'c.platform', 'c.channel_identifier', 'c.display_name')
      .select('c.id', 'c.platform', 'c.channel_identifier', 'c.display_name')
      .count('* as tracked_minutes')
      .sum('r.ccv as viewer_minutes')
      .min('r.minute_bucket as t0')
      .max('r.minute_bucket as t1')) as unknown as Array<{
      id: string;
      platform: string;
      channel_identifier: string;
      display_name: string;
      tracked_minutes: string;
      viewer_minutes: string;
      t0: Date;
      t1: Date;
    }>;
    const ids = (await this.db('viewership_snapshots')
      .where('broadcast_day_id', dayId)
      .where('concurrent_viewers', '>', 0)
      .whereNotNull('stream_id')
      .groupBy('channel_id', 'stream_id')
      .select('channel_id', 'stream_id')
      .count('* as n')) as unknown as Array<{ channel_id: string; stream_id: string; n: string }>;
    const byChannel = new Map<string, Array<{ id: string; n: number }>>();
    for (const r of ids) {
      if (r.stream_id.startsWith('unknown-')) continue;
      const list = byChannel.get(r.channel_id) ?? [];
      list.push({ id: r.stream_id, n: Number(r.n) });
      byChannel.set(r.channel_id, list);
    }
    return base.map((r) => ({
      channelId: r.id,
      platform: String(r.platform),
      identifier: r.channel_identifier,
      displayName: r.display_name,
      trackedMinutes: Number(r.tracked_minutes),
      viewerMinutes: Number(r.viewer_minutes),
      t0: new Date(r.t0),
      t1: new Date(new Date(r.t1).getTime() + 60_000),
      streamIds: (byChannel.get(r.id) ?? []).sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.id),
      streamIdCounts: new Map((byChannel.get(r.id) ?? []).map((x) => [x.id, x.n])),
    }));
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.warn(`[Views] ${name} step failed, continuing`, { error: (err as Error).message });
    }
  }

  private baseRow(day: DayRow, cd: ChannelDay, source: ViewsSource, snapshot: ViewsSnapshot): ViewsRow {
    return {
      channel_id: cd.channelId,
      broadcast_day_id: day.id,
      series_id: day.series_id,
      stage_id: day.stage_id,
      platform: cd.platform,
      stream_ref: '',
      source,
      snapshot,
      views: null,
      counted: true,
      broadcast_started_at: null,
      broadcast_ended_at: null,
      broadcast_minutes: null,
      tracked_minutes: cd.trackedMinutes,
      event_share: null,
      event_share_method: null,
      event_views: null,
      confidence: 'measured',
      extra: '{}',
      note: null,
      fetched_at: new Date(),
    };
  }

  /** Discover's per-minute audience over the given spans, whatever tracker saw the channel. */
  private async discoverViewerMinutes(
    platform: string,
    identifier: string,
    spans: Span[],
  ): Promise<{ minutes: number; viewerMinutes: number }> {
    if (spans.length === 0) return { minutes: 0, viewerMinutes: 0 };
    const ident = identifier.toLowerCase().replace(/^@/, '').split(':')[0];
    const channelIds = (await this.db('channels')
      .where('platform', platform)
      .whereRaw("lower(regexp_replace(channel_identifier, '^@', '')) = ?", [ident])
      .pluck('id')) as string[];
    if (channelIds.length === 0) return { minutes: 0, viewerMinutes: 0 };
    const conds = spans.map(() => '(g."timestamp" >= ? AND g."timestamp" <= ?)').join(' OR ');
    const bindings: Array<string[] | Date> = [channelIds];
    for (const s of spans) bindings.push(s.start, s.end);
    const res = await this.db.raw(
      `WITH m AS (
         SELECT date_trunc('minute', g."timestamp") AS mi, max(g.concurrent_viewers) AS ccv
           FROM game_tracker_snapshots g
          WHERE g.channel_id = ANY(?) AND (${conds}) AND g.concurrent_viewers > 0
          GROUP BY 1)
       SELECT count(*)::int AS minutes, coalesce(sum(ccv), 0)::bigint AS vm FROM m`,
      bindings,
    );
    const row = (res as { rows: Array<{ minutes: number; vm: string }> }).rows[0];
    return { minutes: Number(row?.minutes ?? 0), viewerMinutes: Number(row?.vm ?? 0) };
  }

  /** Share of a set of past broadcasts that belongs to the tracked span. */
  private async shareFor(cd: ChannelDay, spans: Span[]): Promise<{ share: number; method: ShareMethod; note: string | null; minutes: number }> {
    const minutes = Math.round(spans.reduce((a, s) => a + (s.end.getTime() - s.start.getTime()) / 60_000, 0));
    const quick = eventShare({ trackedMinutes: cd.trackedMinutes, trackedViewerMinutes: cd.viewerMinutes, broadcastMinutes: minutes });
    if (quick.method === 'full') return { ...quick, note: null, minutes };
    const disc = await this.discoverViewerMinutes(cd.platform, cd.identifier, spans);
    const coverage = minutes > 0 ? disc.minutes / minutes : 0;
    const s = eventShare({
      trackedMinutes: cd.trackedMinutes,
      trackedViewerMinutes: cd.viewerMinutes,
      broadcastMinutes: minutes,
      fullViewerMinutes: disc.viewerMinutes,
      fullCoverage: coverage,
    });
    const note =
      s.method === 'viewer_minutes'
        ? `broadcast ${minutes} min, tracked ${cd.trackedMinutes} min; share by viewer-minutes (Discover covers ${Math.round(coverage * 100)}%)`
        : `broadcast ${minutes} min, tracked ${cd.trackedMinutes} min; share by time, flat audience assumed (Discover covers ${Math.round(coverage * 100)}%)`;
    return { ...s, note, minutes };
  }

  // ── Platform steps ───────────────────────────────────────────────────

  private async collectLiveReadings(day: DayRow, cds: ChannelDay[], rows: ViewsRow[]): Promise<void> {
    const yt = cds.filter((cd) => cd.platform === 'youtube');
    if (yt.length === 0) return;
    const readings = (await this.db('stream_view_readings')
      .where('broadcast_day_id', day.id)
      .whereIn('channel_id', yt.map((cd) => cd.channelId))
      .select('channel_id', 'stream_ref', 'read_at', 'views')) as Array<{ channel_id: string; stream_ref: string; read_at: Date; views: string }>;
    if (readings.length === 0) return;
    const byStream = new Map<string, Array<{ readAt: Date; views: number }>>();
    for (const r of readings) {
      const k = `${r.channel_id}|${r.stream_ref}`;
      const list = byStream.get(k) ?? [];
      list.push({ readAt: new Date(r.read_at), views: Number(r.views) });
      byStream.set(k, list);
    }
    for (const cd of yt) {
      const windowStart = day.broadcast_start ? new Date(Math.min(day.broadcast_start.getTime(), cd.t0.getTime())) : cd.t0;
      const windowEnd = day.broadcast_end ? new Date(Math.max(day.broadcast_end.getTime(), cd.t1.getTime())) : cd.t1;
      for (const [k, list] of byStream) {
        if (!k.startsWith(`${cd.channelId}|`)) continue;
        const w = windowedViews(list, windowStart, windowEnd);
        if (!w) continue;
        const row = this.baseRow(day, cd, 'youtube_live', 'live_end');
        row.stream_ref = k.split('|')[1];
        row.views = w.last;
        row.event_views = w.views;
        row.event_share_method = w.method;
        row.event_share = w.last > 0 ? Number((w.views / w.last).toFixed(4)) : 1;
        row.confidence = w.method === 'full' ? 'measured' : 'adjusted';
        row.note =
          w.method === 'windowed'
            ? 'views inside the broadcast window from the live counter (the counter lags while live)'
            : 'live counter at the end of the broadcast window (lags while live)';
        rows.push(row);
      }
    }
  }

  private async collectYouTube(
    day: DayRow,
    cds: ChannelDay[],
    snapshot: CollectorPass,
    rows: ViewsRow[],
    reasons: Map<string, string>,
  ): Promise<void> {
    const yt = cds.filter((cd) => cd.platform === 'youtube');
    if (yt.length === 0) return;
    const adapter = this.registry.getAdapter('youtube') as YouTubeAdapter;
    const facts = new Map<string, YouTubeVideoFacts>();
    const stored = [...new Set(yt.flatMap((cd) => cd.streamIds))];
    for (const f of await adapter.getVideosByIds(stored)) facts.set(f.videoId, f);
    const tabCache = new Map<string, string[]>();
    const now = new Date();

    const matches = (cd: ChannelDay, f: YouTubeVideoFacts | undefined): f is YouTubeVideoFacts => {
      if (!f || !f.actualStartTime) return false;
      const uc = cd.identifier.split(':')[0];
      if (uc.startsWith('UC') && f.channelId.toLowerCase() !== uc.toLowerCase()) return false;
      const start = new Date(f.actualStartTime);
      const end = f.actualEndTime ? new Date(f.actualEndTime) : now;
      return overlaps(start, end, cd.t0, cd.t1, MATCH_MARGIN_MS);
    };

    // One video speaks for one row: a multi-stream parent and its slot rows can
    // both have stored the same id (a binding swap, a bled id), so each id goes
    // to the row that carried it on the most snapshots.
    const owner = new Map<string, string>();
    for (const cd of yt) {
      for (const id of cd.streamIds) {
        if (!matches(cd, facts.get(id))) continue;
        const cur = owner.get(id);
        const curN = cur ? (yt.find((x) => x.channelId === cur)?.streamIdCounts.get(id) ?? 0) : -1;
        if ((cd.streamIdCounts.get(id) ?? 0) > curN) owner.set(id, cd.channelId);
      }
    }

    for (const cd of yt) {
      let hits = cd.streamIds
        .filter((id) => owner.get(id) === cd.channelId)
        .map((id) => facts.get(id))
        .filter((f): f is YouTubeVideoFacts => matches(cd, f));
      if (hits.length === 0) {
        // Stored ids can be bled from other pages; the channel's own Live tab is the fallback.
        const uc = cd.identifier.split(':')[0];
        if (!tabCache.has(uc)) tabCache.set(uc, await this.youtubeLiveTabIds(uc));
        const unseen = (tabCache.get(uc) ?? []).filter((id) => !facts.has(id));
        if (unseen.length > 0) for (const f of await adapter.getVideosByIds(unseen)) facts.set(f.videoId, f);
        hits = (tabCache.get(uc) ?? [])
          .filter((id) => !owner.has(id))
          .map((id) => facts.get(id))
          .filter((f): f is YouTubeVideoFacts => matches(cd, f));
        // A slot row stands for exactly one stream of the channel.
        if (cd.identifier.includes(':stream-') && hits.length > 1) hits = hits.slice(0, 1);
        for (const f of hits) owner.set(f.videoId, cd.channelId);
      }
      hits = hits.filter((f) => f.viewCount != null);
      if (hits.length === 0) {
        reasons.set(cd.channelId, 'stream not found on the channel (deleted, unlisted, views hidden, or a bled video id)');
        continue;
      }
      const spans = hits.map((f) => ({ start: new Date(f.actualStartTime as string), end: f.actualEndTime ? new Date(f.actualEndTime) : now }));
      const s = await this.shareFor(cd, spans);
      for (let i = 0; i < hits.length; i++) {
        const f = hits[i];
        const row = this.baseRow(day, cd, 'youtube_public', snapshot);
        row.stream_ref = f.videoId;
        row.views = f.viewCount;
        row.broadcast_started_at = spans[i].start;
        row.broadcast_ended_at = f.actualEndTime ? spans[i].end : null;
        row.broadcast_minutes = Math.round((spans[i].end.getTime() - spans[i].start.getTime()) / 60_000);
        row.event_share = Number(s.share.toFixed(4));
        row.event_share_method = s.method;
        row.event_views = Math.round((f.viewCount as number) * s.share);
        row.confidence = s.method === 'full' ? 'measured' : 'adjusted';
        const lateDays = f.actualEndTime ? (now.getTime() - spans[i].end.getTime()) / 86_400_000 : 0;
        row.note =
          [
            s.note,
            f.isLiveNow ? 'stream still live at read time' : null,
            lateDays >= 0.5 ? `read ${lateDays.toFixed(1)} days after the stream, replay views since then included` : null,
          ]
            .filter(Boolean)
            .join('; ') || null;
        rows.push(row);
      }
    }
  }

  private async youtubeLiveTabIds(channelRef: string): Promise<string[]> {
    const url = channelRef.startsWith('UC')
      ? `https://www.youtube.com/channel/${channelRef}/streams`
      : `https://www.youtube.com/${channelRef.startsWith('@') ? channelRef : `@${channelRef}`}/streams`;
    try {
      const { data } = await axios.get<string>(url, {
        timeout: 15_000,
        responseType: 'text',
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
      });
      const ids: string[] = [];
      for (const m of String(data).matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
        if (!ids.includes(m[1])) ids.push(m[1]);
        if (ids.length >= 40) break;
      }
      return ids;
    } catch {
      return [];
    }
  }

  private async collectTwitch(
    day: DayRow,
    cds: ChannelDay[],
    snapshot: CollectorPass,
    rows: ViewsRow[],
    reasons: Map<string, string>,
  ): Promise<void> {
    const tw = cds.filter((cd) => cd.platform === 'twitch');
    if (tw.length === 0) return;
    const adapter = this.registry.getAdapter('twitch') as TwitchAdapter;
    const users = await adapter.getUsersByLogin([...new Set(tw.map((cd) => cd.identifier.toLowerCase()))]);
    const byLogin = new Map(users.map((u) => [u.login.toLowerCase(), u]));
    for (const cd of tw) {
      const user = byLogin.get(cd.identifier.toLowerCase());
      if (!user) {
        reasons.set(cd.channelId, 'Twitch login not found (renamed or banned)');
        continue;
      }
      const archives: TwitchArchiveVideo[] = await adapter.getArchiveVideos(user.id, 100);
      const kind = user.broadcasterType || 'non-affiliate';
      const hits = archives.filter((a) =>
        overlaps(a.createdAt, new Date(a.createdAt.getTime() + a.durationSeconds * 1000), cd.t0, cd.t1, MATCH_MARGIN_MS),
      );
      if (hits.length === 0) {
        const oldest = archives.reduce<Date | null>((o, a) => (!o || a.createdAt < o ? a.createdAt : o), null);
        reasons.set(
          cd.channelId,
          archives.length === 0
            ? `no VODs kept (${kind})`
            : `VOD for this day not kept or expired (${kind}, oldest kept ${oldest ? oldest.toISOString().slice(5, 10) : '?'})`,
        );
        continue;
      }
      const spans = hits.map((a) => ({ start: a.createdAt, end: new Date(a.createdAt.getTime() + a.durationSeconds * 1000) }));
      const s = await this.shareFor(cd, spans);
      for (let i = 0; i < hits.length; i++) {
        const a = hits[i];
        const row = this.baseRow(day, cd, 'twitch_vod', snapshot);
        row.stream_ref = a.id;
        row.views = a.viewCount;
        row.broadcast_started_at = spans[i].start;
        row.broadcast_ended_at = spans[i].end;
        row.broadcast_minutes = Math.round(a.durationSeconds / 60);
        row.event_share = Number(s.share.toFixed(4));
        row.event_share_method = s.method;
        row.event_views = Math.round(a.viewCount * s.share);
        row.confidence = s.method === 'full' ? 'measured' : 'adjusted';
        row.note = s.note;
        rows.push(row);
      }
    }
  }

  private async collectKick(
    day: DayRow,
    cds: ChannelDay[],
    snapshot: CollectorPass,
    rows: ViewsRow[],
    reasons: Map<string, string>,
  ): Promise<void> {
    for (const cd of cds.filter((c) => c.platform === 'kick')) {
      reasons.set(cd.channelId, 'Kick publishes replay views only; live views are estimated');
      let vods: Array<Record<string, unknown>> = [];
      try {
        const { data } = await axios.get(`https://kick.com/api/v2/channels/${encodeURIComponent(cd.identifier.toLowerCase())}/videos`, {
          timeout: 15_000,
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (Array.isArray(data)) vods = data as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
      for (const v of vods) {
        const raw = String(v.start_time ?? v.created_at ?? '');
        const start = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
        if (Number.isNaN(start.getTime())) continue;
        const end = new Date(start.getTime() + Number(v.duration ?? 0));
        if (!overlaps(start, end, cd.t0, cd.t1, MATCH_MARGIN_MS)) continue;
        const row = this.baseRow(day, cd, 'kick_vod', snapshot);
        row.stream_ref = String(v.id ?? '');
        row.views = Number(v.views ?? 0);
        row.counted = false;
        row.broadcast_started_at = start;
        row.broadcast_ended_at = end;
        row.broadcast_minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
        row.event_share_method = 'none';
        row.confidence = 'replay';
        row.note = 'Kick counts replays only; never part of a total';
        rows.push(row);
      }
      await sleep(400);
    }
  }

  private async collectSoop(
    day: DayRow,
    cds: ChannelDay[],
    snapshot: CollectorPass,
    rows: ViewsRow[],
    reasons: Map<string, string>,
  ): Promise<void> {
    for (const cd of cds.filter((c) => c.platform === 'soop')) {
      let vods: Array<Record<string, unknown>> = [];
      try {
        const { data } = await axios.get(
          `https://chapi.sooplive.co.kr/api/${encodeURIComponent(cd.identifier)}/vods/review?page=1&per_page=20&orderby=reg_date`,
          { timeout: 15_000, headers: { 'User-Agent': UA, Referer: 'https://www.sooplive.co.kr/' } },
        );
        const list = (data as { data?: unknown }).data;
        if (Array.isArray(list)) vods = list as Array<Record<string, unknown>>;
      } catch {
        reasons.set(cd.channelId, 'SOOP replay list not reachable');
        continue;
      }
      const hits: Array<{ v: Record<string, unknown>; span: Span }> = [];
      for (const v of vods) {
        const ucc = (v.ucc ?? {}) as Record<string, unknown>;
        const broadNo = parseSoopBroadNo(String(ucc.thumb ?? ''));
        // reg_date is a naive KST string stamped when the replay was registered (the end of the broadcast).
        const end = new Date(`${String(v.reg_date ?? '').replace(' ', 'T')}+09:00`);
        if (Number.isNaN(end.getTime())) continue;
        const start = new Date(end.getTime() - Number(ucc.total_file_duration ?? 0));
        const byId = broadNo != null && cd.streamIds.includes(broadNo);
        if (byId || overlaps(start, end, cd.t0, cd.t1, MATCH_MARGIN_MS)) hits.push({ v, span: { start, end } });
      }
      if (hits.length === 0) {
        reasons.set(cd.channelId, 'no SOOP replay for this broadcast (replays off or removed)');
        continue;
      }
      const s = await this.shareFor(cd, hits.map((h) => h.span));
      for (const h of hits) {
        const count = (h.v.count ?? {}) as Record<string, unknown>;
        const views = Number(count.read_cnt ?? 0);
        const row = this.baseRow(day, cd, 'soop_vod', snapshot);
        row.stream_ref = String(h.v.title_no ?? '');
        row.views = views;
        row.broadcast_started_at = h.span.start;
        row.broadcast_ended_at = h.span.end;
        row.broadcast_minutes = Math.round((h.span.end.getTime() - h.span.start.getTime()) / 60_000);
        row.event_share = Number(s.share.toFixed(4));
        row.event_share_method = s.method;
        row.event_views = Math.round(views * s.share);
        row.confidence = s.method === 'full' ? 'measured' : 'adjusted';
        row.extra = JSON.stringify({ vod_read_cnt: Number(count.vod_read_cnt ?? 0) });
        row.note = s.note;
        rows.push(row);
      }
      await sleep(300);
    }
  }

  private addEstimates(day: DayRow, cds: ChannelDay[], rows: ViewsRow[], reasons: Map<string, string>): void {
    const measured = new Set(rows.filter((r) => r.counted && r.source !== 'estimate').map((r) => r.channel_id));
    for (const cd of cds) {
      const factor = viewsFactor(cd.platform);
      const row = this.baseRow(day, cd, 'estimate', 'estimate');
      row.event_views = estimateViews(cd.viewerMinutes, factor);
      row.event_share_method = 'none';
      row.confidence = 'estimated';
      const viewerHours = Math.round(cd.viewerMinutes / 60);
      row.extra = JSON.stringify({ viewer_hours: viewerHours, factor });
      // The reason only belongs on an estimate that speaks for the channel; next to a measured row it is just the fallback.
      const why = measured.has(cd.channelId) ? null : (reasons.get(cd.channelId) ?? noSourceReason(cd.platform));
      row.note = [why, `${viewerHours.toLocaleString('en-US')} viewer-hours x ${factor}`].filter(Boolean).join('; ');
      rows.push(row);
    }
  }

  private async upsert(rows: ViewsRow[]): Promise<void> {
    if (rows.length === 0) return;
    const unique = new Map<string, ViewsRow>();
    for (const r of rows) unique.set(`${r.channel_id}|${r.source}|${r.snapshot}|${r.stream_ref}`, r);
    const list = [...unique.values()];
    for (let i = 0; i < list.length; i += 200) {
      await this.db('stream_views')
        .insert(list.slice(i, i + 200))
        .onConflict(['channel_id', 'broadcast_day_id', 'source', 'snapshot', 'stream_ref'])
        .merge();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
