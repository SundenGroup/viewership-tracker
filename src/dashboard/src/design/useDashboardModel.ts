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

export interface TierRow {
  key: string;
  label: string;
  color: string;
  /** Current live CCV across this tier's channels. */
  ccv: number;
  /** Peak CCV across this tier's channels (from metrics). */
  peak: number;
  /** Avg CCV across this tier's channels (from metrics, summed). */
  avg: number;
  /** Total viewed hours across this tier's channels (whole hours). */
  viewedHours: number;
  /** Share of current total live CCV (0..1). */
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
  /** Tier rows (5 tiers, sorted by share desc) computed from the leaderboard. */
  tierRows: TierRow[];
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

    const toChannelRowFromLive = (
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

    const toChannelRowFromMetrics = (row: LeaderboardEntry): ChannelRow => {
      const peak = row.peakCCV ?? Number(row.peak_ccv ?? 0) ?? 0;
      const avg = row.avgCCV ?? Number(row.avg_ccv ?? 0) ?? 0;
      const mins = row.totalViewedMinutes ?? Number(row.total_viewed_minutes ?? 0) ?? 0;
      return {
        id: row.channelId ?? row.channel_id ?? '',
        name: row.displayName ?? row.display_name ?? '',
        platform: row.platform ?? null,
        tier: row.tier ?? 'community',
        language: row.language ?? null,
        region: null,
        live: 0,
        peak: peak || 0,
        avg: avg || 0,
        hours: Math.round((mins || 0) / 60),
        title: '',
        status: 'offline',
      };
    };

    // Build the full leaderboard by UNIONING live channels + metrics leaderboard.
    // Post-event (no one live) the metrics leaderboard is the primary source.
    // During a live broadcast, liveCCV is primary and metrics enriches.
    const byId = new Map<string, ChannelRow>();
    for (const c of liveChannels) {
      if (c.channelId) byId.set(c.channelId, toChannelRowFromLive(c));
    }
    for (const row of metrics?.channelLeaderboard ?? []) {
      const id = row.channelId ?? row.channel_id ?? '';
      if (!id) continue;
      if (!byId.has(id)) {
        byId.set(id, toChannelRowFromMetrics(row));
      }
    }
    const leaderboard = Array.from(byId.values()).sort(
      (a, b) => (b.live || b.peak) - (a.live || a.peak),
    );

    const topChannels = [...leaderboard].sort((a, b) => b.live - a.live).slice(0, 10);

    // Platform rows — use peak CCV from metrics.platformBreakdown as the
    // authoritative "share" signal (lives post-event); fall back to live CCV
    // during a broadcast when metrics haven't aggregated yet.
    const platformRowsRaw: PlatformRow[] = [];
    const breakdownMap = new Map<string, BreakdownEntry>();
    for (const b of metrics?.platformBreakdown ?? []) {
      const key = b.platform ?? b.key;
      if (key) breakdownMap.set(key, b);
    }

    // Aggregate live CCV per platform for the in-flight signal.
    const livePerPlatform = new Map<string, number>();
    for (const c of liveChannels) {
      if (!c.platform) continue;
      livePerPlatform.set(c.platform, (livePerPlatform.get(c.platform) ?? 0) + (c.concurrentViewers ?? 0));
    }

    // Decide which signal drives "share":
    //   - if any platform has live CCV > 0 → live is the primary
    //   - else use peak CCV from breakdown (post-event)
    const hasLive = livePerPlatform.size > 0 && Array.from(livePerPlatform.values()).some((v) => v > 0);
    const totalPeakAcrossPlatforms = Array.from(breakdownMap.values()).reduce(
      (a, b) => a + (Number(b.peakCCV ?? b.peak_ccv ?? 0) || 0),
      0,
    );

    for (const p of PLATFORMS) {
      const liveCcv = livePerPlatform.get(p.id) ?? 0;
      const breakdown = breakdownMap.get(p.id);
      const peak = Number(breakdown?.peakCCV ?? breakdown?.peak_ccv ?? 0) || 0;
      if (liveCcv === 0 && peak === 0) continue;
      const share = hasLive
        ? liveTotal > 0
          ? liveCcv / liveTotal
          : 0
        : totalPeakAcrossPlatforms > 0
          ? peak / totalPeakAcrossPlatforms
          : 0;
      platformRowsRaw.push({
        id: p.id,
        name: p.name,
        color: p.color,
        // ccv = live CCV while broadcasting, else peak (so the tile shows
        // a meaningful number in both modes).
        ccv: hasLive ? liveCcv : peak,
        share,
      });
    }
    platformRowsRaw.sort((a, b) => b.ccv - a.ccv);

    // Tier breakdown — computed from the full leaderboard (live CCV + metrics peak).
    const TIER_ORDER: Array<{ key: string; label: string; color: string }> = [
      { key: 'official', label: 'Official', color: 'var(--red)' },
      { key: 'partner', label: 'Partner', color: 'var(--info)' },
      { key: 'player', label: 'Player POV', color: 'var(--warn)' },
      { key: 'community', label: 'Community', color: 'var(--fg-muted)' },
      { key: 'watch_party', label: 'Watch Party', color: 'var(--live)' },
    ];
    const tierCcv = new Map<string, number>();
    const tierPeak = new Map<string, number>();
    const tierAvg = new Map<string, number>();
    const tierHours = new Map<string, number>();
    for (const c of leaderboard) {
      const t = c.tier || 'community';
      tierCcv.set(t, (tierCcv.get(t) ?? 0) + (c.live ?? 0));
      // Peak per tier = max of per-channel peaks (closest single-moment
      // approximation without storing the full per-tier timeseries).
      tierPeak.set(t, Math.max(tierPeak.get(t) ?? 0, c.peak ?? 0));
      tierAvg.set(t, (tierAvg.get(t) ?? 0) + (c.avg ?? 0));
      tierHours.set(t, (tierHours.get(t) ?? 0) + (c.hours ?? 0));
    }
    const totalTierHours = Array.from(tierHours.values()).reduce((a, b) => a + b, 0);
    const tierRows: TierRow[] = TIER_ORDER.map((t) => {
      const ccv = tierCcv.get(t.key) ?? 0;
      const peak = tierPeak.get(t.key) ?? 0;
      const avg = tierAvg.get(t.key) ?? 0;
      const viewedHours = tierHours.get(t.key) ?? 0;
      // Tier "share" uses the most meaningful denominator available:
      // viewedHours is authoritative post-event; live CCV is the fallback
      // for in-flight events where hours haven't accumulated yet.
      const share =
        totalTierHours > 0
          ? viewedHours / totalTierHours
          : liveTotal > 0
            ? ccv / liveTotal
            : 0;
      return {
        ...t,
        ccv,
        peak,
        avg,
        viewedHours,
        share,
      };
    });

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
      tierRows,
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
    buckets: Array<{ timestamp: string; groupKey: string | null; totalCCV: number }>,
    colorFor: (key: string, idx: number) => string,
    nameFor: (key: string) => string,
  ): SeriesData[] => {
    // Group by groupKey → map of ts → value.
    // Coerce null/empty groupKeys to a shared "Other" bucket rather than
    // crashing or scattering null-keyed series.
    const perGroup = new Map<string, Map<string, number>>();
    for (const b of buckets) {
      const key = b.groupKey && String(b.groupKey).trim() ? String(b.groupKey) : '—';
      if (!perGroup.has(key)) perGroup.set(key, new Map());
      perGroup.get(key)!.set(b.timestamp, Number(b.totalCCV) || 0);
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

  const safeCap = (k: string) => {
    if (!k) return '—';
    return k.charAt(0).toUpperCase() + k.slice(1);
  };

  // Friendly labels for tier keys (the "Category" dimension is wired to tier).
  const TIER_LABELS: Record<string, string> = {
    official: 'Official',
    partner: 'Partner',
    player: 'Player',
    community: 'Community',
    watch_party: 'Watch Party',
  };
  // Consistent tier colour palette (roughly matches the post-event tier bars).
  const TIER_COLORS: Record<string, string> = {
    official: 'var(--red)',
    partner: 'var(--info)',
    player: 'var(--warn)',
    community: 'var(--live)',
    watch_party: 'var(--tiktok)',
  };

  const platform = buildSeries(
    platformBuckets,
    (key, i) => getPlatform(key)?.color ?? palette[i % palette.length]!,
    (key) => getPlatform(key)?.name ?? safeCap(key),
  );
  const region = buildSeries(
    regionBuckets,
    (key, i) => TIER_COLORS[key] ?? palette[i % palette.length]!,
    (k) => TIER_LABELS[k] ?? safeCap(k),
  );
  const language = buildSeries(
    languageBuckets,
    (_k, i) => palette[i % palette.length]!,
    (k) => (k ? k.toUpperCase() : '—'),
  );

  return {
    platform,
    region,
    language,
    total: totalBuckets.map((b) => Number(b.totalCCV) || 0),
    timestamps,
  };
}
