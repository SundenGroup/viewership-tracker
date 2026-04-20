import { useMemo } from 'react';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import type {
  GroupedTimeSeriesBucket,
  ScopeLevel,
  TimeSeriesBucket,
  TimeSeriesGroupBy,
  TimeSeriesResponse,
} from '@/types/api';
import { buildChartSeries } from './useDashboardModel';
import type { SeriesData } from '@/components/design';

/**
 * Fetches the four time-series views (total / platform / region / language)
 * for the given scope and returns series ready to feed InteractiveMainChart.
 *
 * Pass `publicShortName` to route through the `/api/public/...` endpoints
 * for unauthenticated public pages.
 */
export function useTimelineSeries({
  scope,
  interval = 60,
  refreshMs = 30_000,
  languages,
  platforms,
  publicShortName,
}: {
  scope: { level: ScopeLevel; id: string } | null;
  interval?: 60 | 300 | 600;
  refreshMs?: number;
  languages?: string[];
  platforms?: string[];
  publicShortName?: string;
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

  const fetchFor = (groupBy: TimeSeriesGroupBy): Promise<TimeSeriesResponse> => {
    if (!scope) return Promise.resolve(null as unknown as TimeSeriesResponse);
    if (publicShortName) {
      return api.getPublicTimeSeries(publicShortName, {
        scope: scope.level,
        id: scope.id,
        interval,
        groupBy,
        languages,
        platforms,
      });
    }
    return api.getTimeSeries({
      scope: scope.level,
      id: scope.id,
      interval,
      groupBy,
      languages,
      platforms,
    });
  };

  const { data: totalData, loading: totalLoading } = usePollingApi<TimeSeriesResponse>(
    () => fetchFor('total'),
    [qs, publicShortName, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: platformData } = usePollingApi<TimeSeriesResponse>(
    () => fetchFor('platform'),
    [qs, publicShortName, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: regionData } = usePollingApi<TimeSeriesResponse>(
    () => fetchFor('region'),
    [qs, publicShortName, languages?.join(','), platforms?.join(',')],
    { intervalMs: refreshMs, enabled },
  );

  const { data: languageData } = usePollingApi<TimeSeriesResponse>(
    () => fetchFor('language'),
    [qs, publicShortName, languages?.join(','), platforms?.join(',')],
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
