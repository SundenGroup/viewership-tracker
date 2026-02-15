import { Card, LoadingOverlay } from '@/components/common';
import { formatNumber, formatCompact, formatHours, formatDateTime } from '@/utils/formatters';
import type { MetricsResponse } from '@/types/api';

interface MetricsPanelProps {
  data: MetricsResponse | null;
  loading: boolean;
  error: string | null;
}

export function MetricsPanel({ data, loading, error }: MetricsPanelProps) {
  if (loading && !data) return <Card title="Metrics Overview"><LoadingOverlay /></Card>;
  if (error) {
    return (
      <Card title="Metrics Overview">
        <p className="text-sm text-accent-red">{error}</p>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Metrics Overview">
        <p className="text-sm text-gray-500">Select a series to view metrics.</p>
      </Card>
    );
  }

  return (
    <Card title="Metrics Overview">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile
          label="Peak CCV"
          value={formatCompact(data.peakCCV?.totalCCV ?? 0)}
          detail={data.peakCCV ? formatDateTime(data.peakCCV.timestamp) : undefined}
          color="text-accent-cyan"
        />
        <MetricTile
          label="Average CCV"
          value={formatCompact(data.avgCCV)}
          color="text-clutch-red"
        />
        <MetricTile
          label="Total Viewed Hours"
          value={formatHours(data.totalViewedHours)}
          color="text-accent-purple"
        />
        <MetricTile
          label="Tracked Channels"
          value={formatNumber(data.channelLeaderboard.length)}
          color="text-accent-green"
        />
      </div>
    </Card>
  );
}

function MetricTile({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: string;
  detail?: string;
  color: string;
}) {
  return (
    <div className="rounded-lg bg-navy-800/60 p-4">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="mt-1 text-xs font-medium text-gray-400">{label}</div>
      {detail && (
        <div className="mt-0.5 text-[10px] text-gray-600">{detail}</div>
      )}
    </div>
  );
}
