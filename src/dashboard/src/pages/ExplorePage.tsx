/**
 * ExplorePage — post-event tournament analysis surface.
 *
 * Editor + Admin only. Lets operators browse a finished tournament,
 * filter and sort channels, drill into a single channel's CCV curve,
 * overlay 2-4 channels for audience-flow comparison, and click any
 * timestamp on the chart to see every channel's CCV at that exact minute.
 *
 * URL state is the single source of truth for scope + selection so a
 * given view can be bookmarked or shared:
 *   /explore                                       → series picker
 *   /explore/:seriesId                             → series scope
 *   /explore/:seriesId?stage=<stageId>             → stage scope
 *   /explore/:seriesId?day=<dayId>                 → day scope
 *   /explore/:seriesId?…&channels=id1,id2          → multi-channel overlay
 *   /explore/:seriesId?…&at=<ISO>                  → "all channels at T" panel
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Row,
  Col,
  ClutchWordmark,
  Pill,
  PlatformPip,
  TierBadge,
  ChannelNameWithLink,
  ScopeScrubber,
  Section,
  Tab,
  FilterMultiSelect,
  useSortable,
  SortHeader,
  IconChev,
  IconSearch,
  InteractiveMainChart,
  LineChart,
} from '@/components/design';
import type { SeriesData } from '@/components/design';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import type { ScopeOption } from '@/components/design/ScopeScrubber';
import { fmtCompact, fmtN, fmtDateMD, fmtDateLong } from '@/design/format';
import { formatChartTimeInTz } from '@/utils/formatters';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { useAuth } from '@/hooks/useAuth';
import { useApi, usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import { ExploreAskBox, ExploreAskResults, useExploreAsk } from '@/components/editor/ExploreAskBox';
import type {
  TournamentSeries,
  SeriesWithStages,
  LeaderboardStats,
  ChannelAtTimestamp,
  TimeSeriesResponse,
  GroupedTimeSeriesBucket,
  TimeSeriesBucket,
  ScopeLevel,
  RangeLeaderboardResponse,
} from '@/types/api';

const MAX_OVERLAY_CHANNELS = 8;

// Distinct line colours for overlay mode (max 8)
const OVERLAY_COLORS = [
  'var(--red)',
  'var(--info)',
  'var(--warn)',
  'var(--live)',
  '#a78bfa', // violet
  '#f472b6', // pink
  '#2dd4bf', // teal
  '#fb923c', // orange
];

interface ExplorePageProps {
  seriesList: TournamentSeries[];
  seriesId: string | null;
  seriesDetail: SeriesWithStages | null;
  onSeriesChange: (id: string) => void;
}

export function ExplorePage({
  seriesList,
  seriesId,
  seriesDetail,
  onSeriesChange,
}: ExplorePageProps) {
  const { isEditor, logout } = useAuth();
  const navigate = useNavigate();
  const params = useParams<{ seriesId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Auth gate ─────────────────────────────────────────────────────────
  if (!isEditor) {
    return (
      <ExploreShell title="Explore">
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <h2 style={{ marginTop: 0 }}>Editor access required</h2>
          <p style={{ color: 'var(--fg-muted)' }}>
            The Explore surface is restricted to operators with editor or admin
            role. Contact your administrator if you need access.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => navigate('/')}
          >
            ← Back to series list
          </button>
        </div>
      </ExploreShell>
    );
  }

  // ── No series in URL → series picker ──────────────────────────────────
  if (!seriesId) {
    return (
      <ExploreShell
        title="Explore"
        subtitle="Pick a series to start analysing"
      >
        <SeriesPicker
          seriesList={seriesList}
          onPick={(id) => navigate(`/explore/${id}`)}
        />
      </ExploreShell>
    );
  }

  return (
    <ExploreScopedView
      seriesId={seriesId}
      seriesList={seriesList}
      seriesDetail={seriesDetail}
      onSeriesChange={(id) => {
        onSeriesChange(id);
        navigate(`/explore/${id}`);
      }}
      searchParams={searchParams}
      setSearchParams={setSearchParams}
      logout={logout}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Series-scoped view
// ─────────────────────────────────────────────────────────────────────────

interface ExploreScopedViewProps {
  seriesId: string;
  seriesList: TournamentSeries[];
  seriesDetail: SeriesWithStages | null;
  onSeriesChange: (id: string) => void;
  searchParams: URLSearchParams;
  setSearchParams: (p: URLSearchParams, opts?: { replace?: boolean }) => void;
  logout: () => void | Promise<void>;
}

function ExploreScopedView({
  seriesId,
  seriesList,
  seriesDetail,
  onSeriesChange,
  searchParams,
  setSearchParams,
  logout,
}: ExploreScopedViewProps) {
  const navigate = useNavigate();
  const series = useMemo(
    () => seriesList.find((s) => s.id === seriesId) ?? null,
    [seriesList, seriesId],
  );
  // Transient "overlay limit reached" message (auto-clears).
  const [capNotice, setCapNotice] = useState<string | null>(null);
  // Curve-shape metrics (std dev / minutes at #1 / % of time above half-peak)
  // are opt-in — they need the per-channel time-series for the whole scope.
  const [shapeMetricsOn, setShapeMetricsOn] = useState(false);

  // ── URL state parsing ───────────────────────────────────────────────
  const stageIdFromUrl = searchParams.get('stage') ?? undefined;
  const dayIdFromUrl = searchParams.get('day') ?? undefined;
  const channelsParam = searchParams.get('channels') ?? '';
  const atParam = searchParams.get('at');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  // Chart mode: when 0 channels selected the InteractiveMainChart owns its
  // own dimension toggle (Platform / Region / Language / Total). When
  // channels are selected we render a custom multi-line overlay instead.

  const selectedChannelIds = useMemo(
    () => channelsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_OVERLAY_CHANNELS),
    [channelsParam],
  );

  // Resolve scope from URL — day wins, then stage, else series
  const scopeLevel: ScopeLevel = dayIdFromUrl ? 'day' : stageIdFromUrl ? 'stage' : 'series';
  const scopeId = dayIdFromUrl || stageIdFromUrl || seriesId;

  // ── Scope metadata for the scrubber ─────────────────────────────────
  const allDays = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.flatMap((s) => s.broadcast_days);
  }, [seriesDetail]);

  const stageOptions: ScopeOption[] = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.map((s) => {
      const dates = s.broadcast_days.map((d) => d.date).sort();
      const first = dates[0];
      const last = dates[dates.length - 1];
      return {
        id: s.id,
        label: s.name,
        sub:
          first === last
            ? fmtDateLong(first)
            : first && last
              ? `${fmtDateMD(first)} – ${fmtDateMD(last)}`
              : undefined,
      };
    });
  }, [seriesDetail]);

  const activeStage = useMemo(() => {
    if (scopeLevel === 'stage' && stageIdFromUrl) {
      return seriesDetail?.stages.find((s) => s.id === stageIdFromUrl) ?? null;
    }
    if (scopeLevel === 'day' && dayIdFromUrl) {
      return (
        seriesDetail?.stages.find((s) =>
          s.broadcast_days.some((d) => d.id === dayIdFromUrl),
        ) ?? null
      );
    }
    return null;
  }, [seriesDetail, scopeLevel, stageIdFromUrl, dayIdFromUrl]);

  const dayOptions: ScopeOption[] = useMemo(() => {
    const days = scopeLevel === 'stage' && activeStage ? activeStage.broadcast_days : allDays;
    return [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        id: d.id,
        label: d.label,
        sub: fmtDateMD(d.date),
        live: d.status === 'live',
      }));
  }, [scopeLevel, activeStage, allDays]);

  // ── Filter rail state (URL-encoded) ────────────────────────────────
  const platformFilter = (searchParams.get('platforms') ?? '').split(',').filter(Boolean);
  const languageFilter = (searchParams.get('languages') ?? '').split(',').filter(Boolean);
  const tierFilter = (searchParams.get('tiers') ?? '').split(',').filter(Boolean);
  const regionFilter = (searchParams.get('regions') ?? '').split(',').filter(Boolean);
  const search = searchParams.get('q') ?? '';

  const updateUrl = useCallback(
    (mut: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => {
      const next = new URLSearchParams(searchParams);
      mut(next);
      setSearchParams(next, opts);
    },
    [searchParams, setSearchParams],
  );

  // ── Data fetching ──────────────────────────────────────────────────
  // Leaderboard (peak/avg/VH per channel) — already scope-aware.
  const { data: leaderboard, loading: lbLoading } = useApi<LeaderboardStats[]>(
    () => fetchLeaderboard(seriesId, scopeLevel, scopeId),
    [seriesId, scopeLevel, scopeId, platformFilter.join(','), languageFilter.join(','), tierFilter.join(','), regionFilter.join(',')],
  );

  // Grouped time-series — total/platform/language/category(=tier). Fetched in
  // a single hook (the same one ReportPage uses) so the mode switcher is just
  // a render-side change.
  const timeline = useTimelineSeries({
    scope: { level: scopeLevel, id: scopeId },
    interval: 60,
    refreshMs: 60_000,
  });

  // Day-boundary markers for the chart (same logic as ReportPage). Skipped
  // at day-scope because there's nothing to label.
  const dayBoundaries = useMemo<Array<{ index: number; label: string }>>(() => {
    if (!seriesDetail || scopeLevel === 'day' || timeline.timestamps.length === 0) return [];
    let days = seriesDetail.stages.flatMap((s) => s.broadcast_days);
    if (scopeLevel === 'stage' && activeStage) days = activeStage.broadcast_days;
    if (days.length < 2) return [];
    const tsMs = timeline.timestamps.map((t) => new Date(t).getTime());
    const out: Array<{ index: number; label: string }> = [];
    for (const d of days) {
      if (!d.broadcast_start) continue;
      const startMs = new Date(d.broadcast_start).getTime();
      const idx = tsMs.findIndex((ms) => ms >= startMs);
      if (idx >= 0) out.push({ index: idx, label: d.label });
    }
    const seen = new Set<number>();
    return out.filter((b) => {
      if (seen.has(b.index)) return false;
      seen.add(b.index);
      return true;
    });
  }, [seriesDetail, scopeLevel, activeStage, timeline.timestamps]);

  // Per-channel time-series for the chart (used when 1+ channels selected)
  const { data: channelTs } = useApi<TimeSeriesResponse>(
    () =>
      selectedChannelIds.length > 0
        ? api.getTimeSeries({ scope: scopeLevel, id: scopeId, interval: 60, groupBy: 'channel' })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [seriesId, scopeLevel, scopeId, selectedChannelIds.length > 0],
  );

  // "All channels at T" panel data
  const { data: atTimestampData } = useApi(
    () =>
      atParam && !fromParam
        ? api.getSnapshotAtTimestamp(seriesId, atParam, 60)
        : Promise.resolve(null as unknown as { channels: ChannelAtTimestamp[] }),
    [seriesId, atParam, fromParam],
  );

  // Range stats panel data (when from+to are set)
  const { data: rangeStats } = useApi<RangeLeaderboardResponse>(
    () =>
      fromParam && toParam
        ? api.getRangeLeaderboard(seriesId, fromParam, toParam)
        : Promise.resolve(null as unknown as RangeLeaderboardResponse),
    [seriesId, fromParam, toParam],
  );

  // ── Compare mode ────────────────────────────────────────────────────
  // Overlay another scope of the SAME level (day vs day, stage vs stage),
  // aligned by minutes-from-start so different wall-clock days line up.
  const compareId = searchParams.get('compare');
  const compareOptions = useMemo<ScopeOption[]>(() => {
    if (scopeLevel === 'day') return dayOptions.filter((d) => d.id !== dayIdFromUrl);
    if (scopeLevel === 'stage') return stageOptions.filter((s) => s.id !== stageIdFromUrl);
    return [];
  }, [scopeLevel, dayOptions, stageOptions, dayIdFromUrl, stageIdFromUrl]);
  const compareLabel = compareOptions.find((o) => o.id === compareId)?.label ?? null;
  const { data: compareTs } = useApi<TimeSeriesResponse>(
    () =>
      compareId
        ? api.getTimeSeries({ scope: scopeLevel, id: compareId, interval: 60 })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [seriesId, scopeLevel, compareId],
  );

  // ── Filter + search the leaderboard ────────────────────────────────
  const channels = useMemo(() => {
    const list = leaderboard ?? [];
    const q = search.trim().toLowerCase();
    return list
      .filter((c) => {
        if (platformFilter.length > 0 && !platformFilter.includes(c.platform ?? '')) return false;
        if (languageFilter.length > 0) {
          const lang = (c.language ?? '').toLowerCase();
          if (!languageFilter.map((s) => s.toLowerCase()).includes(lang)) return false;
        }
        if (tierFilter.length > 0) {
          const tier = (c.tier ?? '').toLowerCase();
          if (!tierFilter.map((s) => s.toLowerCase()).includes(tier)) return false;
        }
        if (regionFilter.length > 0) {
          const region = (c.region ?? '').trim();
          if (!regionFilter.includes(region)) return false;
        }
        if (q) {
          const name = (c.displayName ?? '').toLowerCase();
          const ident = (c.channelIdentifier ?? '').toLowerCase();
          if (!name.includes(q) && !ident.includes(q)) return false;
        }
        return true;
      })
      .map((c) => ({
        id: c.channelId,
        name: c.displayName,
        channelIdentifier: c.channelIdentifier ?? '',
        platform: c.platform ?? '—',
        tier: c.tier ?? 'community',
        language: c.language ?? null,
        region: c.region ?? null,
        peak: c.peakCCV ?? 0,
        avg: c.avgCCV ?? 0,
        hours: c.viewedHours ?? 0,
      }));
  }, [leaderboard, platformFilter, languageFilter, tierFilter, regionFilter, search]);

  const filtersActive =
    platformFilter.length > 0 ||
    languageFilter.length > 0 ||
    tierFilter.length > 0 ||
    regionFilter.length > 0 ||
    search.trim() !== '';

  const clearAllFilters = useCallback(() => {
    updateUrl((p) => {
      p.delete('platforms');
      p.delete('languages');
      p.delete('tiers');
      p.delete('regions');
      p.delete('q');
    });
  }, [updateUrl]);

  // ── Ask (natural-language) ─────────────────────────────────────────
  // The server compiles a question into ONE validated intent: either a
  // URL-state patch (applied via the same updateUrl mutator the rest of
  // the page uses — Back/Undo restore the previous view) or a query
  // answered straight from Postgres.
  const getAskViewState = useCallback(
    (): api.AskViewState => ({
      stage: stageIdFromUrl,
      day: dayIdFromUrl,
      channels: channelsParam || undefined,
      languages: searchParams.get('languages') ?? undefined,
      platforms: searchParams.get('platforms') ?? undefined,
      tiers: searchParams.get('tiers') ?? undefined,
      regions: searchParams.get('regions') ?? undefined,
    }),
    [stageIdFromUrl, dayIdFromUrl, channelsParam, searchParams],
  );

  const applyAskPatch = useCallback(
    (set: Record<string, string>, del: string[]) => {
      updateUrl((p) => {
        for (const key of del) p.delete(key);
        for (const [key, value] of Object.entries(set)) p.set(key, value);
      });
    },
    [updateUrl],
  );

  const ask = useExploreAsk({
    seriesId,
    getViewState: getAskViewState,
    onPatch: applyAskPatch,
    snapshotParams: useCallback(() => searchParams.toString(), [searchParams]),
    restoreParams: useCallback(
      (params: string) => setSearchParams(new URLSearchParams(params)),
      [setSearchParams],
    ),
  });

  // ── Curve-shape metrics (opt-in) ───────────────────────────────────
  // Per-channel per-minute series for the whole scope: stability (std dev
  // as % of the channel's own avg), minutes ranked #1 across all channels,
  // and consistency (% of live minutes above half its own peak).
  const { data: shapeTs } = useApi<TimeSeriesResponse>(
    () =>
      shapeMetricsOn
        ? api.getTimeSeries({ scope: scopeLevel, id: scopeId, interval: 60, groupBy: 'channel' })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [seriesId, scopeLevel, scopeId, shapeMetricsOn],
  );

  interface ShapeStats {
    stability: number; // coefficient of variation, lower = steadier
    minutesAt1: number;
    consistency: number; // % of live minutes >= 50% of own peak
  }
  const shapeByChannel = useMemo<Map<string, ShapeStats>>(() => {
    const out = new Map<string, ShapeStats>();
    if (!shapeMetricsOn || !shapeTs?.data) return out;
    const grouped = shapeTs.data as GroupedTimeSeriesBucket[];
    // channel -> minute-ms -> ccv
    const perChan = new Map<string, number[]>();
    const byMinuteMax = new Map<number, { max: number; cid: string }>();
    for (const row of grouped) {
      const cid = row.groupKey;
      if (!cid) continue;
      const ms = new Date(row.timestamp ?? row.bucket ?? '').getTime();
      const v = Number(row.totalCCV ?? row.total_ccv ?? 0);
      if (v <= 0) continue;
      const arr = perChan.get(cid) ?? [];
      arr.push(v);
      perChan.set(cid, arr);
      const cur = byMinuteMax.get(ms);
      if (!cur || v > cur.max) byMinuteMax.set(ms, { max: v, cid });
    }
    const at1 = new Map<string, number>();
    for (const { cid } of byMinuteMax.values()) at1.set(cid, (at1.get(cid) ?? 0) + 1);
    for (const [cid, vals] of perChan) {
      const n = vals.length;
      const mean = vals.reduce((s, v) => s + v, 0) / n;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      const peak = Math.max(...vals);
      out.set(cid, {
        stability: mean > 0 ? Math.round((Math.sqrt(variance) / mean) * 100) : 0,
        minutesAt1: at1.get(cid) ?? 0,
        consistency: Math.round((vals.filter((v) => v >= peak / 2).length / n) * 100),
      });
    }
    return out;
  }, [shapeMetricsOn, shapeTs]);

  // Table rows, with shape columns merged in when enabled.
  const tableRows = useMemo(
    () =>
      channels.map((c) => ({
        ...c,
        stability: shapeByChannel.get(c.id)?.stability ?? null,
        minutesAt1: shapeByChannel.get(c.id)?.minutesAt1 ?? null,
        consistency: shapeByChannel.get(c.id)?.consistency ?? null,
      })),
    [channels, shapeByChannel],
  );

  const lb = useSortable(tableRows, 'peak', 'desc');

  // Grid template grows three columns when shape metrics are on.
  const tableGridColumns = shapeMetricsOn
    ? '40px 1fr 90px 100px 70px 90px 90px 100px 70px 70px 70px'
    : '40px 1fr 100px 110px 90px 100px 100px 110px';

  const exportTableCsv = useCallback(() => {
    downloadCsv(
      `explore-${series?.short_name || seriesId}-${scopeLevel}-${csvStamp()}`,
      ['Channel', 'Identifier', 'Platform', 'Category', 'Language', 'Region', 'Peak CCV', 'Avg CCV', 'Viewed Hours'],
      lb.sorted.map((c) => [
        c.name,
        c.channelIdentifier,
        c.platform,
        c.tier,
        c.language,
        c.region,
        c.peak,
        c.avg,
        c.hours,
      ]),
    );
  }, [lb.sorted, series?.short_name, seriesId, scopeLevel]);

  // ── Build chart series (parallel to timeline.timestamps) ──────────
  // Three rendering modes:
  //   1. Channels overlay  → 1-4 selected channels each as a line
  //   2. Total             → single red line of overall CCV
  //   3. Grouped           → multiple lines, one per platform/language/category
  const chartSeries = useMemo<OverlaySeriesData[]>(() => {
    const N = timeline.timestamps.length;
    if (N === 0) return [];

    // (1) Multi-channel overlay — align each channel's per-minute time-series
    // to the canonical timestamps[] from useTimelineSeries by ms-equality.
    if (selectedChannelIds.length > 0 && channelTs?.data) {
      const grouped = channelTs.data as GroupedTimeSeriesBucket[];
      // For each selected channel, build a Map<timestampMs, ccv>
      const byChannel = new Map<string, Map<number, number>>();
      for (const row of grouped) {
        const cid = row.groupKey;
        if (!cid || !selectedChannelIds.includes(cid)) continue;
        const tsRaw = row.timestamp ?? row.bucket ?? '';
        const ms = new Date(tsRaw).getTime();
        if (!byChannel.has(cid)) byChannel.set(cid, new Map());
        byChannel.get(cid)!.set(ms, Number(row.totalCCV ?? row.total_ccv ?? 0));
      }
      const canonicalMs = timeline.timestamps.map((ts) => new Date(ts).getTime());
      return selectedChannelIds.map((cid, idx) => {
        const ch = leaderboard?.find((l) => l.channelId === cid);
        const map = byChannel.get(cid) ?? new Map();
        const values = canonicalMs.map((ms) => {
          const v = map.get(ms);
          return v != null ? v : null;
        });
        return {
          id: cid,
          name: ch?.displayName ?? '—',
          platform: ch?.platform ?? '—',
          color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length] ?? OVERLAY_COLORS[0]!,
          values,
        };
      });
    }

    // No-channels case: returns empty — InteractiveMainChart handles total /
    // platform / region / language internally with its own dimension toggle.
    return [];
  }, [selectedChannelIds, channelTs, timeline, leaderboard]);

  // ── Handlers ───────────────────────────────────────────────────────
  const handleScopeChange = useCallback(
    (level: ScopeLevel) => {
      updateUrl((p) => {
        p.delete('stage');
        p.delete('day');
        p.delete('at');
        p.delete('compare');
        if (level === 'stage' && stageOptions[0]) p.set('stage', stageOptions[0].id);
        if (level === 'day' && dayOptions[0]) p.set('day', dayOptions[0].id);
      });
    },
    [updateUrl, stageOptions, dayOptions],
  );

  const handleStageChange = useCallback(
    (id: string) => {
      updateUrl((p) => {
        p.set('stage', id);
        p.delete('day');
        p.delete('at');
        p.delete('compare');
      });
    },
    [updateUrl],
  );

  const handleDayChange = useCallback(
    (id: string) => {
      updateUrl((p) => {
        p.set('day', id);
        p.delete('stage');
        p.delete('at');
        p.delete('compare');
      });
    },
    [updateUrl],
  );

  const toggleChannel = useCallback(
    (cid: string) => {
      const cur = selectedChannelIds.slice();
      const i = cur.indexOf(cid);
      if (i >= 0) cur.splice(i, 1);
      else if (cur.length < MAX_OVERLAY_CHANNELS) cur.push(cid);
      else {
        // Say WHY nothing happened instead of silently ignoring the click.
        setCapNotice(`Overlay limit reached (${MAX_OVERLAY_CHANNELS}) — deselect a channel first.`);
        window.setTimeout(() => setCapNotice(null), 3500);
        return;
      }
      updateUrl((p) => {
        if (cur.length > 0) p.set('channels', cur.join(','));
        else p.delete('channels');
      });
    },
    [selectedChannelIds, updateUrl],
  );

  const togglePlatform = useCallback(
    (plat: string) => {
      const cur = platformFilter.slice();
      const i = cur.indexOf(plat);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(plat);
      updateUrl((p) => {
        if (cur.length > 0) p.set('platforms', cur.join(','));
        else p.delete('platforms');
      });
    },
    [platformFilter, updateUrl],
  );

  const toggleTier = useCallback(
    (tier: string) => {
      const cur = tierFilter.slice();
      const i = cur.indexOf(tier);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(tier);
      updateUrl((p) => {
        if (cur.length > 0) p.set('tiers', cur.join(','));
        else p.delete('tiers');
      });
    },
    [tierFilter, updateUrl],
  );

  const toggleLanguage = useCallback(
    (lang: string) => {
      const cur = languageFilter.slice();
      const i = cur.indexOf(lang);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(lang);
      updateUrl((p) => {
        if (cur.length > 0) p.set('languages', cur.join(','));
        else p.delete('languages');
      });
    },
    [languageFilter, updateUrl],
  );

  const toggleRegion = useCallback(
    (region: string) => {
      const cur = regionFilter.slice();
      const i = cur.indexOf(region);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(region);
      updateUrl((p) => {
        if (cur.length > 0) p.set('regions', cur.join(','));
        else p.delete('regions');
      });
    },
    [regionFilter, updateUrl],
  );

  // Set-style writers (for the searchable multi-select popovers) — same URL
  // params the chip toggles write, so shared links round-trip unchanged.
  const setLanguages = useCallback(
    (next: string[]) =>
      updateUrl((p) => {
        if (next.length > 0) p.set('languages', next.join(','));
        else p.delete('languages');
      }),
    [updateUrl],
  );
  const setRegions = useCallback(
    (next: string[]) =>
      updateUrl((p) => {
        if (next.length > 0) p.set('regions', next.join(','));
        else p.delete('regions');
      }),
    [updateUrl],
  );

  const setAnchorTimestamp = useCallback(
    (iso: string | null) => {
      updateUrl((p) => {
        // Mutually exclusive with range — clicking a single moment clears any
        // pinned range so the chart and the panel stay in sync.
        p.delete('from');
        p.delete('to');
        if (iso) p.set('at', iso);
        else p.delete('at');
      });
    },
    [updateUrl],
  );

  const setRange = useCallback(
    (fromIso: string | null, toIso: string | null) => {
      updateUrl((p) => {
        p.delete('at');
        if (fromIso && toIso) {
          p.set('from', fromIso);
          p.set('to', toIso);
        } else {
          p.delete('from');
          p.delete('to');
        }
      });
    },
    [updateUrl],
  );

  // Available platforms in current data (for filter chip row)
  const availablePlatforms = useMemo(() => {
    const set = new Set<string>();
    for (const c of leaderboard ?? []) if (c.platform) set.add(c.platform);
    return Array.from(set).sort();
  }, [leaderboard]);

  // Tier (Category) and Language values that exist for this scope. Tiers
  // are presented in a fixed canonical order (Official → Watch Party); the
  // few odd / unrecognised tiers fall through alphabetically at the end.
  const TIER_ORDER = ['official', 'partner', 'player', 'community', 'watch_party'];
  const availableTiers = useMemo(() => {
    const set = new Set<string>();
    for (const c of leaderboard ?? []) if (c.tier) set.add(c.tier);
    return Array.from(set).sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a);
      const bi = TIER_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [leaderboard]);
  const availableLanguages = useMemo(() => {
    const set = new Set<string>();
    for (const c of leaderboard ?? []) {
      const lang = (c.language ?? '').trim().toLowerCase();
      if (lang) set.add(lang);
    }
    return Array.from(set).sort();
  }, [leaderboard]);
  // Regions — use values verbatim from c.region (e.g. "EMEA", "CIS", "APAC").
  // Order by frequency descending so the most common regions are leftmost.
  const availableRegions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of leaderboard ?? []) {
      const reg = (c.region ?? '').trim();
      if (reg) counts.set(reg, (counts.get(reg) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k);
  }, [leaderboard]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <ExploreShell
      title={series?.name ?? 'Explore'}
      seriesPicker={
        <SeriesQuickPicker
          seriesList={seriesList}
          seriesId={seriesId}
          onPick={(id) => navigate(`/explore/${id}`)}
        />
      }
      logout={logout}
    >
      <Col gap={14}>
        {/* Scope scrubber — one row: scrubber at natural width, Ask growing
            beside it, Compare + Views pinned right (wraps when squeezed).
            The "Showing:" caption is dropped — the ask box makes the current
            context obvious and the row width is precious. */}
        <div className="card" style={{ padding: '10px 14px' }}>
          <Row align="center" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 1 auto', minWidth: 0 }}>
              <ScopeScrubber
                level={scopeLevel}
                onLevelChange={handleScopeChange}
                stages={stageOptions}
                stageId={activeStage?.id}
                onStageChange={handleStageChange}
                days={dayOptions}
                dayId={dayIdFromUrl}
                onDayChange={handleDayChange}
                viewGroup="all"
                viewGroups={[]}
                showShowingLabel={false}
              />
            </div>
            <ExploreAskBox ask={ask} />
            <Row gap={8} align="center" style={{ marginLeft: 'auto' }}>
              {compareOptions.length > 0 && (
                <>
                  <span className="eyebrow" style={{ fontSize: 9.5 }}>
                    Compare vs
                  </span>
                  <select
                    value={compareId ?? ''}
                    onChange={(e) =>
                      updateUrl((p) => {
                        if (e.target.value) p.set('compare', e.target.value);
                        else p.delete('compare');
                      })
                    }
                    style={{
                      padding: '4px 8px',
                      fontSize: 11.5,
                      background: 'var(--bg-card)',
                      color: 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                    }}
                  >
                    <option value="">— none —</option>
                    {compareOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                        {o.sub ? ` · ${o.sub}` : ''}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <SavedViewsMenu />
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => navigate('/explore/compare')}
                title="Two events, day-aligned — peaks, averages, hours watched"
                style={{ cursor: 'pointer' }}
              >
                Compare events
              </button>
            </Row>
          </Row>
        </div>

        {/* Ask results — patch confirmation bar / answer card / refusal,
            directly under the scrubber card (renders nothing when idle) */}
        <ExploreAskResults ask={ask} />

        {/* Chart — uses InteractiveMainChart (the same component the exported
            reports render) when no channels are checked, so the visual style
            matches exactly. When 2-4 channels are checked we fall through to
            the custom multi-line overlay below. */}
        <Section
          eyebrow="01 · Timeline"
          title="Concurrent viewers — interactive"
          right={
            <Pill>
              {scopePillLabel({
                scopeLevel,
                stageName: activeStage?.name ?? null,
                dayLabel:
                  dayIdFromUrl
                    ? allDays.find((d) => d.id === dayIdFromUrl)?.label ?? null
                    : null,
                broadcastDayCount:
                  scopeLevel === 'series'
                    ? allDays.length
                    : scopeLevel === 'stage'
                      ? activeStage?.broadcast_days.length ?? 0
                      : 1,
              })}
            </Pill>
          }
        >
          {selectedChannelIds.length === 0 ? (
            timeline.total.length > 0 ? (
              <InteractiveMainChart
                height={280}
                width={1100}
                series={{
                  platform: timeline.platform,
                  region: timeline.region,
                  language: timeline.language,
                  total: timeline.total,
                }}
                totalData={timeline.total}
                timestamps={timeline.timestamps}
                timezone={series?.timezone ?? undefined}
                initialDimension="total"
                dayBoundaries={dayBoundaries}
                onTimestampClick={setAnchorTimestamp}
                onRangeSelect={(from, to) => setRange(from, to)}
                anchorTimestamp={atParam}
                rangeFrom={fromParam}
                rangeTo={toParam}
              />
            ) : (
              <div className="placeholder" style={{ height: 280 }}>
                {timeline.loading ? 'Loading…' : 'No time-series data'}
              </div>
            )
          ) : (
            <ExploreOverlayChart
              series={chartSeries}
              timestamps={timeline.timestamps}
              timezone={series?.timezone ?? 'UTC'}
              onTimestampClick={(iso) => setAnchorTimestamp(iso)}
              onRangeSelect={(from, to) => setRange(from, to)}
              anchorTimestamp={atParam}
              rangeFrom={fromParam}
              rangeTo={toParam}
            />
          )}
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: 'var(--fg-muted)',
              lineHeight: 1.5,
            }}
          >
            {buildChartDescription({
              seriesName: series?.name ?? null,
              scopeLevel,
              stageName: activeStage?.name ?? null,
              dayLabel:
                dayIdFromUrl
                  ? allDays.find((d) => d.id === dayIdFromUrl)?.label ?? null
                  : null,
              channelCount: channels.length,
              selectedChannels:
                selectedChannelIds.length > 0
                  ? selectedChannelIds
                      .map((cid) => leaderboard?.find((l) => l.channelId === cid)?.displayName ?? '—')
                  : [],
            })}
          </div>
        </Section>

        {/* Compare overlay — current scope vs a sibling scope, aligned by
            minutes-from-start so different days line up on one axis */}
        {compareId && compareLabel && (
          <CompareSection
            currentLabel={
              scopeLevel === 'day'
                ? allDays.find((d) => d.id === dayIdFromUrl)?.label ?? 'Current'
                : activeStage?.name ?? series?.name ?? 'Current'
            }
            currentValues={timeline.total}
            compareLabel={compareLabel}
            compareBuckets={(compareTs?.data as TimeSeriesBucket[] | undefined) ?? null}
          />
        )}

        {/* "All channels at T" panel — shown when a single timestamp is pinned */}
        {atParam && !fromParam && (
          <AllChannelsAtTimestampPanel
            timestamp={atParam}
            timezone={series?.timezone ?? 'UTC'}
            channels={atTimestampData?.channels ?? []}
            onClose={() => setAnchorTimestamp(null)}
          />
        )}

        {/* Range stats panel — shown when a window is dragged */}
        {fromParam && toParam && (
          <RangeStatsPanel
            from={fromParam}
            to={toParam}
            timezone={series?.timezone ?? 'UTC'}
            channels={rangeStats?.channels ?? []}
            onClose={() => setRange(null, null)}
          />
        )}

        {/* Channel table — filters live inside the card so they're visually
            attached to the data they affect. The chart above isn't impacted
            by these filters and shouldn't compete for attention with them. */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header row: count + selected + search */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <Row justify="space-between" align="center" style={{ flexWrap: 'wrap', gap: 12 }}>
              <Col gap={2}>
                <span className="eyebrow" style={{ fontSize: 10 }}>
                  Channels
                </span>
                <span style={{ fontSize: 13 }}>
                  {filtersActive
                    ? `${channels.length} of ${(leaderboard ?? []).length} channels`
                    : `${channels.length} channel${channels.length === 1 ? '' : 's'}`}
                  {filtersActive && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        style={{
                          background: 'transparent',
                          border: 0,
                          color: 'var(--fg-dim)',
                          cursor: 'pointer',
                          fontSize: 11,
                          textDecoration: 'underline',
                        }}
                      >
                        clear filters
                      </button>
                    </>
                  )}
                  {selectedChannelIds.length > 0 && (
                    <>
                      {' · '}
                      <span style={{ color: 'var(--red)' }}>
                        {selectedChannelIds.length} selected
                      </span>
                      {' '}
                      <button
                        type="button"
                        onClick={() => updateUrl((p) => p.delete('channels'))}
                        style={{
                          background: 'transparent',
                          border: 0,
                          color: 'var(--fg-dim)',
                          cursor: 'pointer',
                          fontSize: 11,
                          textDecoration: 'underline',
                        }}
                      >
                        clear
                      </button>
                    </>
                  )}
                </span>
                {capNotice && (
                  <span style={{ fontSize: 11, color: 'var(--warn)' }}>{capNotice}</span>
                )}
              </Col>
              <Row gap={6} style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => setShapeMetricsOn((v) => !v)}
                  title="Add per-channel curve-shape columns (stability, minutes ranked #1, consistency) — loads the full per-channel time-series for this scope"
                >
                  {shapeMetricsOn ? 'Shape ✓' : 'Shape'}
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={exportTableCsv}
                  title="Download the current (filtered) table as CSV"
                >
                  CSV
                </button>
                <IconSearch size={12} />
                <input
                  value={search}
                  onChange={(e) =>
                    updateUrl((p) => {
                      const v = e.target.value;
                      if (v) p.set('q', v);
                      else p.delete('q');
                    })
                  }
                  placeholder="Search channels…"
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    background: 'var(--bg-card)',
                    color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    width: 200,
                  }}
                />
              </Row>
            </Row>
          </div>

          {/* Compact filter bar — Platforms / Category / Language / Region in
              a single block. Inline labels (not stacked eyebrows) so it reads
              like a denser table-toolbar instead of three separate sections. */}
          {(availablePlatforms.length > 0 ||
            availableTiers.length > 0 ||
            availableLanguages.length > 0 ||
            availableRegions.length > 0) && (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
              <Col gap={6}>
                {availablePlatforms.length > 0 && (
                  <FilterChipRow label="Platforms">
                    {availablePlatforms.map((plat) => {
                      const active = platformFilter.includes(plat);
                      return (
                        <button
                          key={plat}
                          type="button"
                          onClick={() => togglePlatform(plat)}
                          style={chipStyle(active)}
                        >
                          <PlatformPip id={plat} size={9} />
                          {plat}
                        </button>
                      );
                    })}
                  </FilterChipRow>
                )}
                {availableTiers.length > 0 && (
                  <FilterChipRow label="Category">
                    {availableTiers.map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        onClick={() => toggleTier(tier)}
                        style={chipStyle(tierFilter.includes(tier))}
                        title={tier}
                      >
                        {prettyTier(tier)}
                      </button>
                    ))}
                  </FilterChipRow>
                )}
                {availableRegions.length > 0 && (
                  availableRegions.length > 8 ? (
                    <FilterChipRow label="Region">
                      <FilterMultiSelect
                        label="Region"
                        options={availableRegions.map((r) => ({ value: r, label: r }))}
                        selected={regionFilter}
                        onChange={setRegions}
                      />
                    </FilterChipRow>
                  ) : (
                    <FilterChipRow label="Region">
                      {availableRegions.map((reg) => (
                        <button
                          key={reg}
                          type="button"
                          onClick={() => toggleRegion(reg)}
                          style={chipStyle(regionFilter.includes(reg))}
                        >
                          {reg}
                        </button>
                      ))}
                    </FilterChipRow>
                  )
                )}
                {availableLanguages.length > 0 && (
                  // Languages are always a searchable popover — long tournaments
                  // surface 30–50 codes, which used to render as an unscannable
                  // wall of chips.
                  <FilterChipRow label="Language">
                    <FilterMultiSelect
                      label="Language"
                      options={availableLanguages.map((l) => ({ value: l, label: l.toUpperCase() }))}
                      selected={languageFilter}
                      onChange={setLanguages}
                    />
                  </FilterChipRow>
                )}
                {(platformFilter.length > 0 ||
                  tierFilter.length > 0 ||
                  regionFilter.length > 0 ||
                  languageFilter.length > 0 ||
                  search) && (
                  <Row style={{ alignItems: 'center', marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={() =>
                        updateUrl((p) => {
                          p.delete('platforms');
                          p.delete('tiers');
                          p.delete('regions');
                          p.delete('languages');
                          p.delete('q');
                        })
                      }
                      style={{
                        background: 'transparent',
                        border: 0,
                        color: 'var(--fg-dim)',
                        cursor: 'pointer',
                        fontSize: 10.5,
                        textDecoration: 'underline',
                        padding: 0,
                      }}
                    >
                      Reset all filters
                    </button>
                    <div style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                      Click a row to graph it. Up to {MAX_OVERLAY_CHANNELS} for overlay.
                    </span>
                  </Row>
                )}
              </Col>
            </div>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: tableGridColumns,
              padding: '8px 12px',
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-sunken)',
            }}
          >
            <div />
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="name">
              Channel
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="platform">
              Platform
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="tier">
              Tier
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="language">
              Lang
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="peak" align="right">
              Peak
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="avg" align="right">
              Avg
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="hours" align="right">
              Viewed Hours
            </SortHeader>
            {shapeMetricsOn && (
              <>
                <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="stability" align="right">
                  <span title="Coefficient of variation — lower = steadier curve">Var%</span>
                </SortHeader>
                <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="minutesAt1" align="right">
                  <span title="Minutes this channel was the single biggest in the scope">Min @#1</span>
                </SortHeader>
                <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="consistency" align="right">
                  <span title="% of live minutes at or above half the channel's own peak">≥½ peak</span>
                </SortHeader>
              </>
            )}
          </div>
          <div>
            {lbLoading && channels.length === 0 ? (
              <div className="placeholder" style={{ height: 100, margin: 12 }}>
                Loading channels…
              </div>
            ) : channels.length === 0 ? (
              <div className="placeholder" style={{ height: 100, margin: 12 }}>
                No channels match the current filters.
              </div>
            ) : (
              lb.sorted.map((c) => {
                const isSelected = selectedChannelIds.includes(c.id);
                const colorIdx = selectedChannelIds.indexOf(c.id);
                return (
                  <div
                    key={c.id}
                    onClick={() => toggleChannel(c.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: tableGridColumns,
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--border-faint)',
                      fontSize: 12.5,
                      alignItems: 'center',
                      cursor: 'pointer',
                      background: isSelected ? 'color-mix(in oklab, var(--red) 8%, transparent)' : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 3,
                          border: `2px solid ${
                            isSelected
                              ? OVERLAY_COLORS[colorIdx % OVERLAY_COLORS.length]
                              : 'var(--border)'
                          }`,
                          background: isSelected
                            ? OVERLAY_COLORS[colorIdx % OVERLAY_COLORS.length]
                            : 'transparent',
                          display: 'inline-block',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <PlatformPip id={c.platform} />
                      <ChannelNameWithLink
                        name={c.name}
                        platform={c.platform}
                        channelIdentifier={c.channelIdentifier}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{c.platform}</div>
                    <div>
                      <TierBadge tier={c.tier} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                      {c.language ?? '—'}
                    </div>
                    <div className="tabular" style={{ textAlign: 'right' }}>
                      {fmtN(c.peak)}
                    </div>
                    <div className="tabular" style={{ textAlign: 'right' }}>
                      {fmtN(c.avg)}
                    </div>
                    <div className="tabular" style={{ textAlign: 'right' }}>
                      {fmtN(c.hours)}
                    </div>
                    {shapeMetricsOn && (
                      <>
                        <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
                          {c.stability != null ? `${c.stability}%` : '…'}
                        </div>
                        <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
                          {c.minutesAt1 != null ? fmtN(c.minutesAt1) : '…'}
                        </div>
                        <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
                          {c.consistency != null ? `${c.consistency}%` : '…'}
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {/* Totals + averages footer.
              Sum-of-peaks and sum-of-averages are statistically meaningless
              (peaks happen at different moments). The correct combined
              metrics are MAX and AVG of the per-minute total CCV — which
              `timeline.total` already gives us (it's the same series the
              chart draws). Total viewed-hours IS additive and is summed
              from the per-channel viewed-hours. */}
          {channels.length > 0 && (
            <ChannelTableTotals
              rows={lb.sorted}
              totalSeries={timeline.total}
            />
          )}
        </div>
      </Col>
    </ExploreShell>
  );
}

// ── Totals / averages footer ──────────────────────────────────────────────
// Stats that make sense across heterogeneous channels:
//   • Combined peak  = MAX over time of (sum of all-channel CCV at that minute)
//   • Combined avg   = AVG over live minutes of (sum of all-channel CCV)
//   • Top channel    = single best peak in the visible rows (sortable info)
//   • Total hours    = SUM of per-channel viewed-hours (genuinely additive)
function ChannelTableTotals({
  rows,
  totalSeries,
}: {
  rows: { peak: number; avg: number; hours: number; name: string }[];
  totalSeries: number[];
}) {
  const n = rows.length;
  const sumHours = rows.reduce((s, r) => s + (r.hours || 0), 0);

  // Top single-channel peak (just the biggest individual moment from the visible rows)
  const top = rows.reduce(
    (best, r) => ((r.peak || 0) > best.peak ? { peak: r.peak || 0, name: r.name } : best),
    { peak: 0, name: '' },
  );

  // Combined metrics from the chart's per-minute total series.
  // Live minutes = minutes with non-zero combined CCV (excludes pre/post-broadcast gaps).
  const ccvs = totalSeries;
  const liveCcvs = ccvs.filter((v) => v > 0);
  const combinedPeak = ccvs.length > 0 ? Math.max(...ccvs) : 0;
  const combinedAvg =
    liveCcvs.length > 0 ? Math.round(liveCcvs.reduce((s, v) => s + v, 0) / liveCcvs.length) : 0;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr 100px 110px 90px 100px 100px 110px',
        padding: '12px 12px',
        fontSize: 12,
        borderTop: '2px solid var(--border)',
        background: 'var(--bg-sunken)',
        fontWeight: 600,
        rowGap: 4,
      }}
    >
      <div />
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>
        {n.toLocaleString('en-US')} channel{n === 1 ? '' : 's'} · combined peak / avg / hours
      </div>
      <div />
      <div />
      <div />
      <div
        className="tabular"
        style={{ textAlign: 'right' }}
        title="Combined peak — max of (sum of every channel's CCV at the same minute). Top single-channel peak shown below."
      >
        {fmtN(combinedPeak)}
        <div style={{ fontSize: 10, color: 'var(--fg-dim)', fontWeight: 400 }}>
          top: {top.name ? `${fmtN(top.peak)} (${top.name})` : '—'}
        </div>
      </div>
      <div
        className="tabular"
        style={{ textAlign: 'right' }}
        title="Combined average — average across live minutes of (sum of every channel's CCV). Excludes minutes with zero combined CCV."
      >
        {fmtN(combinedAvg)}
        <div style={{ fontSize: 10, color: 'var(--fg-dim)', fontWeight: 400 }}>
          live mins: {fmtN(liveCcvs.length)}
        </div>
      </div>
      <div
        className="tabular"
        style={{ textAlign: 'right' }}
        title="Sum of viewed-hours across all visible channels — genuinely additive."
      >
        {fmtN(Math.round(sumHours))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function ExploreShell({
  title,
  subtitle,
  seriesPicker,
  children,
}: {
  title: string;
  subtitle?: string;
  seriesPicker?: React.ReactNode;
  /** @deprecated TopNav owns sign-out now; kept for call-site compatibility. */
  logout?: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  // Brand / theme / account / series-switcher all live in the global TopNav
  // now; ExploreShell is just a page title strip + content frame.
  return (
    <div style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <div
        style={{
          position: 'sticky',
          top: 'var(--topnav-h)',
          zIndex: 9,
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
          padding: '12px 22px',
        }}
      >
        <Row justify="space-between" align="center" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Row gap={12} align="baseline" style={{ minWidth: 0 }}>
            <span
              className="eyebrow"
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                letterSpacing: 1.4,
                fontFamily: 'var(--font-mono)',
              }}
            >
              EXPLORE
            </span>
            <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>
              {title}
            </h1>
            {subtitle && (
              <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{subtitle}</span>
            )}
          </Row>
          {seriesPicker}
        </Row>
      </div>

      <div
        style={{
          padding: '20px 22px 40px',
          maxWidth: 1400,
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ExploreMenuItem({
  children,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        background: 'transparent',
        border: 0,
        textAlign: 'left',
        fontSize: 13,
        color: 'var(--fg)',
        cursor: 'pointer',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-sunken)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function SeriesPicker({
  seriesList,
  onPick,
}: {
  seriesList: TournamentSeries[];
  onPick: (id: string) => void;
}) {
  return (
    <Col gap={12}>
      {seriesList.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s.id)}
          className="card"
          style={{
            padding: 16,
            textAlign: 'left',
            cursor: 'pointer',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Col gap={4} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{s.name}</div>
            <Row gap={6} style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {s.short_name && <span>{s.short_name}</span>}
              {s.partner && <span>· {s.partner}</span>}
              {s.game && <span>· {s.game}</span>}
              <Pill tone={s.status === 'active' ? 'live' : 'default'}>{s.status}</Pill>
            </Row>
          </Col>
          <IconChev size={16} />
        </button>
      ))}
    </Col>
  );
}

function SeriesQuickPicker({
  seriesList,
  seriesId,
  onPick,
}: {
  seriesList: TournamentSeries[];
  seriesId: string;
  onPick: (id: string) => void;
}) {
  return (
    <select
      value={seriesId}
      onChange={(e) => onPick(e.target.value)}
      style={{
        padding: '6px 10px',
        fontSize: 13,
        background: 'var(--bg-card)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        maxWidth: 320,
      }}
    >
      {seriesList.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

interface OverlaySeriesData {
  id: string;
  name: string;
  platform: string;
  color: string;
  /**
   * Parallel array to the chart's `timestamps[]` prop. `null` means "no data
   * at that index" — the line breaks here. Values are CCV.
   */
  values: Array<number | null>;
}

type ChartMode = 'total' | 'platform' | 'language' | 'category';

/**
 * Multi-channel overlay chart. Used by Explore when 1-4 channels are checked
 * for side-by-side comparison. The "no channels selected" view delegates to
 * InteractiveMainChart instead so the styling matches the exported reports.
 */
function ExploreOverlayChart({
  series,
  timestamps,
  timezone,
  onTimestampClick,
  onRangeSelect,
  anchorTimestamp,
  rangeFrom,
  rangeTo,
}: {
  series: OverlaySeriesData[];
  timestamps: string[];
  timezone: string;
  onTimestampClick: (iso: string) => void;
  onRangeSelect: (fromIso: string, toIso: string) => void;
  anchorTimestamp: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(960);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Drag-to-select state. dragStart is the SVG-local x where pointerdown fired.
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const N = timestamps.length;
  const maxV = useMemo(() => {
    let mv = 0;
    for (const s of series) {
      for (const v of s.values) {
        if (v != null && v > mv) mv = v;
      }
    }
    return mv;
  }, [series]);

  const height = 280;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const dataW = Math.max(0, width - pad.l - pad.r);
  const dataH = Math.max(0, height - pad.t - pad.b);

  // Index-based positioning — every data sample gets an equal slice of the
  // x-axis regardless of wall-clock time. This collapses dead minutes between
  // broadcasts so the chart shows just the broadcasts side-by-side, matching
  // the legacy report style.
  function xOfIdx(i: number) {
    if (N <= 1) return pad.l;
    return pad.l + (i / (N - 1)) * dataW;
  }
  function xToIdx(x: number) {
    if (N <= 1) return 0;
    const frac = (x - pad.l) / dataW;
    return Math.max(0, Math.min(N - 1, Math.round(frac * (N - 1))));
  }
  function yOf(v: number) {
    if (maxV === 0) return pad.t + dataH;
    return pad.t + (1 - v / maxV) * dataH;
  }

  // Build SVG path. null values break the line (gap between broadcasts has no
  // rows in the underlying time-series, but if a channel-overlay series has
  // null at certain indices we want a real visual gap there too).
  function valuesToPath(vals: Array<number | null>) {
    const parts: string[] = [];
    let prev: number | null = null;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i] ?? null;
      if (v == null) {
        prev = null;
        continue;
      }
      const cmd = prev == null ? 'M' : 'L';
      parts.push(`${cmd}${xOfIdx(i).toFixed(1)},${yOf(v).toFixed(1)}`);
      prev = v;
    }
    return parts.join(' ');
  }

  const fmtX = (iso: string, includeDate: boolean) => {
    const d = new Date(iso);
    return formatChartTimeInTz(d, timezone, includeDate) || iso;
  };

  // Pick 4-6 evenly spaced indices for X labels. When the series spans
  // multiple days the labels are "Apr 24 · 17:15" style; same-day uses the
  // shorter "17:15" form.
  const xLabelIndices = useMemo(() => {
    if (N === 0) return [] as number[];
    const target = 5;
    const step = Math.max(1, Math.floor(N / target));
    const out: number[] = [];
    for (let i = 0; i < N; i += step) out.push(i);
    if (out[out.length - 1] !== N - 1) out.push(N - 1);
    return out;
  }, [N]);

  const includeDateInXLabel = useMemo(() => {
    if (N < 2) return false;
    const first = new Date(timestamps[0]!);
    const last = new Date(timestamps[N - 1]!);
    return (
      first.getUTCDate() !== last.getUTCDate() ||
      first.getUTCMonth() !== last.getUTCMonth()
    );
  }, [timestamps, N]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < pad.l || x > width - pad.r) return;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragStart(x);
      setDragEnd(x);
    },
    [pad.l, pad.r, width],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clampedX = Math.max(pad.l, Math.min(width - pad.r, x));
      if (x < pad.l || x > width - pad.r) {
        setHoverIdx(null);
      } else {
        setHoverIdx(xToIdx(clampedX));
      }
      if (dragStart !== null) {
        setDragEnd(clampedX);
      }
    },
    [pad.l, pad.r, width, dragStart, xToIdx],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clampedX = Math.max(pad.l, Math.min(width - pad.r, x));
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore — capture may have already been lost */
      }
      if (dragStart === null) return;
      const dist = Math.abs(clampedX - dragStart);
      if (dist < 5) {
        // Click → single-timestamp anchor
        const idx = xToIdx(clampedX);
        if (timestamps[idx]) onTimestampClick(timestamps[idx]!);
      } else {
        // Drag → range selection
        const idxA = xToIdx(Math.min(dragStart, clampedX));
        const idxB = xToIdx(Math.max(dragStart, clampedX));
        const a = timestamps[idxA];
        const b = timestamps[idxB];
        if (a && b && a !== b) onRangeSelect(a, b);
      }
      setDragStart(null);
      setDragEnd(null);
    },
    [dragStart, width, pad.l, pad.r, xToIdx, timestamps, onTimestampClick, onRangeSelect],
  );

  const handlePointerLeave = useCallback(() => {
    setHoverIdx(null);
  }, []);

  const anchorIdx = useMemo(() => {
    if (!anchorTimestamp || N === 0) return null;
    const target = new Date(anchorTimestamp).getTime();
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(new Date(timestamps[i]!).getTime() - target);
      if (d < bestDelta) {
        bestDelta = d;
        best = i;
      }
    }
    return bestDelta < 90_000 ? best : null;
  }, [anchorTimestamp, timestamps, N]);

  const rangeFromIdx = useMemo(() => {
    if (!rangeFrom || N === 0) return null;
    return findClosestIdx(timestamps, rangeFrom);
  }, [rangeFrom, timestamps, N]);
  const rangeToIdx = useMemo(() => {
    if (!rangeTo || N === 0) return null;
    return findClosestIdx(timestamps, rangeTo);
  }, [rangeTo, timestamps, N]);

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {/* Legend (multi-series only) */}
      {series.length > 1 && (
        <Row gap={12} style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          {series.map((s) => (
            <Row key={s.id} gap={6} align="center">
              <span
                style={{
                  width: 12,
                  height: 3,
                  background: s.color,
                  borderRadius: 1,
                }}
              />
              <span style={{ fontSize: 11 }}>{s.name}</span>
              {s.platform !== '—' && (
                <span className="mono" style={{ fontSize: 9, color: 'var(--fg-dim)' }}>
                  {s.platform}
                </span>
              )}
            </Row>
          ))}
        </Row>
      )}

      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={height}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{ cursor: 'crosshair', display: 'block', userSelect: 'none' }}
        >
          {/* Y gridlines */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1={pad.l}
              x2={width - pad.r}
              y1={pad.t + dataH * (1 - f)}
              y2={pad.t + dataH * (1 - f)}
              stroke="var(--border-faint)"
              strokeDasharray="3,3"
            />
          ))}
          {/* Y axis labels */}
          {[0, 0.5, 1].map((f) => (
            <text
              key={f}
              x={pad.l - 8}
              y={pad.t + dataH * (1 - f) + 4}
              textAnchor="end"
              fontSize={10}
              fill="var(--fg-dim)"
            >
              {fmtCompact(maxV * f)}
            </text>
          ))}

          {/* X axis labels — pick evenly-spaced data indices, format the
              underlying timestamp as "Apr 24 · 17:15" (multi-day) or "17:15". */}
          {N > 0 && xLabelIndices.map((idx, i) => {
            const x = xOfIdx(idx);
            const txt = fmtX(timestamps[idx]!, includeDateInXLabel);
            const anchor = i === 0 ? 'start' : i === xLabelIndices.length - 1 ? 'end' : 'middle';
            return (
              <text
                key={idx}
                x={x}
                y={height - 8}
                textAnchor={anchor}
                fontSize={10}
                fill="var(--fg-dim)"
              >
                {txt}
              </text>
            );
          })}

          {/* Pinned range highlight (when from+to are set) */}
          {rangeFromIdx !== null && rangeToIdx !== null && (
            <rect
              x={Math.min(xOfIdx(rangeFromIdx), xOfIdx(rangeToIdx))}
              y={pad.t}
              width={Math.abs(xOfIdx(rangeToIdx) - xOfIdx(rangeFromIdx))}
              height={dataH}
              fill="var(--red)"
              fillOpacity={0.12}
              stroke="var(--red)"
              strokeOpacity={0.4}
              strokeWidth={1}
              strokeDasharray="3,3"
            />
          )}

          {/* In-progress drag rectangle */}
          {dragStart !== null && dragEnd !== null && Math.abs(dragEnd - dragStart) >= 5 && (
            <rect
              x={Math.min(dragStart, dragEnd)}
              y={pad.t}
              width={Math.abs(dragEnd - dragStart)}
              height={dataH}
              fill="var(--red)"
              fillOpacity={0.18}
            />
          )}

          {/* Data lines */}
          {series.map((s) => (
            <path
              key={s.id}
              d={valuesToPath(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Anchor line (clicked timestamp) */}
          {anchorIdx !== null && (
            <line
              x1={xOfIdx(anchorIdx)}
              x2={xOfIdx(anchorIdx)}
              y1={pad.t}
              y2={pad.t + dataH}
              stroke="var(--red)"
              strokeWidth={1}
              strokeDasharray="4,3"
            />
          )}

          {/* Hover line + per-series dots */}
          {hoverIdx !== null && dragStart === null && (
            <>
              <line
                x1={xOfIdx(hoverIdx)}
                x2={xOfIdx(hoverIdx)}
                y1={pad.t}
                y2={pad.t + dataH}
                stroke="var(--fg-dim)"
                strokeWidth={1}
              />
              {series.map((s) => {
                const v = s.values[hoverIdx];
                if (v == null) return null;
                return (
                  <circle
                    key={s.id}
                    cx={xOfIdx(hoverIdx)}
                    cy={yOf(v)}
                    r={4}
                    fill={s.color}
                    stroke="var(--bg-card)"
                    strokeWidth={2}
                  />
                );
              })}
            </>
          )}
        </svg>

        {/* Hover tooltip */}
        {hoverIdx !== null && dragStart === null && timestamps[hoverIdx] && (
          <div
            style={{
              position: 'absolute',
              top: pad.t + 4,
              left:
                xOfIdx(hoverIdx) > width / 2
                  ? Math.max(pad.l, xOfIdx(hoverIdx) - 220)
                  : Math.min(width - pad.r - 200, xOfIdx(hoverIdx) + 12),
              minWidth: 180,
              maxWidth: 240,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 10px',
              boxShadow: '0 6px 18px rgba(0,0,0,0.30)',
              pointerEvents: 'none',
              fontSize: 11,
              zIndex: 5,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 10, color: 'var(--fg-dim)', marginBottom: 6 }}
            >
              {fmtX(timestamps[hoverIdx]!, true)}
            </div>
            {series.map((s) => {
              const v = s.values[hoverIdx];
              return (
                <Row
                  key={s.id}
                  gap={8}
                  style={{ alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}
                >
                  <Row gap={6} align="center" style={{ minWidth: 0 }}>
                    <span
                      style={{
                        width: 10,
                        height: 2,
                        background: s.color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.name}
                    </span>
                  </Row>
                  <span className="tabular" style={{ fontSize: 11.5, fontWeight: 600 }}>
                    {v != null ? fmtCompact(v) : '—'}
                  </span>
                </Row>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}

/**
 * Compact filter row — small inline label on the left, wrap-row of chips on
 * the right. Designed to live inside a card alongside other rows so the
 * page reads as one cohesive filter block, not three separate sections.
 */
function FilterChipRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Row gap={10} style={{ flexWrap: 'wrap', alignItems: 'center', minHeight: 24 }}>
      <span
        style={{
          fontSize: 9.5,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: 'var(--font-mono)',
          minWidth: 64,
        }}
      >
        {label}
      </span>
      {children}
    </Row>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 11,
    textTransform: 'capitalize',
    background: active ? 'var(--red)' : 'transparent',
    border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
    color: active ? 'white' : 'var(--fg-muted)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: 'nowrap',
  };
}

function prettyTier(tier: string): string {
  switch (tier) {
    case 'official':
      return 'Official';
    case 'partner':
      return 'Partner';
    case 'player':
      return 'Player';
    case 'community':
      return 'Community';
    case 'watch_party':
      return 'Watch Party';
    default:
      return tier.replace(/_/g, ' ');
  }
}

function findClosestIdx(timestamps: string[], iso: string): number | null {
  if (timestamps.length === 0) return null;
  const target = new Date(iso).getTime();
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const d = Math.abs(new Date(timestamps[i]!).getTime() - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}

function AllChannelsAtTimestampPanel({
  timestamp,
  timezone,
  channels,
  onClose,
}: {
  timestamp: string;
  timezone: string;
  channels: ChannelAtTimestamp[];
  onClose: () => void;
}) {
  const sortable = useSortable(channels, 'ccv', 'desc');
  const [expanded, setExpanded] = useState(false);
  const d = new Date(timestamp);

  // Same column shape as the main channel table for visual continuity:
  // Channel · Platform · Tier · Lang · CCV.
  const COLS = '1fr 100px 110px 80px 110px';

  // Combined CCV at this exact minute (sum of every channel's value).
  const combined = channels.reduce((s, c) => s + (c.ccv || 0), 0);

  return (
    <div className="card" style={{ padding: 14 }}>
      <Row justify="space-between" align="center" style={{ marginBottom: 10 }}>
        <Col gap={2}>
          <span className="eyebrow" style={{ fontSize: 10 }}>
            All channels at
          </span>
          <span className="tabular" style={{ fontSize: 14, fontWeight: 600 }}>
            {formatChartTimeInTz(d, timezone, true) || d.toUTCString()}
          </span>
        </Col>
        <Row gap={8} align="center">
          <span
            className="tabular"
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-mono)',
            }}
            title="Sum of CCV across every channel reporting in this minute"
          >
            {channels.length} channels · combined {fmtN(combined)}
          </span>
          <button
            type="button"
            className="btn btn-xs"
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid var(--border)' }}
          >
            Close
          </button>
        </Row>
      </Row>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          padding: '6px 0',
          fontSize: 10,
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="displayName">
          Channel
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="platform">
          Platform
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="tier">
          Category
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="language">
          Lang
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="ccv" align="right">
          CCV
        </SortHeader>
      </div>
      <div style={expanded ? undefined : { maxHeight: 320, overflowY: 'auto' }}>
        {sortable.sorted.length === 0 ? (
          <div className="placeholder" style={{ height: 60, marginTop: 8 }}>
            No channel had data at that minute.
          </div>
        ) : (
          sortable.sorted.map((c) => (
            <div
              key={c.channelId}
              style={{
                display: 'grid',
                gridTemplateColumns: COLS,
                padding: '6px 0',
                fontSize: 12,
                borderBottom: '1px solid var(--border-faint)',
                alignItems: 'center',
              }}
            >
              <Row gap={8} align="center" style={{ minWidth: 0 }}>
                <PlatformPip id={c.platform} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.displayName}
                </span>
              </Row>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{c.platform}</span>
              <span><TierBadge tier={c.tier} /></span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                {c.language ?? '—'}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtN(c.ccv)}
              </span>
            </div>
          ))
        )}
      </div>
      {sortable.sorted.length > 0 && (
        <Row justify="space-between" align="center" style={{ marginTop: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {expanded
              ? `Showing all ${sortable.sorted.length} channels`
              : sortable.sorted.length > 8
                ? `Showing top 8 of ${sortable.sorted.length} — scroll for more or expand to fit all`
                : `${sortable.sorted.length} channel${sortable.sorted.length === 1 ? '' : 's'}`}
          </span>
          {sortable.sorted.length > 8 && (
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => setExpanded((v) => !v)}
              style={{ background: 'transparent', border: '1px solid var(--border)' }}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </Row>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function fetchLeaderboard(
  seriesId: string,
  level: ScopeLevel,
  scopeId: string,
): Promise<LeaderboardStats[]> {
  const scopeEntityId = level === 'series' ? undefined : scopeId;
  const res = await api.getChannelLeaderboard(seriesId, level, scopeEntityId);
  return res.channels ?? [];
}

/**
 * Concise scope-name pill shown on the right of the chart header — matches
 * the legacy report style. Examples:
 *   • "Full series · 17 days"
 *   • "Finals 1 · 3 days"
 *   • "Day 3 · Apr 26"
 */
function scopePillLabel({
  scopeLevel,
  stageName,
  dayLabel,
  broadcastDayCount,
}: {
  scopeLevel: ScopeLevel;
  stageName: string | null;
  dayLabel: string | null;
  broadcastDayCount: number;
}): string {
  if (scopeLevel === 'day') return dayLabel ?? 'Day';
  if (scopeLevel === 'stage') {
    const n = broadcastDayCount;
    return `${stageName ?? 'Stage'} · ${n} day${n === 1 ? '' : 's'}`;
  }
  return `Full series · ${broadcastDayCount} day${broadcastDayCount === 1 ? '' : 's'}`;
}

/** Short factual description shown below the chart. */
function buildChartDescription({
  seriesName,
  scopeLevel,
  stageName,
  dayLabel,
  channelCount,
  selectedChannels,
}: {
  seriesName: string | null;
  scopeLevel: ScopeLevel;
  stageName: string | null;
  dayLabel: string | null;
  channelCount: number;
  selectedChannels: string[];
}): string {
  const scopeText =
    scopeLevel === 'series'
      ? `${seriesName ?? 'series'}`
      : scopeLevel === 'stage'
        ? `${stageName ?? 'stage'}`
        : `${dayLabel ?? 'day'}`;
  if (selectedChannels.length === 0) {
    return `${scopeText} — concurrent viewers across ${channelCount} tracked channel${channelCount === 1 ? '' : 's'}.`;
  }
  return `${scopeText} — overlay of ${selectedChannels.length} selected channel${selectedChannels.length === 1 ? '' : 's'}: ${selectedChannels.slice(0, 4).join(', ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────
// ── Compare section — current scope vs sibling scope ─────────────────────
//
// Two total-CCV curves aligned by MINUTE INDEX from each scope's own start
// (not wall clock), so "Day 1 vs Day 3" overlays broadcast-hour over
// broadcast-hour. Includes a peak/avg/hours delta strip.

function CompareSection({
  currentLabel,
  currentValues,
  compareLabel,
  compareBuckets,
}: {
  currentLabel: string;
  currentValues: number[];
  compareLabel: string;
  compareBuckets: TimeSeriesBucket[] | null;
}) {
  const compareValues = useMemo(
    () =>
      (compareBuckets ?? [])
        .slice()
        .sort((a, b) =>
          String(a.timestamp ?? a.bucket ?? '').localeCompare(String(b.timestamp ?? b.bucket ?? '')),
        )
        .map((b) => Number(b.totalCCV ?? b.total_ccv ?? 0)),
    [compareBuckets],
  );

  const stats = (vals: number[]) => {
    const live = vals.filter((v) => v > 0);
    const peak = live.length ? Math.max(...live) : 0;
    const avg = live.length ? Math.round(live.reduce((s, v) => s + v, 0) / live.length) : 0;
    const hours = Math.round(vals.reduce((s, v) => s + v, 0) / 60);
    return { peak, avg, hours };
  };
  const cur = stats(currentValues);
  const cmp = stats(compareValues);
  const delta = (a: number, b: number) =>
    b > 0 ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(0)}%` : '—';

  const N = Math.max(currentValues.length, compareValues.length);
  const maxY = Math.max(cur.peak, cmp.peak, 1);
  const W = 960;
  const H = 200;
  const PAD = 6;
  const toPoints = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = PAD + (i / Math.max(N - 1, 1)) * (W - PAD * 2);
        const y = H - PAD - (v / maxY) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const hourTicks = useMemo(() => {
    const ticks: Array<{ x: number; label: string }> = [];
    for (let m = 0; m < N; m += 60) {
      ticks.push({
        x: PAD + (m / Math.max(N - 1, 1)) * (W - PAD * 2),
        label: `+${m / 60}h`,
      });
    }
    return ticks;
  }, [N]);

  if (compareBuckets === null) {
    return (
      <div className="card" style={{ padding: 14 }}>
        <div className="placeholder" style={{ height: 80 }}>
          Loading comparison…
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <Row justify="space-between" align="center" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <Col gap={2}>
          <span className="eyebrow" style={{ fontSize: 10 }}>
            Compare · aligned by minutes from start
          </span>
          <Row gap={12} style={{ fontSize: 12 }}>
            <Row gap={5} align="center">
              <span style={{ width: 14, height: 3, background: 'var(--red)', display: 'inline-block' }} />
              <span style={{ fontWeight: 600 }}>{currentLabel}</span>
            </Row>
            <Row gap={5} align="center">
              <span
                style={{
                  width: 14,
                  height: 0,
                  borderTop: '3px dashed var(--info)',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontWeight: 600 }}>{compareLabel}</span>
            </Row>
          </Row>
        </Col>
        <Row gap={14} style={{ fontSize: 11.5 }}>
          {[
            { label: 'Peak', a: cur.peak, b: cmp.peak },
            { label: 'Avg', a: cur.avg, b: cmp.avg },
            { label: 'Viewed hours', a: cur.hours, b: cmp.hours },
          ].map((m) => (
            <Col key={m.label} gap={1} style={{ textAlign: 'right' }}>
              <span className="eyebrow" style={{ fontSize: 9 }}>
                {m.label}
              </span>
              <span className="tabular">
                {fmtCompact(m.a)} vs {fmtCompact(m.b)}{' '}
                <span
                  style={{
                    color: m.a >= m.b ? 'var(--live)' : 'var(--danger)',
                    fontWeight: 600,
                  }}
                >
                  {delta(m.a, m.b)}
                </span>
              </span>
            </Col>
          ))}
        </Row>
      </Row>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {hourTicks.map((t) => (
          <line
            key={t.x}
            x1={t.x}
            y1={PAD}
            x2={t.x}
            y2={H - PAD}
            stroke="var(--border-faint)"
            strokeWidth={1}
          />
        ))}
        {compareValues.length > 1 && (
          <polyline
            points={toPoints(compareValues)}
            fill="none"
            stroke="var(--info)"
            strokeWidth={1.6}
            strokeDasharray="5 4"
          />
        )}
        {currentValues.length > 1 && (
          <polyline
            points={toPoints(currentValues)}
            fill="none"
            stroke="var(--red)"
            strokeWidth={1.8}
          />
        )}
      </svg>
      <Row justify="space-between" style={{ fontSize: 9.5, color: 'var(--fg-dim)', marginTop: 2 }}>
        {hourTicks.slice(0, 12).map((t) => (
          <span key={t.x} className="mono">
            {t.label}
          </span>
        ))}
      </Row>
    </div>
  );
}

// ── Saved views — named bookmarks of the full Explore URL state ──────────
//
// A filtered + scoped + overlaid Explore view is entirely URL-encoded, so a
// "view" is just a named URL. Stored in localStorage.

const SAVED_VIEWS_KEY = 'explore-saved-views';

interface SavedView {
  name: string;
  path: string;
  savedAt: string;
}

function readSavedViews(): SavedView[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') as SavedView[];
  } catch {
    return [];
  }
}

function SavedViewsMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>(readSavedViews);
  const [name, setName] = useState('');

  const persist = (next: SavedView[]) => {
    setViews(next);
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
  };

  const saveCurrent = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const path = window.location.pathname + window.location.search;
    persist([
      { name: trimmed, path, savedAt: new Date().toISOString() },
      ...views.filter((v) => v.name !== trimmed),
    ]);
    setName('');
  };

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn btn-xs" onClick={() => setOpen((v) => !v)}>
        Views{views.length > 0 ? ` (${views.length})` : ''} ▾
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: 'absolute',
            right: 0,
            top: '110%',
            zIndex: 50,
            width: 300,
            padding: 10,
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <Row gap={6} style={{ marginBottom: 8 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveCurrent()}
              placeholder="Name this view…"
              style={{
                flex: 1,
                padding: '5px 8px',
                fontSize: 11.5,
                background: 'var(--bg-card)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 5,
              }}
            />
            <button type="button" className="btn btn-xs" onClick={saveCurrent} disabled={!name.trim()}>
              Save
            </button>
          </Row>
          {views.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              No saved views yet — set up scope, filters and overlays, then
              save the state under a name.
            </div>
          ) : (
            <Col gap={2}>
              {views.map((v) => (
                <Row key={v.name} gap={6} align="center">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      navigate(v.path);
                    }}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 0,
                      color: 'var(--fg)',
                      fontSize: 12,
                      padding: '4px 2px',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={v.path}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => persist(views.filter((x) => x.name !== v.name))}
                    style={{
                      background: 'transparent',
                      border: 0,
                      color: 'var(--fg-dim)',
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                    title="Delete saved view"
                  >
                    ✕
                  </button>
                </Row>
              ))}
            </Col>
          )}
        </div>
      )}
    </div>
  );
}

// Range stats panel — shown when the user drags across the chart to select
// a window. Lists every channel that had data inside [from, to] with peak,
// average, and viewed-hours stats. Backed by /api/viewership/range-leaderboard.
// ─────────────────────────────────────────────────────────────────────────

function RangeStatsPanel({
  from,
  to,
  timezone,
  channels,
  onClose,
}: {
  from: string;
  to: string;
  timezone: string;
  channels: LeaderboardStats[];
  onClose: () => void;
}) {
  const sortable = useSortable(channels, 'peakCCV', 'desc');
  const [expanded, setExpanded] = useState(false);
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const durMs = toDate.getTime() - fromDate.getTime();
  const durMin = Math.round(durMs / 60_000);
  const durLabel =
    durMin >= 60
      ? `${Math.floor(durMin / 60)}h ${durMin % 60}m`
      : `${durMin} min`;

  // Same column shape as the main channel table.
  const COLS = '1fr 100px 110px 80px 100px 100px 100px';

  // Total viewed-hours IS additive across channels.
  const sumHours = sortable.sorted.reduce((s, c) => s + (c.viewedHours ?? 0), 0);
  const top = sortable.sorted.reduce(
    (best, c) => ((c.peakCCV ?? 0) > best.peak
      ? { peak: c.peakCCV ?? 0, name: c.displayName }
      : best),
    { peak: 0, name: '' },
  );

  // Share of the window's viewed hours by platform and by language —
  // computed from the per-channel rows (viewed hours are additive, so the
  // shares are exact; per-group "peak" would NOT be, so we don't show one).
  const shareBars = (key: 'platform' | 'language') => {
    const sums = new Map<string, number>();
    for (const c of channels) {
      const k = (key === 'platform' ? c.platform : c.language) || '—';
      sums.set(k, (sums.get(k) ?? 0) + (c.viewedHours ?? 0));
    }
    return [...sums.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, hours]) => ({
        label,
        hours,
        share: sumHours > 0 ? hours / sumHours : 0,
      }));
  };
  const platformShares = shareBars('platform');
  const languageShares = shareBars('language');

  const exportRangeCsv = () =>
    downloadCsv(
      `explore-range-${csvStamp(fromDate)}-${csvStamp(toDate)}`,
      ['Channel', 'Platform', 'Category', 'Language', 'Peak CCV', 'Avg CCV', 'Viewed Hours'],
      sortable.sorted.map((c) => [
        c.displayName,
        c.platform,
        c.tier,
        c.language,
        c.peakCCV,
        c.avgCCV,
        c.viewedHours,
      ]),
    );

  return (
    <div className="card" style={{ padding: 14 }}>
      <Row justify="space-between" align="center" style={{ marginBottom: 10 }}>
        <Col gap={2}>
          <span className="eyebrow" style={{ fontSize: 10 }}>
            All channels in window · {durLabel}
          </span>
          <span className="tabular" style={{ fontSize: 13, fontWeight: 600 }}>
            {formatChartTimeInTz(fromDate, timezone, true) || from}
            {' → '}
            {formatChartTimeInTz(toDate, timezone, true) || to}
          </span>
        </Col>
        <Row gap={6}>
          <button type="button" className="btn btn-xs" onClick={exportRangeCsv} title="Download this window's channel stats as CSV">
            CSV
          </button>
          <button
            type="button"
            className="btn btn-xs"
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid var(--border)' }}
          >
            Close
          </button>
        </Row>
      </Row>

      {/* Share of viewed hours in this window, by platform / language */}
      {sumHours > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 14,
            marginBottom: 12,
          }}
        >
          {[
            { title: 'By platform', rows: platformShares },
            { title: 'By language', rows: languageShares },
          ].map((grp) => (
            <div key={grp.title}>
              <div className="eyebrow" style={{ fontSize: 9.5, marginBottom: 5 }}>
                {grp.title} · share of viewed hours
              </div>
              <Col gap={4}>
                {grp.rows.map((r) => (
                  <Row key={r.label} gap={8} align="center">
                    <span
                      style={{
                        width: 64,
                        fontSize: 10.5,
                        color: 'var(--fg-muted)',
                        textTransform: 'uppercase',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.label}
                    >
                      {r.label}
                    </span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.round(r.share * 100)}%`, height: '100%', background: 'var(--red)' }} />
                    </div>
                    <span className="tabular" style={{ fontSize: 10.5, color: 'var(--fg-dim)', width: 74, textAlign: 'right' }}>
                      {(r.share * 100).toFixed(0)}% · {fmtCompact(r.hours)}h
                    </span>
                  </Row>
                ))}
              </Col>
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          padding: '6px 0',
          fontSize: 10,
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="displayName">
          Channel
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="platform">
          Platform
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="tier">
          Category
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="language">
          Lang
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="peakCCV" align="right">
          Peak
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="avgCCV" align="right">
          Avg
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="viewedHours" align="right">
          Viewed Hours
        </SortHeader>
      </div>
      <div style={expanded ? undefined : { maxHeight: 360, overflowY: 'auto' }}>
        {sortable.sorted.length === 0 ? (
          <div className="placeholder" style={{ height: 60, marginTop: 8 }}>
            No channel had data in this window.
          </div>
        ) : (
          sortable.sorted.map((c) => (
            <div
              key={c.channelId}
              style={{
                display: 'grid',
                gridTemplateColumns: COLS,
                padding: '6px 0',
                fontSize: 12,
                borderBottom: '1px solid var(--border-faint)',
                alignItems: 'center',
              }}
            >
              <Row gap={8} align="center" style={{ minWidth: 0 }}>
                <PlatformPip id={c.platform} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.displayName}
                </span>
              </Row>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{c.platform}</span>
              <span><TierBadge tier={c.tier} /></span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                {c.language ?? '—'}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtN(c.peakCCV ?? 0)}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtN(c.avgCCV ?? 0)}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtN(Math.round(c.viewedHours ?? 0))}
              </span>
            </div>
          ))
        )}
      </div>
      {sortable.sorted.length > 0 && (
        <>
          {/* Totals row — only viewed-hours sums meaningfully. The table-level
              peak / avg are intentionally NOT summed here (peaks happen at
              different moments; sum-of-peaks is meaningless). The page-level
              footer above the chart shows the time-aware combined peak/avg. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: COLS,
              padding: '10px 0',
              fontSize: 12,
              borderTop: '2px solid var(--border)',
              fontWeight: 600,
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>
              {sortable.sorted.length} channel{sortable.sorted.length === 1 ? '' : 's'}
              {top.name ? ` · top: ${fmtN(top.peak)} (${top.name})` : ''}
            </div>
            <div />
            <div />
            <div />
            <div />
            <div />
            <div className="tabular" style={{ textAlign: 'right' }} title="Sum of viewed-hours across all channels in this window">
              {fmtN(Math.round(sumHours))}
            </div>
          </div>
          <Row justify="flex-end" align="center" style={{ marginTop: 4 }}>
            {sortable.sorted.length > 10 && (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => setExpanded((v) => !v)}
                style={{ background: 'transparent', border: '1px solid var(--border)' }}
              >
                {expanded ? 'Collapse' : `Expand (showing top 10 of ${sortable.sorted.length})`}
              </button>
            )}
          </Row>
        </>
      )}
    </div>
  );
}
