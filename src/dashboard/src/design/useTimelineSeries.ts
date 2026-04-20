import { useMemo } from 'react';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import type { GroupedTimeSeriesBucket, ScopeLevel, TimeSeriesBucket, TimeSeriesResponse } from '@/types/api';
import { buildChartSeries } from './useDashboardModel';
import type { SeriesData } from '@/components/design';

/**
 * Fetches the four time-series views (total / platform / region / language)
 * for the given scope and returns series ready to feed InteractiveMainChart.
 */
export function useTimelineSeries({
  scope,
  interval = 60,
  refreshMs = 30_000,
  languages,
  platforms,
}: {
  scope: { level: ScopeLevel; id: string } | null;
  interval?: 60 | 300 | 600;
  refreshMs?: number;
  languages?: string[];
  platforms?: string[];
}): {
  platform: SeriesData[];
  region: SeriesData[];
  language: SeriesData[];
  total: number[];
  timestamps: string[];
  loading: boolean;
} {
  const enabled = !!scope;

  const qs = scope ? `${scope.level}:${scope.id}:${interval}` : '';

  const { data: totalData, loading: totalLoading } = usePollingApi<TimeSeriesResponse>(
    () =>
      scope
        ? api.getTimeSeries({ scope: scope.level, id: scope.id, interval, groupBy: 'total', languages, platforms })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [qs, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: platformData } = usePollingApi<TimeSeriesResponse>(
    () =>
      scope
        ? api.getTimeSeries({ scope: scope.level, id: scope.id, interval, groupBy: 'platform', languages, platforms })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [qs, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: regionData } = usePollingApi<TimeSeriesResponse>(
    () =>
      scope
        ? api.getTimeSeries({ scope: scope.level, id: scope.id, interval, groupBy: 'region', languages, platforms })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [qs, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: languageData } = usePollingApi<TimeSeriesResponse>(
    () =>
      scope
        ? api.getTimeSeries({ scope: scope.level, id: scope.id, interval, groupBy: 'language', languages, platforms })
        : Promise.resolve(null as unknown as TimeSeriesResponse),
    [qs, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  return useMemo(() => {
    const total = ((totalData?.data ?? []) as TimeSeriesBucket[]).map((b) => ({
      timestamp: b.timestamp ?? b.bucket ?? '',
      totalCCV: Number(b.totalCCV ?? b.total_ccv ?? 0),
    }));
    const pickGrouped = (resp: TimeSeriesResponse | null) =>
      ((resp?.data ?? []) as GroupedTimeSeriesBucket[]).map((b) => ({
        timestamp: b.timestamp ?? b.bucket ?? '',
        groupKey: b.groupKey,
        totalCCV: Number(b.totalCCV ?? b.total_ccv ?? 0),
      }));

    const built = buildChartSeries({
      totalBuckets: total,
      platformBuckets: pickGrouped(platformData),
      regionBuckets: pickGrouped(regionData),
      languageBuckets: pickGrouped(languageData),
    });

    return {
      ...built,
      loading: totalLoading,
    };
  }, [totalData, platformData, regionData, languageData, totalLoading]);
}
