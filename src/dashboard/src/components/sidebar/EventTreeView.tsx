import { useState } from 'react';
import { Button, StatusBadge, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { formatDate, formatTimeInTz } from '@/utils/formatters';
import type { SeriesWithStages, BroadcastStatus } from '@/types/api';

interface EventTreeViewProps {
  seriesDetail: SeriesWithStages | null;
  loading: boolean;
  onStatusChange: (dayId: string, status: BroadcastStatus) => void;
  statusLoading?: string; // dayId currently being updated
}

export function EventTreeView({
  seriesDetail,
  loading,
  onStatusChange,
  statusLoading,
}: EventTreeViewProps) {
  const { isAdmin } = useAuth();
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});

  if (loading && !seriesDetail) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner size="sm" />
      </div>
    );
  }

  if (!seriesDetail) {
    return (
      <p className="px-4 py-3 text-xs text-gray-500">
        Select a series to view its schedule.
      </p>
    );
  }

  const stages = [...seriesDetail.stages].sort((a, b) => a.order - b.order);

  const toggleStage = (stageId: string) => {
    setExpandedStages((prev) => ({ ...prev, [stageId]: !isExpanded(stageId) }));
  };

  const isExpanded = (stageId: string) => {
    // Default to expanded if not explicitly set
    return expandedStages[stageId] !== false;
  };

  return (
    <div className="space-y-0.5">
      {/* Series name */}
      <div className="flex items-center gap-2 px-4 py-2">
        <div className="h-1.5 w-1.5 rounded-full bg-clutch-red" />
        <span className="truncate text-xs font-semibold text-gray-200">
          {seriesDetail.name}
        </span>
        <StatusBadge status={seriesDetail.status} />
      </div>

      {stages.length === 0 && (
        <p className="px-4 py-2 text-xs text-gray-600">No stages configured.</p>
      )}

      {stages.map((stage) => (
        <div key={stage.id}>
          {/* Stage header */}
          <button
            onClick={() => toggleStage(stage.id)}
            className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-navy-800/60"
          >
            <svg
              className={`h-3 w-3 flex-shrink-0 text-gray-600 transition-transform ${
                isExpanded(stage.id) ? 'rotate-90' : ''
              }`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                clipRule="evenodd"
              />
            </svg>
            <span className="truncate text-xs font-medium text-gray-300">
              {stage.name}
            </span>
            <StatusBadge status={stage.status} />
          </button>

          {/* Broadcast days */}
          {isExpanded(stage.id) && (
            <div className="ml-5 border-l border-navy-700/50 pl-3">
              {stage.broadcast_days.length === 0 && (
                <p className="py-1.5 text-[10px] text-gray-600">No broadcast days.</p>
              )}
              {stage.broadcast_days.map((day) => (
                <div
                  key={day.id}
                  className="flex items-center justify-between gap-1 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-gray-400">
                        {day.label}
                      </span>
                      <StatusBadge status={day.status} />
                    </div>
                    <span className="text-[10px] text-gray-600">
                      {formatDate(day.date)}
                      {day.broadcast_start && seriesDetail?.timezone && (
                        <> &middot; {formatTimeInTz(day.broadcast_start, seriesDetail.timezone)}</>
                      )}
                    </span>
                  </div>

                  {/* Action buttons — status changes are admin only */}
                  <div className="flex-shrink-0">
                    {isAdmin && day.status === 'scheduled' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onStatusChange(day.id, 'live')}
                        loading={statusLoading === day.id}
                        className="!px-2 !py-0.5 !text-[10px]"
                      >
                        Go Live
                      </Button>
                    )}
                    {isAdmin && day.status === 'live' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onStatusChange(day.id, 'completed')}
                        loading={statusLoading === day.id}
                        className="!px-2 !py-0.5 !text-[10px]"
                      >
                        Complete
                      </Button>
                    )}
                    {day.status === 'completed' && (
                      <svg
                        className="h-3.5 w-3.5 text-accent-green"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
