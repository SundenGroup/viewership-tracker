/**
 * Live views: the pure parts (plan: docs/plans/2026-09-16-views-roundup.md).
 *
 * A "view" is a playback session as the platform counts it. The collector
 * reads each platform's number for a past broadcast; this module decides
 * how much of it belongs to the event and which row speaks for a channel
 * on a broadcast day. No clocks, no I/O.
 */

export type ViewsSource =
  | 'youtube_analytics'
  | 'youtube_public'
  | 'youtube_live'
  | 'twitch_vod'
  | 'kick_vod'
  | 'soop_vod'
  | 'tiktok_livecenter'
  | 'twitch_stream_summary'
  | 'csv_import'
  | 'estimate';

export type ViewsSnapshot = 'live_end' | 'plus_3h' | 'plus_36h' | 'plus_7d' | 'manual' | 'estimate';
export type ViewsConfidence = 'measured' | 'adjusted' | 'estimated' | 'replay';
export type ShareMethod = 'full' | 'windowed' | 'viewer_minutes' | 'time_share' | 'none';

/** Views per viewer-hour on Twitch (248 archives, 2026-09-16): median 5.5. */
export const DEFAULT_VIEWS_PER_VIEWER_HOUR = 5.5;

/** Two spans overlap, with a margin on both sides of the second one. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date, marginMs = 0): boolean {
  return aStart.getTime() < bEnd.getTime() + marginMs && aEnd.getTime() > bStart.getTime() - marginMs;
}

export interface ShareInput {
  /** Minutes we tracked the channel on the day (rollup minutes with viewers). */
  trackedMinutes: number;
  /** Sum of per-minute concurrent viewers over those minutes. */
  trackedViewerMinutes: number;
  /** Length of the platform's broadcast(s) that overlap the tracked span. */
  broadcastMinutes: number;
  /** Discover's viewer-minutes over the whole broadcast, when it has them. */
  fullViewerMinutes?: number;
  /** Discover minutes with data divided by the broadcast minutes (0..1). */
  fullCoverage?: number;
}

/**
 * How much of a past broadcast's view count belongs to the tracked span.
 *
 *  - The broadcast is about as long as what we tracked: all of it (`full`).
 *  - Discover saw at least 70 percent of the broadcast: the share of
 *    viewer-minutes that fell inside the tracked span (`viewer_minutes`).
 *  - Otherwise tracked minutes over broadcast minutes, which assumes a flat
 *    audience (`time_share`, the weak one).
 */
