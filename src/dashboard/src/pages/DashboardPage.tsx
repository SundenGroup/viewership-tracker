import {
  TotalCCVPanel,
  PlatformBreakdownPanel,
  ChannelLeaderboardPanel,
  TimeSeriesPanel,
  LanguageDistPanel,
  RegionDistPanel,
  DiscoveryFeedPanel,
  SummaryBarPanel,
  ExportPanel,
  ChannelListPanel,
} from '@/components/panels';
import { useAuth } from '@/hooks/useAuth';
import type { SeriesWithStages } from '@/types/api';
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
  const canExport = hasRole('editor');

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

  return (
    <div className="space-y-6">
      {/* Row 0: Summary bar — full width */}
      <SummaryBarPanel
        metrics={pollingData.metrics}
        liveCCV={pollingData.liveCCV}
        broadcastStart={broadcastStart}
        loading={pollingData.metricsLoading}
      />

      {/* Row 1: Total CCV + Platform Breakdown — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TotalCCVPanel
          data={pollingData.liveCCV}
          loading={pollingData.liveCCVLoading}
        />
        <PlatformBreakdownPanel
          liveCCV={pollingData.liveCCV}
          loading={pollingData.liveCCVLoading}
        />
      </div>

      {/* Row 2: Time-series chart — full width */}
      <TimeSeriesPanel seriesId={seriesId} />

      {/* Row 3: Channel Leaderboard + Language/Region — side by side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChannelLeaderboardPanel
          liveCCV={pollingData.liveCCV}
          loading={pollingData.liveCCVLoading}
        />
        <div className="space-y-6">
          <LanguageDistPanel
            data={pollingData.metrics?.languageBreakdown ?? []}
            loading={pollingData.metricsLoading}
          />
          <RegionDistPanel
            data={pollingData.metrics?.regionBreakdown ?? []}
            loading={pollingData.metricsLoading}
          />
        </div>
      </div>

      {/* Row 4: All Channels — full width */}
      <ChannelListPanel seriesId={seriesId} refreshKey={channelRefreshKey} />

      {/* Row 5: Discovery Feed — full width */}
      <DiscoveryFeedPanel
        seriesId={seriesId}
        lastDiscoveryResult={pollingData.lastDiscoveryResult}
      />

      {/* Row 6: Export — editor+ only */}
      {canExport && (
        <ExportPanel
          seriesId={seriesId}
          seriesDetail={seriesDetail}
        />
      )}
    </div>
  );
}
