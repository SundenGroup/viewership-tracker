import { Card } from '@/components/common';
import { formatNumber, formatCompact, formatHours, formatDateTime } from '@/utils/formatters';
import type { MetricsResponse, LiveCCVResponse } from '@/types/api';

interface SummaryBarPanelProps {
  metrics: MetricsResponse | null;
  liveCCV: LiveCCVResponse | null;
  broadcastStart?: string | null;
  loading: boolean;
}

export function SummaryBarPanel({
  metrics,
  liveCCV,
  broadcastStart,
  loading,
}: SummaryBarPanelProps) {
  // Stream duration from broadcast start until now
  let streamDuration = '—';
  if (broadcastStart) {
    const diffMs = Date.now() - new Date(broadcastStart).getTime();
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3_600_000);
      const mins = Math.floor((diffMs % 3_600_000) / 60_000);
      streamDuration = `${hours}h ${mins}m`;
    }
  }

  const stats = [
    {
      label: 'Peak CCV',
      value: metrics?.peakCCV ? formatCompact(metrics.peakCCV.totalCCV) : '—',
      detail: metrics?.peakCCV ? formatDateTime(metrics.peakCCV.timestamp) : undefined,
      color: 'text-accent-cyan',
    },
    {
      label: 'Avg CCV',
      value: metrics ? formatCompact(metrics.avgCCV) : '—',
      color: 'text-clutch-red',
    },
    {
      label: 'Total Viewed Hours',
      value: metrics ? formatHours(metrics.totalViewedHours) : '—',
      color: 'text-accent-purple',
    },
    {
      label: 'Active Channels',
      value: liveCCV ? formatNumber(liveCCV.channelCount) : '—',
      color: 'text-accent-green',
    },
    {
      label: 'Stream Duration',
      value: streamDuration,
      color: 'text-accent-orange',
    },
  ];

  return (
    <Card noPadding>
      <div className="flex flex-wrap divide-navy-700/50 sm:divide-x">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-1 flex-col items-center px-3 py-2.5 min-w-[calc(50%-1px)] sm:min-w-[120px] sm:px-4 sm:py-3 border-b border-navy-700/50 sm:border-b-0 last:border-b-0"
          >
            <span className={`text-xl font-bold font-mono ${stat.color} ${loading && !metrics ? 'animate-pulse' : ''}`}>
              {stat.value}
            </span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">
              {stat.label}
            </span>
            {stat.detail && (
              <span className="text-[9px] text-gray-600">{stat.detail}</span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
