import { useMemo } from 'react';
import {
  TotalCCVPanel,
  PlatformBreakdownPanel,
  ChannelLeaderboardPanel,
  TimeSeriesPanel,
  LanguageDistPanel,
  RegionDistPanel,
  DiscoveryFeedPanel,
  SummaryBarPanel,
  ScopeSelectorBar,
  ExportPanel,
  ChannelListPanel,
} from '@/components/panels';
import { useAuth } from '@/hooks/useAuth';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import type { SeriesWithStages, ScopeLevel, MetricsResponse } from '@/types/api';
import type { PollingDataState } from '@/hooks/usePollingData';

interface DashboardPageProps {
  seriesId: string | undefined;
  seriesDetail: SeriesWithStages | null;
  pollingData: PollingDataState;
  broadcastStart: string | null;
  channelRefreshKey?: number;
}

export function DashboardPage({
  seriesId,
  seriesDetail,
  pollingData,
  broadcastStart,
  channelRefreshKey = 0,
}: DashboardPageProps) {
  const { hasRole } = useAuth();
  const canManage = hasRole('editor');

  // ── Scope state (persisted) ───────────────────────────────────────────
  const [scopeLevel, setScopeLevel] = useLocalStorage<ScopeLevel>('cvt:dashboardScope', 'series');
  const [scopeDayId, setScopeDayId] = useLocalStorage<string>('cvt:dashboardScopeDay', '');
  const [scopeStageId, setScopeStageId] = useLocalStorage<string>('cvt:dashboardScopeStage', '');

  const hasMultipleStages = (seriesDetail?.stages.length ?? 0) >= 2;

  // Flatten all broadcast days from series detail
  const allBroadcastDays = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.flatMap((s) => s.broadcast_days);
  }, [seriesDetail]);

  // Derive resolved scope
  const dashboardScope = useMemo((): { level: ScopeLevel; id: string; label: string } | null => {
    if (!seriesId || !seriesDetail) return null;

    if (scopeLevel === 'series') {
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    if (scopeLevel === 'stage') {
      const stage = seriesDetail.stages.find((s) => s.id === scopeStageId);
      if (stage) return { level: 'stage', id: stage.id, label: stage.name };
      // Fallback: first stage
      const first = seriesDetail.stages[0];
      if (first) return { level: 'stage', id: first.id, label: first.name };
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    if (scopeLevel === 'day') {
      const day = allBroadcastDays.find((d) => d.id === scopeDayId);
      if (day) return { level: 'day', id: day.id, label: day.label };
      // Fallback: active day or most recent
      const active = allBroadcastDays.find((d) => d.status === 'live')
        ?? allBroadcastDays[allBroadcastDays.length - 1];
      if (active) return { level: 'day', id: active.id, label: active.label };
      return { level: 'series', id: seriesId, label: 'Full Series' };
    }

    return { level: 'series', id: seriesId, label: 'Full Series' };
  }, [scopeLevel, scopeStageId, scopeDayId, seriesId, seriesDetail, allBroadcastDays]);

  // ── Scoped metrics fetch (only when scope ≠ series) ───────────────────

  const scopeKey = dashboardScope ? `${dashboardScope.level}:${dashboardScope.id}` : '';

  const { data: scopedMetrics, loading: scopedMetricsLoading } = usePollingApi<MetricsResponse>(
    () =>
      dashboardScope && dashboardScope.level !== 'series'
        ? api.getMetrics(dashboardScope.level, dashboardScope.id)
        : Promise.resolve(null as unknown as MetricsResponse),
    [scopeKey],
    { intervalMs: 30_000, enabled: !!dashboardScope && dashboardScope.level !== 'series' },
  );

  // Use scoped metrics when available, otherwise series-level from pollingData
  const activeMetrics = dashboardScope?.level !== 'series' && scopedMetrics
    ? scopedMetrics
    : pollingData.metrics;
  const activeMetricsLoading = dashboardScope?.level !== 'series'
    ? scopedMetricsLoading
    : pollingData.metricsLoading;

  // ── Render ────────────────────────────────────────────────────────────

  if (!seriesId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-navy-800">
            <svg className="h-8 w-8 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-300">
            Select a tournament series
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Choose a series from the dropdown above to view its live viewership data.
          </p>
        </div>
      </div>
    );
  }

  const resolvedScope = dashboardScope ?? { level: 'series' as ScopeLevel, id: seriesId, label: 'Full Series' };

  return (
    <div className="space-y-6">
      {/* Row 0: Summary bar — full width */}
      <SummaryBarPanel
        metrics={activeMetrics}
        liveCCV={pollingData.liveCCV}
        broadcastStart={broadcastStart}
        loading={activeMetricsLoading}
      />

      {/* Scope selector */}
      <ScopeSelectorBar
        scopeLevel={scopeLevel}
        onScopeLevelChange={setScopeLevel}
        selectedDayId={scopeDayId}
        onDayIdChange={setScopeDayId}
        selectedStageId={scopeStageId}
        onStageIdChange={setScopeStageId}
        stages={seriesDetail?.stages ?? []}
        hasMultipleStages={hasMultipleStages}
        activeLabel={resolvedScope.label}
      />

      {/* Row 1: Total CCV + Platform Breakdown — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TotalCCVPanel
          data={pollingData.liveCCV}
          loading={pollingData.liveCCVLoading}
        />
        <PlatformBreakdownPanel
          liveCCV={pollingData.liveCCV}
          metrics={activeMetrics}
          scopeLevel={resolvedScope.level}
          loading={activeMetricsLoading}
        />
      </div>

      {/* Row 2: Time-series chart — full width */}
      <TimeSeriesPanel
        seriesId={seriesId}
        scope={{ level: resolvedScope.level, id: resolvedScope.id }}
        broadcastDays={allBroadcastDays}
      />

      {/* Row 3: Channel Leaderboard + Language/Region — side by side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChannelLeaderboardPanel
          seriesId={seriesId}
          liveCCV={pollingData.liveCCV}
          loading={pollingData.liveCCVLoading}
          scope={{ level: resolvedScope.level, id: resolvedScope.id }}
        />
        <div className="space-y-6">
          <LanguageDistPanel
            data={activeMetrics?.languageBreakdown ?? []}
            loading={activeMetricsLoading}
          />
          <RegionDistPanel
            data={activeMetrics?.regionBreakdown ?? []}
            loading={activeMetricsLoading}
          />
        </div>
      </div>

      {/* Row 4: All Channels — editor+ only */}
      {canManage && (
        <ChannelListPanel seriesId={seriesId} broadcastDays={allBroadcastDays} refreshKey={channelRefreshKey} />
      )}

      {/* Row 5: Discovery Feed — editor+ only */}
      {canManage && (
        <DiscoveryFeedPanel
          seriesId={seriesId}
          lastDiscoveryResult={pollingData.lastDiscoveryResult}
          defaultTier={seriesDetail?.discovery_default_tier}
        />
      )}

      {/* Row 6: Export — editor+ only */}
      {canManage && (
        <ExportPanel
          seriesId={seriesId}
          seriesDetail={seriesDetail}
        />
      )}
    </div>
  );
}
