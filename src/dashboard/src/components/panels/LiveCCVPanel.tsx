import { useMemo } from 'react';
import { Card, PlatformBadge, LoadingOverlay } from '@/components/common';
import { formatNumber, formatCompact, formatTimeAgo } from '@/utils/formatters';
import type { LiveCCVResponse } from '@/types/api';

type ChannelEntry = LiveCCVResponse['channels'][number];

interface ChannelGroup {
  channelId: string;
  displayName: string;
  platform: string | null;
  totalCCV: number;
  streams: ChannelEntry[];
  isMultiStream: boolean;
}

interface LiveCCVPanelProps {
  data: LiveCCVResponse | null;
  loading: boolean;
  error: string | null;
}

export function LiveCCVPanel({ data, loading, error }: LiveCCVPanelProps) {
  // Group channels by channelId for multi-stream support
  const channelGroups = useMemo<ChannelGroup[]>(() => {
    if (!data?.channels) return [];

    const groupMap = new Map<string, ChannelGroup>();
    for (const ch of data.channels) {
      const existing = groupMap.get(ch.channelId);
      if (existing) {
        existing.totalCCV += ch.concurrentViewers;
        existing.streams.push(ch);
        existing.isMultiStream = true;
      } else {
        groupMap.set(ch.channelId, {
          channelId: ch.channelId,
          displayName: ch.displayName,
          platform: ch.platform,
          totalCCV: ch.concurrentViewers,
          streams: [ch],
          isMultiStream: false,
        });
      }
    }

    return Array.from(groupMap.values()).sort((a, b) => b.totalCCV - a.totalCCV);
  }, [data?.channels]);

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
            {channelGroups.map((group) => (
              group.isMultiStream ? (
                // Multi-stream: parent row + indented sub-rows
                <MultiStreamRows key={group.channelId} group={group} />
              ) : (
                // Single-stream: normal row
                <tr
                  key={`${group.channelId}-${group.streams[0]?.streamId ?? 'main'}`}
                  className="border-b border-navy-700/30 last:border-0"
                >
                  <td className="py-2 text-gray-200">{group.displayName}</td>
                  <td className="py-2">
                    <PlatformBadge platform={group.platform ?? 'unknown'} />
                  </td>
                  <td className="py-2 text-right font-mono text-gray-200">
                    {formatCompact(group.totalCCV)}
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MultiStreamRows({ group }: { group: ChannelGroup }) {
  const sortedStreams = [...group.streams].sort((a, b) => b.concurrentViewers - a.concurrentViewers);

  return (
    <>
      {/* Parent row with summed CCV */}
      <tr className="border-b border-navy-700/30">
        <td className="py-2 text-gray-200 font-medium">{group.displayName}</td>
        <td className="py-2">
          <PlatformBadge platform={group.platform ?? 'unknown'} />
        </td>
        <td className="py-2 text-right font-mono text-gray-200 font-medium">
          {formatCompact(group.totalCCV)}
        </td>
      </tr>
      {/* Sub-rows for each stream */}
      {sortedStreams.map((stream, idx) => (
        <tr
          key={`${group.channelId}-${stream.streamId ?? idx}`}
          className={`border-b border-navy-700/20 ${idx === sortedStreams.length - 1 ? 'border-navy-700/30' : ''}`}
        >
          <td className="py-1.5 pl-5 text-gray-400 text-xs">
            <span className="mr-1.5 text-gray-600">{idx < sortedStreams.length - 1 ? '\u251C\u2500' : '\u2514\u2500'}</span>
            {stream.streamTitle ?? stream.streamId ?? 'Stream'}
          </td>
          <td className="py-1.5" />
          <td className="py-1.5 text-right font-mono text-gray-400 text-xs">
            {formatCompact(stream.concurrentViewers)}
          </td>
        </tr>
      ))}
    </>
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
