import { Card, PlatformBadge, LoadingOverlay } from '@/components/common';
import { LeaderboardBarChart } from '@/components/charts';
import { formatNumber, formatHours } from '@/utils/formatters';
import type { MetricsResponse } from '@/types/api';

interface LeaderboardPanelProps {
  metrics: MetricsResponse | null;
  loading: boolean;
}

export function LeaderboardPanel({ metrics, loading }: LeaderboardPanelProps) {
  if (loading && !metrics) {
    return <Card title="Channel Leaderboard"><LoadingOverlay /></Card>;
  }

  if (!metrics || metrics.channelLeaderboard.length === 0) {
    return (
      <Card title="Channel Leaderboard">
        <p className="text-sm text-gray-500">No leaderboard data available.</p>
      </Card>
    );
  }

  const top10 = metrics.channelLeaderboard.slice(0, 10);

  return (
    <Card title="Channel Leaderboard" subtitle={`Top ${top10.length} channels by peak CCV`}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Chart */}
        <LeaderboardBarChart data={top10} height={280} />

        {/* Table */}
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700/50 text-xs text-gray-500">
                <th className="pb-2 text-left font-medium">#</th>
                <th className="pb-2 text-left font-medium">Channel</th>
                <th className="pb-2 text-right font-medium">Peak</th>
                <th className="pb-2 text-right font-medium">Avg</th>
                <th className="pb-2 text-right font-medium">Hours</th>
              </tr>
            </thead>
            <tbody>
              {top10.map((entry, i) => (
                <tr
                  key={entry.channelId}
                  className="border-b border-navy-700/30 last:border-0"
                >
                  <td className="py-1.5 text-gray-500">{i + 1}</td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-200">{entry.displayName}</span>
                      <PlatformBadge platform={entry.platform} />
                    </div>
                  </td>
                  <td className="py-1.5 text-right font-mono text-gray-200">
                    {formatNumber(entry.peakCCV)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-gray-400">
                    {formatNumber(entry.avgCCV)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-gray-400">
                    {formatHours(entry.totalViewedMinutes / 60)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
