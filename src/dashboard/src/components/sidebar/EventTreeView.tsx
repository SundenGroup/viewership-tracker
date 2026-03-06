import { useState, useRef, useEffect } from 'react';
import { Button, StatusBadge, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { formatDate, formatTimeInTz } from '@/utils/formatters';
import type { SeriesWithStages, BroadcastStatus } from '@/types/api';

interface EventTreeViewProps {
  seriesDetail: SeriesWithStages | null;
  loading: boolean;
  onStatusChange: (dayId: string, status: BroadcastStatus) => void;
  onExtendBroadcast: (dayId: string, minutes: number) => void;
  statusLoading?: string; // dayId currently being updated
}

const EXTEND_OPTIONS = [
  { label: '+30 min', minutes: 30 },
  { label: '+1 hour', minutes: 60 },
  { label: '+2 hours', minutes: 120 },
];

export function EventTreeView({
  seriesDetail,
  loading,
  onStatusChange,
  onExtendBroadcast,
  statusLoading,
}: EventTreeViewProps) {
  const { isAdmin } = useAuth();
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});
  const [extendMenuOpen, setExtendMenuOpen] = useState<string | null>(null);
  const extendMenuRef = useRef<HTMLDivElement>(null);

  // Close extend menu on outside click
  useEffect(() => {
    if (!extendMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (extendMenuRef.current && !extendMenuRef.current.contains(e.target as Node)) {
        setExtendMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [extendMenuOpen]);

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
                  <div className="flex flex-shrink-0 items-center gap-1">
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
                      <>
                        {/* Extend dropdown */}
                        <div className="relative" ref={extendMenuOpen === day.id ? extendMenuRef : undefined}>
                          <button
                            onClick={() => setExtendMenuOpen(extendMenuOpen === day.id ? null : day.id)}
                            disabled={statusLoading === day.id}
                            className="flex items-center gap-0.5 rounded bg-navy-700/60 px-1.5 py-0.5 text-[10px] font-medium text-accent-cyan transition-colors hover:bg-navy-700 disabled:opacity-50"
                            title="Extend broadcast end time"
                          >
                            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                            </svg>
                            Extend
                          </button>

                          {extendMenuOpen === day.id && (
                            <div className="absolute right-0 top-full z-50 mt-1 min-w-[100px] rounded border border-navy-600 bg-navy-800 py-1 shadow-xl">
                              {EXTEND_OPTIONS.map((opt) => (
                                <button
                                  key={opt.minutes}
                                  onClick={() => {
                                    setExtendMenuOpen(null);
                                    onExtendBroadcast(day.id, opt.minutes);
                                  }}
                                  className="block w-full px-3 py-1.5 text-left text-[11px] text-gray-300 transition-colors hover:bg-navy-700 hover:text-white"
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onStatusChange(day.id, 'completed')}
                          loading={statusLoading === day.id}
                          className="!px-2 !py-0.5 !text-[10px]"
                        >
                          Complete
                        </Button>
                      </>
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