export function eventShare(i: ShareInput): { share: number; method: ShareMethod } {
  const tracked = Math.max(0, i.trackedMinutes);
  const broadcast = Math.max(0, i.broadcastMinutes);
  if (broadcast <= Math.max(tracked + 20, tracked * 1.15)) return { share: 1, method: 'full' };
  const coverage = i.fullCoverage ?? 0;
  const fullVm = i.fullViewerMinutes ?? 0;
  if (coverage >= 0.7 && fullVm > 0) {
    return { share: clamp01(i.trackedViewerMinutes / fullVm), method: 'viewer_minutes' };
  }
  return { share: broadcast > 0 ? clamp01(tracked / broadcast) : 1, method: 'time_share' };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Live views estimated from our own minute data. */
export function estimateViews(viewerMinutes: number, viewsPerViewerHour = DEFAULT_VIEWS_PER_VIEWER_HOUR): number {
  if (!Number.isFinite(viewerMinutes) || viewerMinutes <= 0) return 0;
  return Math.round((viewerMinutes / 60) * viewsPerViewerHour);
}

/**
 * Views inside a window from the live counter's readings. When the first
 * reading sits at the window start the stream was already running, so its
 * earlier views are subtracted; a stream that started inside the window
 * keeps its whole count.
 */
export function windowedViews(
  readings: Array<{ readAt: Date; views: number }>,
  windowStart: Date,
  windowEnd: Date,
  startGraceMs = 3 * 60_000,
): { views: number; last: number; method: ShareMethod } | null {
  const inside = readings
    .filter((r) => r.readAt >= windowStart && r.readAt <= windowEnd)
    .sort((a, b) => a.readAt.getTime() - b.readAt.getTime());
  if (inside.length === 0) return null;
  const first = inside[0];
  const last = inside[inside.length - 1];
  const runningBefore = first.readAt.getTime() - windowStart.getTime() <= startGraceMs && first.views > 0;
  if (!runningBefore) return { views: last.views, last: last.views, method: 'full' };
  return { views: Math.max(0, last.views - first.views), last: last.views, method: 'windowed' };
}

export interface ViewsRowLite {
  source: ViewsSource;
  snapshot: ViewsSnapshot;
  counted: boolean;
  confidence: ViewsConfidence;
  eventShareMethod: ShareMethod | null;
  views: number | null;
  eventViews: number | null;
  streamRef: string;
  note?: string | null;
  /** Read after the platform's live window, so replay views are inside the number. */
  late?: boolean;
}

/** How long after a broadcast a public counter still is a live figure, in hours. */
export const LIVE_WINDOW_HOURS: Record<string, number> = { youtube: 12, twitch: 72 };

/**
 * Whether a public read came after the platform's live window. YouTube's
 * counter grows with replays from the first hours; Twitch archives add about
 * 2% a day once the live views have landed.
 */
export function isLateRead(platform: string, source: ViewsSource, broadcastEndedAt: Date | null, fetchedAt: Date | null): boolean {
  if (source !== 'youtube_public' && source !== 'twitch_vod') return false;
  const limit = LIVE_WINDOW_HOURS[platform];
  if (!limit || !broadcastEndedAt || !fetchedAt) return false;
  return (fetchedAt.getTime() - broadcastEndedAt.getTime()) / 3_600_000 > limit;
}

/**
 * Rank of a (source, snapshot) group for one channel on one day; lower wins.
 * Owner data first, then the settled public reads, then estimates. Kick
 * replay views and anything marked uncounted never speak for a channel.
 */
export function groupRank(r: Pick<ViewsRowLite, 'source' | 'snapshot' | 'eventShareMethod' | 'counted'>): number {
  if (!r.counted) return Number.POSITIVE_INFINITY;
  switch (r.source) {
    case 'youtube_analytics':
      return 1;
    case 'tiktok_livecenter':
    case 'twitch_stream_summary':
    case 'csv_import':
      return 2;
    case 'youtube_public':
      if (r.eventShareMethod === 'full') return r.snapshot === 'plus_3h' ? 3 : r.snapshot === 'plus_36h' ? 5 : 6;
      return r.snapshot === 'plus_3h' ? 7 : r.snapshot === 'plus_36h' ? 8 : 9;
    case 'youtube_live':
      return 4;
    case 'twitch_vod':
      return r.snapshot === 'plus_36h' ? 10 : 11;
    case 'soop_vod':
      return r.snapshot === 'plus_36h' ? 12 : 13;
    case 'estimate':
      return 50;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

export interface BestViews {
  source: ViewsSource;
  snapshot: ViewsSnapshot;
  confidence: ViewsConfidence;
  method: ShareMethod | null;
  /** Platform number(s) as read, summed over the group's streams. */
  views: number;
  /** What counts for the event, summed over the group's streams. */
  eventViews: number;
  streams: number;
  note: string | null;
  /** At least one stream of the group was read after its live window. */
  late: boolean;
}

/**
 * The rows that speak for one channel on one day: the best-ranked
 * (source, snapshot) group, its streams summed (a restart gives two
 * archives on one day). Null when nothing counted exists.
 */
export function pickBestViews(rows: ViewsRowLite[]): BestViews | null {
  const groups = new Map<string, ViewsRowLite[]>();
  for (const r of rows) {
    if (!r.counted || r.eventViews == null) continue;
    const k = `${r.source}|${r.snapshot}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  let best: ViewsRowLite[] | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const g of groups.values()) {
    // A group ranks by its weakest member: one adjusted stream makes the day adjusted.
    const rank = Math.max(...g.map((r) => groupRank(r)));
    if (rank < bestRank) {
      bestRank = rank;
      best = g;
    }
  }
  if (!best || !Number.isFinite(bestRank)) return null;
  const confidence: ViewsConfidence = best.some((r) => r.confidence === 'estimated')
    ? 'estimated'
    : best.some((r) => r.confidence === 'adjusted')
      ? 'adjusted'
      : 'measured';
  const methods = [...new Set(best.map((r) => r.eventShareMethod).filter(Boolean))] as ShareMethod[];
  return {
    source: best[0].source,
    snapshot: best[0].snapshot,
    confidence,
    method: methods.length === 1 ? methods[0] : methods.includes('time_share') ? 'time_share' : (methods[0] ?? null),
    views: best.reduce((a, r) => a + (r.views ?? 0), 0),
    eventViews: best.reduce((a, r) => a + (r.eventViews ?? 0), 0),
    streams: best.length,
    note: best.map((r) => r.note).filter(Boolean).join('; ') || null,
    late: best.some((r) => r.late === true),
  };
}

/** SOOP replay thumbnails carry the broadcast number: "20260916_96BD7129_297164031_6_r". */
export function parseSoopBroadNo(thumb: string | null | undefined): string | null {
  if (!thumb) return null;
  const m = thumb.match(/rowKey=\d{8}_[0-9A-Fa-f]+_(\d+)_/);
  return m ? m[1] : null;
}
