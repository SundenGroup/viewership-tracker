import { Card, PlatformBadge, LoadingOverlay } from '@/components/common';
import { formatNumber, formatCompact, formatTimeAgo } from '@/utils/formatters';
import type { LiveCCVResponse } from '@/types/api';

interface LiveCCVPanelProps {
  data: LiveCCVResponse | null;
  loading: boolean;
  error: string | null;
}

export function LiveCCVPanel({ data, loading, error }: LiveCCVPanelProps) {
  if (loading && !data) return <Card title="Live CCV"><LoadingOverlay /></Card>;
  if (error) {
    return (
      <Card title="Live CCV">
        <p className="text-sm text-accent-red">{error}</p>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Live CCV">
        <p className="text-sm text-gray-500">Select a series to view live viewership.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Live CCV"
      subtitle={data.timestamp ? `Updated ${formatTimeAgo(data.timestamp)}` : undefined}
    >
      {/* Summary Stats */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatBox label="Total CCV" value={formatNumber(data.totalCCV)} accent />
        <StatBox label="Channels" value={String(data.channelCount)} />
        <StatBox label="Live" value={String(data.liveChannels)} />
      </div>

      {/* Channel List */}
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700/50 text-xs text-gray-500">
              <th className="pb-2 text-left font-medium">Channel</th>
              <th className="pb-2 text-left font-medium">Platform</th>
              <th className="pb-2 text-right font-medium">CCV</th>
            </tr>
          </thead>
          <tbody>
            {data.channels
              .sort((a, b) => b.concurrentViewers - a.concurrentViewers)
              .map((ch) => (
                <tr
                  key={ch.channelId}
                  className="border-b border-navy-700/30 last:border-0"
                >
                  <td className="py-2 text-gray-200">{ch.displayName}</td>
                  <td className="py-2">
                    <PlatformBadge platform={ch.platform ?? 'unknown'} />
                  </td>
                  <td className="py-2 text-right font-mono text-gray-200">
                    {formatCompact(ch.concurrentViewers)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StatBox({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-navy-800/60 p-3 text-center">
      <div
        className={`text-2xl font-bold ${accent ? 'text-accent-cyan' : 'text-gray-100'}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-gray-500">{label}</div>
    </div>
  );
}
