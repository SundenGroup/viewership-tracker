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
  ThemeToggle,
  useSortable,
  SortHeader,
  IconChev,
  IconMore,
  IconUsers,
  IconSearch,
  InteractiveMainChart,
  LineChart,
} from '@/components/design';
import type { SeriesData } from '@/components/design';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import type { ScopeOption } from '@/components/design/ScopeScrubber';
import { fmtCompact, fmtDateMD, fmtDateLong } from '@/design/format';
import { formatChartTimeInTz } from '@/utils/formatters';
import { useAuth } from '@/hooks/useAuth';
import { useApi, usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
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

const MAX_OVERLAY_CHANNELS = 4;

// Distinct line colours for overlay mode (max 4)
const OVERLAY_COLORS = [
  'var(--red)',
  'var(--info)',
  'var(--warn)',
  'var(--live)',
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

  const lb = useSortable(channels, 'peak', 'desc');

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
      else return;
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
        {/* Scope scrubber */}
        <div className="card" style={{ padding: '10px 14px' }}>
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
            showShowingLabel={true}
          />
        </div>

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
                  {channels.length} channel{channels.length === 1 ? '' : 's'}
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
              </Col>
              <Row gap={6} style={{ alignItems: 'center' }}>
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
                )}
                {availableLanguages.length > 0 && (
                  <FilterChipRow label="Language">
                    {availableLanguages.map((lang) => (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => toggleLanguage(lang)}
                        style={chipStyle(languageFilter.includes(lang))}
                      >
                        {lang.toUpperCase()}
                      </button>
                    ))}
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
              gridTemplateColumns: '40px 1fr 100px 110px 90px 100px 100px 110px',
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
          </div>
          <div style={{ maxHeight: 480, overflowY: 'auto' }}>
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
                      gridTemplateColumns: '40px 1fr 100px 110px 90px 100px 100px 110px',
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
                      {fmtCompact(c.peak)}
                    </div>
                    <div className="tabular" style={{ textAlign: 'right' }}>
                      {fmtCompact(c.avg)}
                    </div>
                    <div className="tabular" style={{ textAlign: 'right' }}>
                      {fmtCompact(c.hours)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Col>
    </ExploreShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function ExploreShell({
  title,
  subtitle,
  seriesPicker,
  logout,
  children,
}: {
  title: string;
  subtitle?: string;
  seriesPicker?: React.ReactNode;
  logout?: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--fg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top bar */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 22px',
        }}
      >
        <Row justify="space-between" align="center" style={{ gap: 12 }}>
          <Row gap={10} align="center">
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                color: 'inherit',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Back to series list"
            >
              <ClutchWordmark size={16} />
            </button>
            <span
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                letterSpacing: 1.2,
                fontFamily: 'var(--font-mono)',
                padding: '2px 8px',
                borderLeft: '1px solid var(--border)',
              }}
            >
              EXPLORE
            </span>
            {seriesPicker}
          </Row>
          <Row gap={8} align="center">
            <ThemeToggle />
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn"
                onClick={() => setMenuOpen((o) => !o)}
                style={{ padding: '6px 8px' }}
                title="Account menu"
              >
                <IconMore size={14} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 6px)',
                    minWidth: 200,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    padding: 4,
                    zIndex: 20,
                  }}
                >
                  <ExploreMenuItem onClick={() => { setMenuOpen(false); navigate('/'); }}>
                    Series list
                  </ExploreMenuItem>
                  {isAdmin && (
                    <>
                      <ExploreMenuItem
                        icon={<IconUsers size={13} />}
                        onClick={() => { setMenuOpen(false); navigate('/users'); }}
                      >
                        Users
                      </ExploreMenuItem>
                      <ExploreMenuItem onClick={() => { setMenuOpen(false); navigate('/settings/youtube-keys'); }}>
                        YouTube API keys
                      </ExploreMenuItem>
                    </>
                  )}
                  {logout && (
                    <>
                      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                      <ExploreMenuItem onClick={() => { setMenuOpen(false); void logout(); }}>
                        Sign out
                      </ExploreMenuItem>
                    </>
                  )}
                </div>
              )}
            </div>
          </Row>
        </Row>
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>
            {title}
          </h1>
          {subtitle && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{subtitle}</span>
          )}
        </div>
      </header>

      <div
        style={{
          flex: 1,
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
  const d = new Date(timestamp);
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
        <button
          type="button"
          className="btn btn-xs"
          onClick={onClose}
          style={{ background: 'transparent', border: '1px solid var(--border)' }}
        >
          Close
        </button>
      </Row>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 90px 70px 90px',
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
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="language">
          Lang
        </SortHeader>
        <SortHeader sort={sortable.sort as string} dir={sortable.dir} onClick={sortable.toggle as (k: string) => void} id="ccv" align="right">
          CCV
        </SortHeader>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
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
                gridTemplateColumns: '1fr 90px 70px 90px',
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
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                {c.language ?? '—'}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtCompact(c.ccv)}
              </span>
            </div>
          ))
        )}
      </div>
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
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const durMs = toDate.getTime() - fromDate.getTime();
  const durMin = Math.round(durMs / 60_000);
  const durLabel =
    durMin >= 60
      ? `${Math.floor(durMin / 60)}h ${durMin % 60}m`
      : `${durMin} min`;
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
        <button
          type="button"
          className="btn btn-xs"
          onClick={onClose}
          style={{ background: 'transparent', border: '1px solid var(--border)' }}
        >
          Close
        </button>
      </Row>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 90px 70px 80px 80px 90px',
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
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
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
                gridTemplateColumns: '1fr 90px 70px 80px 80px 90px',
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
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                {c.language ?? '—'}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtCompact(c.peakCCV ?? 0)}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtCompact(c.avgCCV ?? 0)}
              </span>
              <span className="tabular" style={{ textAlign: 'right' }}>
                {fmtCompact(c.viewedHours ?? 0)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
