import { useMemo } from 'react';
import type {
  BreakdownEntry,
  LeaderboardEntry,
  LiveCCVResponse,
  MetricsResponse,
  SeriesWithStages,
  BroadcastDay,
  ScopeLevel,
} from '@/types/api';
import { PLATFORMS, type PlatformId, getPlatform } from './platforms';
import type { SeriesData } from '@/components/design';

/**
 * Normalizes the real backend responses into the shapes the redesigned surfaces
 * want to render. Keep all response-shape quirks (snake_case aliases, optional
 * keys) localized here so the UI stays clean.
 */

export interface ChannelRow {
  id: string;
  name: string;
  platform: string | null;
  tier: string;
  language: string | null;
  region: string | null;
  live: number;
  peak: number;
  avg: number;
  /** Viewed hours — in whole hours. */
  hours: number;
  title: string;
  status: 'live' | 'offline';
}

export interface PlatformRow {
  id: PlatformId | string;
  name: string;
  color: string;
  ccv: number;
  share: number;
}

export interface DashboardModel {
  liveTotal: number;
  peakTotal: number | null;
  peakTotalAt: string | null;
  avgTotal: number | null;
  viewedHours: number | null;
  liveChannelCount: number;
  trackedChannelCount: number;
  /** Platform rows sorted by current CCV desc, filtered to tracked platforms only. */
  platformRows: PlatformRow[];
  /** Breakdown rows (region / language) straight from metrics. */
  regionBreakdown: BreakdownEntry[];
  languageBreakdown: BreakdownEntry[];
  /** Top-10 live channels, sorted by live CCV desc. */
  topChannels: ChannelRow[];
  /** Full leaderboard (live rows enriched with peak/avg from metrics). */
  leaderboard: ChannelRow[];
  /** Active live broadcast day, if any. */
  liveDay: BroadcastDay | null;
}

export function useDashboardModel({
  seriesDetail,
  metrics,
  liveCCV,
}: {
  seriesDetail: SeriesWithStages | null;
  metrics: MetricsResponse | null;
  liveCCV: LiveCCVResponse | null;
}): DashboardModel {
  return useMemo(() => {
    const liveTotal = liveCCV?.totalCCV ?? 0;
    const liveChannels = liveCCV?.channels ?? [];

    // Build a map: channel_id → metrics leaderboard entry (for peak/avg)
    const leaderboardByChannel = new Map<string, LeaderboardEntry>();
    for (const row of metrics?.channelLeaderboard ?? []) {
      const id = row.channelId ?? row.channel_id ?? '';
      if (id) leaderboardByChannel.set(id, row);
    }

    const toChannelRow = (
      c: LiveCCVResponse['channels'][number],
    ): ChannelRow => {
      const meta = leaderboardByChannel.get(c.channelId);
      const peak = meta?.peakCCV ?? Number(meta?.peak_ccv ?? 0) ?? 0;
      const avg = meta?.avgCCV ?? Number(meta?.avg_ccv ?? 0) ?? 0;
      const mins = meta?.totalViewedMinutes ?? Number(meta?.total_viewed_minutes ?? 0) ?? 0;
      return {
        id: c.channelId,
        name: c.displayName ?? c.channelIdentifier,
        platform: c.platform,
        tier: meta?.tier ?? 'community',
        language: (c.language ?? meta?.language) ?? null,
        region: c.region ?? null,
        live: c.concurrentViewers ?? 0,
        peak: peak || 0,
        avg: avg || 0,
        hours: Math.round((mins || 0) / 60),
        title: c.streamTitle ?? '',
        status: (c.concurrentViewers ?? 0) > 0 ? 'live' : 'offline',
      };
    };

    const leaderboard = liveChannels
      .map(toChannelRow)
      .sort((a, b) => (b.live || b.peak) - (a.live || a.peak));

    const topChannels = [...leaderboard].sort((a, b) => b.live - a.live).slice(0, 10);

    // Platform rows from liveCCV (fallback) or metrics.platformBreakdown (preferred)
    const platformRowsRaw: PlatformRow[] = [];
    const breakdownMap = new Map<string, BreakdownEntry>();
    for (const b of metrics?.platformBreakdown ?? []) {
      const key = b.platform ?? b.key;
      if (key) breakdownMap.set(key, b);
    }

    // Aggregate live CCV per platform as the most up-to-date signal
    const livePerPlatform = new Map<string, number>();
    for (const c of liveChannels) {
      if (!c.platform) continue;
      livePerPlatform.set(c.platform, (livePerPlatform.get(c.platform) ?? 0) + (c.concurrentViewers ?? 0));
    }

    for (const p of PLATFORMS) {
      const ccv = livePerPlatform.get(p.id) ?? 0;
      if (ccv === 0 && !breakdownMap.has(p.id)) continue;
      platformRowsRaw.push({
        id: p.id,
        name: p.name,
        color: p.color,
        ccv,
        share: liveTotal > 0 ? ccv / liveTotal : 0,
      });
    }
    platformRowsRaw.sort((a, b) => b.ccv - a.ccv);

    // Live day
    let liveDay: BroadcastDay | null = null;
    if (seriesDetail) {
      outer: for (const stage of seriesDetail.stages) {
        for (const d of stage.broadcast_days) {
          if (d.status === 'live') {
            liveDay = d;
            break outer;
          }
        }
      }
    }

    return {
      liveTotal,
      peakTotal: metrics?.peakCCV?.totalCCV ?? null,
      peakTotalAt: metrics?.peakCCV?.timestamp ?? null,
      avgTotal: metrics?.avgCCV ?? null,
      viewedHours: metrics?.totalViewedHours ?? null,
      liveChannelCount: liveCCV?.liveChannels ?? 0,
      trackedChannelCount: liveCCV?.channelCount ?? leaderboard.length,
      platformRows: platformRowsRaw,
      regionBreakdown: metrics?.regionBreakdown ?? [],
      languageBreakdown: metrics?.languageBreakdown ?? [],
      topChannels,
      leaderboard,
      liveDay,
    };
  }, [seriesDetail, metrics, liveCCV]);
}

