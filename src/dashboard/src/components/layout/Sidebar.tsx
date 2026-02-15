import { useState } from 'react';
import { Button, StatusBadge } from '@/components/common';
import { EventTreeView } from '@/components/sidebar/EventTreeView';
import { AddChannelForm } from '@/components/sidebar/AddChannelForm';
import { BulkAddChannelModal } from '@/components/sidebar/BulkAddChannelModal';
import type { OrchestratorStatus, DiscoveryStatus, SeriesWithStages, BroadcastStatus } from '@/types/api';
import { formatTimeAgo, formatDuration } from '@/utils/formatters';

interface SidebarProps {
  seriesId?: string;
  seriesDetail: SeriesWithStages | null;
  seriesDetailLoading: boolean;
  pollingStatus: OrchestratorStatus | null;
  discoveryStatus: DiscoveryStatus | null;
  onStartPolling: () => void;
  onStopPolling: () => void;
  onTriggerPoll: () => void;
  onStartDiscovery: () => void;
  onStopDiscovery: () => void;
  onTriggerDiscovery: () => void;
  onBroadcastDayStatusChange: (dayId: string, status: BroadcastStatus) => void;
  onChannelAdded: () => void;
  pollLoading?: boolean;
  discoveryLoading?: boolean;
  broadcastDayStatusLoading?: string;
}

export function Sidebar({
  seriesId,
  seriesDetail,
  seriesDetailLoading,
  pollingStatus,
  discoveryStatus,
  onStartPolling,
  onStopPolling,
  onTriggerPoll,
  onStartDiscovery,
  onStopDiscovery,
  onTriggerDiscovery,
  onBroadcastDayStatusChange,
  onChannelAdded,
  pollLoading = false,
  discoveryLoading = false,
  broadcastDayStatusLoading,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const isPollingRunning = pollingStatus?.state === 'running';
  const isDiscoveryActive = seriesId
    ? discoveryStatus?.activeDiscoveries.includes(seriesId)
    : false;

  // Determine if there are any live broadcast days for contextual hints
  const hasLiveDays = seriesDetail?.stages.some(
    (stage) => stage.broadcast_days.some((day) => day.status === 'live'),
  ) ?? false;

  if (collapsed) {
    return (
      <aside className="flex w-12 flex-col items-center border-r border-navy-700/50 bg-navy-900 py-4">
        <button
          onClick={() => setCollapsed(false)}
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 flex-col border-r border-navy-700/50 bg-navy-900 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-navy-700/50 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Controls
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Event Tree Section */}
      <div className="border-b border-navy-700/50 py-2">
        <div className="mb-1 px-4">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Schedule
          </span>
        </div>
        <EventTreeView
          seriesDetail={seriesDetail}
          loading={seriesDetailLoading}
          onStatusChange={onBroadcastDayStatusChange}
          statusLoading={broadcastDayStatusLoading}
        />
      </div>

      {/* Polling Section */}
      <div className="border-b border-navy-700/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Polling</span>
          <StatusBadge status={pollingStatus?.state ?? 'stopped'} />
        </div>

        {seriesId && !hasLiveDays && (
          <p className="mb-2 rounded bg-accent-orange/10 px-2 py-1.5 text-[10px] text-accent-orange leading-tight">
            No live broadcast days. Set a day to &quot;Live&quot; in the Schedule above, then start polling to collect viewership data.
          </p>
        )}

        {seriesId && hasLiveDays && !isPollingRunning && (
          <p className="mb-2 rounded bg-clutch-red/10 px-2 py-1.5 text-[10px] text-clutch-red leading-tight">
            Broadcast day is live! Start polling to begin collecting viewer counts from all active channels.
          </p>
        )}

        {pollingStatus?.lastPollResult && (
          <div className="mb-3 space-y-1.5 text-xs text-gray-500">
            <div className="flex justify-between">
              <span>Last poll</span>
              <span className="text-gray-400">
                {formatTimeAgo(pollingStatus.lastPollTime)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Duration</span>
              <span className="text-gray-400">
                {formatDuration(pollingStatus.lastPollResult.duration)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Active days</span>
              <span className="text-gray-400">
                {pollingStatus.activeBroadcastDays}
              </span>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {isPollingRunning ? (
            <Button variant="danger" size="sm" onClick={onStopPolling} className="flex-1">
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onStartPolling} className="flex-1">
              Start
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onTriggerPoll}
            loading={pollLoading}
          >
            Trigger
          </Button>
        </div>
      </div>

      {/* Discovery Section */}
      <div className="border-b border-navy-700/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Discovery</span>
          <StatusBadge status={isDiscoveryActive ? 'running' : 'stopped'} />
        </div>

        {!seriesId && (
          <p className="text-xs text-gray-500">
            Select a series to control discovery.
          </p>
        )}

        {seriesId && !hasLiveDays && (
          <p className="mb-2 rounded bg-navy-800 px-2 py-1.5 text-[10px] text-gray-500 leading-tight">
            Discovery runs alongside polling. Set a broadcast day to &quot;Live&quot; first, then use Trigger to search for streams matching your series keywords.
          </p>
        )}

        {seriesId && hasLiveDays && !isDiscoveryActive && !discoveryStatus?.lastResults[seriesId] && (
          <p className="mb-2 rounded bg-clutch-red/10 px-2 py-1.5 text-[10px] text-clutch-red leading-tight">
            Click Trigger to search for live streams matching your series keywords. New channels appear in the Discovery Feed on the dashboard.
          </p>
        )}

        {seriesId && discoveryStatus?.lastResults[seriesId] && (
          <div className="mb-3 space-y-1.5 text-xs text-gray-500">
            <div className="flex justify-between">
              <span>Last run</span>
              <span className="text-gray-400">
                {formatTimeAgo(discoveryStatus.lastResults[seriesId]?.timestamp)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Discovered</span>
              <span className="text-gray-400">
                {discoveryStatus.lastResults[seriesId]?.discovered ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Added</span>
              <span className="text-accent-green">
                {discoveryStatus.lastResults[seriesId]?.added ?? 0}
              </span>
            </div>
          </div>
        )}

        {seriesId && (
          <div className="flex gap-2">
            {isDiscoveryActive ? (
              <Button variant="danger" size="sm" onClick={onStopDiscovery} className="flex-1">
                Stop
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={onStartDiscovery} className="flex-1">
                Start
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={onTriggerDiscovery}
              loading={discoveryLoading}
            >
              Trigger
            </Button>
          </div>
        )}
      </div>

      {/* Channels Section */}
      <div className="p-4">
        <div className="mb-2">
          <span className="text-sm font-medium text-gray-300">Channels</span>
        </div>

        {!seriesId ? (
          <p className="text-xs text-gray-500">
            Select a series to manage channels.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-gray-600 leading-tight px-4">
              Added channels appear in the Channels panel on the dashboard. Start polling with a live broadcast day to collect viewer data.
            </p>

            <AddChannelForm seriesId={seriesId} onSuccess={onChannelAdded} />

            <div className="px-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBulkModalOpen(true)}
                className="w-full"
              >
                Bulk Add
              </Button>
            </div>

            <BulkAddChannelModal
              open={bulkModalOpen}
              onClose={() => setBulkModalOpen(false)}
              seriesId={seriesId}
              onSuccess={onChannelAdded}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
