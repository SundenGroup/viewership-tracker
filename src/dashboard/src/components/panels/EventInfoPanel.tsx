import { Card, StatusBadge, LoadingOverlay } from '@/components/common';
import { formatDate, formatDateTime } from '@/utils/formatters';
import type { SeriesWithStages } from '@/types/api';

interface EventInfoPanelProps {
  series: SeriesWithStages | null;
  loading: boolean;
}

export function EventInfoPanel({ series, loading }: EventInfoPanelProps) {
  if (loading && !series) {
    return <Card title="Event Info"><LoadingOverlay /></Card>;
  }

  if (!series) {
    return (
      <Card title="Event Info">
        <p className="text-sm text-gray-500">Select a series to view event details.</p>
      </Card>
    );
  }

  return (
    <Card title={series.name}>
      <div className="space-y-4">
        {/* Series Info */}
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={series.status} />
          {series.game && (
            <span className="rounded-full bg-navy-700 px-2 py-0.5 text-xs text-gray-300">
              {series.game}
            </span>
          )}
          {series.partner && (
            <span className="text-xs text-gray-500">
              Partner: {series.partner}
            </span>
          )}
        </div>

        {series.start_date && (
          <div className="text-xs text-gray-500">
            {formatDate(series.start_date)}
            {series.end_date && ` — ${formatDate(series.end_date)}`}
          </div>
        )}

        {/* Stages */}
        {series.stages.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Stages
            </h4>
            {series.stages.map((stage) => (
              <div
                key={stage.id}
                className="rounded-lg bg-navy-800/60 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-200">
                    {stage.name}
                  </span>
                  <StatusBadge status={stage.status} />
                </div>

                {/* Broadcast Days */}
                {stage.broadcast_days.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {stage.broadcast_days.map((day) => (
                      <div
                        key={day.id}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-gray-400">
                          {day.label} ({formatDate(day.date)})
                        </span>
                        <div className="flex items-center gap-2">
                          {day.broadcast_start && (
                            <span className="text-gray-600">
                              {formatDateTime(day.broadcast_start)}
                            </span>
                          )}
                          <StatusBadge status={day.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Discovery Config */}
        {(series.discovery_keywords.length > 0 ||
          Object.keys(series.discovery_game_ids).length > 0) && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Discovery Config
            </h4>
            {series.discovery_keywords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {series.discovery_keywords.map((kw) => (
                  <span
                    key={kw}
                    className="rounded-full bg-navy-700 px-2 py-0.5 text-xs text-gray-400"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