/** Build per-dimension series for InteractiveMainChart from a TimeSeriesResponse. */
export function buildChartSeries({
  platformBuckets,
  languageBuckets,
  regionBuckets,
  totalBuckets,
}: {
  platformBuckets: Array<{ timestamp: string; groupKey: string; totalCCV: number }>;
  languageBuckets: Array<{ timestamp: string; groupKey: string; totalCCV: number }>;
  regionBuckets: Array<{ timestamp: string; groupKey: string; totalCCV: number }>;
  totalBuckets: Array<{ timestamp: string; totalCCV: number }>;
}): {
  platform: SeriesData[];
  region: SeriesData[];
  language: SeriesData[];
  total: number[];
  timestamps: string[];
} {
  const timestamps = totalBuckets.map((b) => b.timestamp);

  const buildSeries = (
    buckets: Array<{ timestamp: string; groupKey: string; totalCCV: number }>,
    colorFor: (key: string, idx: number) => string,
    nameFor: (key: string) => string,
  ): SeriesData[] => {
    // Group by groupKey → map of ts → value
    const perGroup = new Map<string, Map<string, number>>();
    for (const b of buckets) {
      if (!perGroup.has(b.groupKey)) perGroup.set(b.groupKey, new Map());
      perGroup.get(b.groupKey)!.set(b.timestamp, Number(b.totalCCV) || 0);
    }
    const groups = Array.from(perGroup.entries());
    // Sort groups by peak desc
    groups.sort((a, b) => {
      const aPeak = Math.max(...Array.from(a[1].values()), 0);
      const bPeak = Math.max(...Array.from(b[1].values()), 0);
      return bPeak - aPeak;
    });
    return groups.map(([key, tsMap], i) => ({
      id: key,
      name: nameFor(key),
      color: colorFor(key, i),
      data: timestamps.map((t) => tsMap.get(t) ?? 0),
      sum: Math.max(...Array.from(tsMap.values()), 0),
    }));
  };

  const palette = ['var(--red)', 'var(--info)', 'var(--warn)', 'var(--live)', 'var(--twitch)', 'var(--tiktok)', 'var(--youtube)', 'var(--kick)'];

  const platform = buildSeries(
    platformBuckets,
    (key, i) => getPlatform(key)?.color ?? palette[i % palette.length]!,
    (key) => getPlatform(key)?.name ?? key,
  );
  const region = buildSeries(
    regionBuckets,
    (_k, i) => palette[i % palette.length]!,
    (k) => k.charAt(0).toUpperCase() + k.slice(1),
  );
  const language = buildSeries(
    languageBuckets,
    (_k, i) => palette[i % palette.length]!,
    (k) => k.toUpperCase(),
  );

  return {
    platform,
    region,
    language,
    total: totalBuckets.map((b) => Number(b.totalCCV) || 0),
    timestamps,
  };
}
