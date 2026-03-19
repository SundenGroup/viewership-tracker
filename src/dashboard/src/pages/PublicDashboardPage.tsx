import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  TotalCCVPanel,
  PlatformBreakdownPanel,
  ChannelLeaderboardPanel,
  TimeSeriesPanel,
  LanguageDistPanel,
  RegionDistPanel,
  SummaryBarPanel,
  ScopeSelectorBar,
  ViewGroupFilter,
} from '@/components/panels';
import { PublicLayout } from '@/components/layout/PublicLayout';
import { Spinner } from '@/components/common/Loader';
import { usePublicPollingData } from '@/hooks/usePublicPollingData';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import type { PublicSeriesInfo } from '@/services/api';
import type { ScopeLevel, MetricsResponse, LiveCCVResponse, ViewGroup } from '@/types/api';
import type { ConnectionStatus } from '@/hooks/useWebSocket';

export function PublicDashboardPage() {
  const { shortName } = useParams<{ shortName: string }>();

  // ── Fetch series info ──────────────────────────────────────────────────

  const [seriesInfo, setSeriesInfo] = useState<PublicSeriesInfo | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    if (!shortName) return;
    setSeriesLoading(true);
    setSeriesError(null);
    api
      .getPublicSeries(shortName)
      .then((info) => {
        setSeriesInfo(info);
        setSeriesLoading(false);
      })
      .catch((err) => {
        setSeriesError(err instanceof Error ? err.message : 'Failed to load series');
        setSeriesLoading(false);
      });
  }, [shortName]);

  const seriesId = seriesInfo?.id;

  // ── Track public dashboard view ──────────────────────────────────────
  useEffect(() => {
    if (seriesInfo && shortName) {
      window.umami?.track('public-dashboard-view', {
        series: seriesInfo.name,
        shortName,
      });
    }
  }, [seriesInfo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live data via WS + REST polling ────────────────────────────────────

  const pollingData = usePublicPollingData(shortName, seriesId);

  // ── Scope state (initialized from URL params for shareable links) ────

  const [searchParams, setSearchParams] = useSearchParams();
  const urlScope = searchParams.get('scope') as ScopeLevel | null;
  const urlId = searchParams.get('id') || '';

  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(urlScope ?? 'series');
  const [scopeDayId, setScopeDayId] = useState(urlScope === 'day' ? urlId : '');
  const [scopeStageId, setScopeStageId] = useState(urlScope === 'stage' ? urlId : '');

  // ── View Group filter state (from URL for shareable links) ──────────
  const urlGroup = searchParams.get('group');
  const [activeGroupName, setActiveGroupName] = useState<string | null>(urlGroup);

  const viewGroups = useMemo<ViewGroup[]>(() => {
    return (seriesInfo?.viewGroups as ViewGroup[]) ?? [];
  }, [seriesInfo]);

  const activeGroup = useMemo(() => {
    return viewGroups.find((g) => g.name === activeGroupName) ?? null;
  }, [viewGroups, activeGroupName]);

  const filterLanguages = activeGroup?.languages;
  const filterPlatforms = activeGroup?.platforms;
  const filterKey = activeGroupName ?? '';

  const hasMultipleStages = (seriesInfo?.stages.length ?? 0) >= 2;

  const allBroadcastDays = useMemo(() => {
    if (!seriesInfo) return [];
    return seriesInfo.stages.flatMap((s) => s.broadcast_days);
  }, [seriesInfo]);

  const dashboardScope = useMemo((): { level: ScopeLevel; id: string; label: string } | null => {
    if (!seriesId || !seriesInfo) return null;

    if (scopeLevel === 'series') {
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    if (scopeLevel === 'stage') {
      const stage = seriesInfo.stages.find((s) => s.id === scopeStageId);
      if (stage) return { level: 'stage', id: stage.id, label: stage.name };
      const first = seriesInfo.stages[0];
      if (first) return { level: 'stage', id: first.id, label: first.name };
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    if (scopeLevel === 'day') {
      const day = allBroadcastDays.find((d) => d.id === scopeDayId);
      if (day) return { level: 'day', id: day.id, label: day.label };
      const active = allBroadcastDays.find((d) => d.status === 'live')
        ?? allBroadcastDays[allBroadcastDays.length - 1];
      if (active) return { level: 'day', id: active.id, label: active.label };
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    return { level: 'series', id: seriesId, label: 'Full Series' };
  }, [scopeLevel, scopeStageId, scopeDayId, seriesId, seriesInfo, allBroadcastDays]);

  // ── Sync URL to reflect resolved scope + group ──────────────────────
  useEffect(() => {
    if (!dashboardScope) return;
    const params: Record<string, string> = {};
    if (dashboardScope.level !== 'series') {
      params.scope = dashboardScope.level;
      params.id = dashboardScope.id;
    }
    if (activeGroupName) {
      params.group = activeGroupName;
    }
    setSearchParams(params, { replace: true });
  }, [dashboardScope?.level, dashboardScope?.id, activeGroupName, setSearchParams]);

  // ── Scoped metrics (when scope ≠ series OR view group active) ──────────

  const scopeKey = dashboardScope ? `${dashboardScope.level}:${dashboardScope.id}` : '';

  const needsScopedFetch = !!dashboardScope && (
    dashboardScope.level !== 'series' || !!activeGroup
  );

  const { data: scopedMetrics, loading: scopedMetricsLoading } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && shortName && dashboardScope
        ? api.getPublicMetrics(shortName, dashboardScope.level, dashboardScope.id, filterLanguages, filterPlatforms)
        : Promise.resolve(null as unknown as MetricsResponse),
    [scopeKey, shortName, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!shortName },
  );

  // ── Scoped live CCV (when scope ≠ series OR view group active) ─────
  const { data: scopedLiveCCV, loading: scopedLiveCCVLoading } = usePollingApi<LiveCCVResponse>(
    () =>
      shortName && needsScopedFetch && dashboardScope
        ? api.getPublicLiveCCV(shortName, dashboardScope.level, dashboardScope.id, filterLanguages, filterPlatforms)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [scopeKey, shortName, filterKey],
    { intervalMs: 30_000, enabled: !!shortName && needsScopedFetch },
  );

  const activeMetrics = needsScopedFetch && scopedMetrics
    ? scopedMetrics
    : pollingData.metrics;
  const activeMetricsLoading = needsScopedFetch
    ? scopedMetricsLoading
    : pollingData.metricsLoading;

  const activeLiveCCV = needsScopedFetch && scopedLiveCCV
    ? scopedLiveCCV
    : pollingData.liveCCV;
  const activeLiveCCVLoading = needsScopedFetch
    ? scopedLiveCCVLoading
    : pollingData.liveCCVLoading;

  // ── Earliest live broadcast start ──────────────────────────────────────

  const broadcastStart = useMemo(() => {
    if (!seriesInfo) return null;
    for (const stage of seriesInfo.stages) {
      for (const day of stage.broadcast_days) {
        if (day.status === 'live' && day.broadcast_start) {
          return day.broadcast_start;
        }
      }
    }
    return null;
  }, [seriesInfo]);

  // ── Loading / Error states ─────────────────────────────────────────────

  if (seriesLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <Spinner size="lg" />
      </div>
    );
  }

  if (seriesError || !seriesInfo || !shortName) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-300">Series not found</h1>
          <p className="mt-2 text-sm text-gray-500">
            {seriesError ?? 'This series does not exist or is not publicly available.'}
          </p>
        </div>
      </div>
    );
  }

  const resolvedScope = dashboardScope ?? { level: 'series' as ScopeLevel, id: seriesId!, label: 'Full Series' };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <PublicLayout seriesName={seriesInfo.name} wsStatus={pollingData.wsStatus as ConnectionStatus}>
      <div className="space-y-6">
        {/* Summary bar */}
        <SummaryBarPanel
          metrics={activeMetrics}
          liveCCV={activeLiveCCV}
          broadcastStart={broadcastStart}
          loading={activeMetricsLoading}
        />

        {/* Scope selector + View Group filter */}
        <div className="flex flex-wrap items-center gap-3">
          <ScopeSelectorBar
            scopeLevel={scopeLevel}
            onScopeLevelChange={setScopeLevel}
            selectedDayId={scopeDayId}
            onDayIdChange={setScopeDayId}
            selectedStageId={scopeStageId}
            onStageIdChange={setScopeStageId}
            stages={seriesInfo.stages as any}
            hasMultipleStages={hasMultipleStages}
            activeLabel={resolvedScope.label}
          />
          {viewGroups.length > 0 && (
            <ViewGroupFilter
              groups={viewGroups}
              active={activeGroupName}
              onChange={setActiveGroupName}
            />
          )}
        </div>

        {/* Total CCV + Platform Breakdown */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <TotalCCVPanel
            data={activeLiveCCV}
            loading={activeLiveCCVLoading}
          />
          <PlatformBreakdownPanel
            liveCCV={activeLiveCCV}
            metrics={activeMetrics}
            scopeLevel={resolvedScope.level}
            loading={activeMetricsLoading}
          />
        </div>

        {/* Time-series chart */}
        <TimeSeriesPanel
          seriesId={seriesId!}
          scope={{ level: resolvedScope.level, id: resolvedScope.id }}
          publicShortName={shortName}
          broadcastDays={allBroadcastDays}
          languages={filterLanguages}
          platforms={filterPlatforms}
        />

        {/* Channel Leaderboard + Language/Region */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <ChannelLeaderboardPanel
            seriesId={seriesId!}
            liveCCV={activeLiveCCV}
            loading={activeLiveCCVLoading}
            scope={{ level: resolvedScope.level, id: resolvedScope.id }}
            publicShortName={shortName}
            languages={filterLanguages}
            platforms={filterPlatforms}
          />
          <div className="space-y-6">
            <LanguageDistPanel
              data={activeMetrics?.languageBreakdown ?? []}
              loading={activeMetricsLoading}
              liveCCV={activeLiveCCV}
            />
            <RegionDistPanel
              data={activeMetrics?.regionBreakdown ?? []}
              loading={activeMetricsLoading}
              liveCCV={activeLiveCCV}
            />
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
