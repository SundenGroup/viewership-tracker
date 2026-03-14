import type { ScopeLevel, Stage, BroadcastDay } from '@/types/api';

type StageWithDays = Stage & { broadcast_days: BroadcastDay[] };

interface ScopeSelectorBarProps {
  scopeLevel: ScopeLevel;
  onScopeLevelChange: (level: ScopeLevel) => void;
  selectedDayId: string;
  onDayIdChange: (dayId: string) => void;
  selectedStageId: string;
  onStageIdChange: (stageId: string) => void;
  stages: StageWithDays[];
  hasMultipleStages: boolean;
  activeLabel: string;
}

/** Strip time portion from ISO / Date-like strings → "2026-03-07" */
function fmtDate(raw: string | Date): string {
  const s = typeof raw === 'object' && raw instanceof Date ? raw.toISOString() : String(raw);
  return s.replace(/T.*$/, '');
}

export function ScopeSelectorBar({
  scopeLevel,
  onScopeLevelChange,
  selectedDayId,
  onDayIdChange,
  selectedStageId,
  onStageIdChange,
  stages,
  hasMultipleStages,
  activeLabel,
}: ScopeSelectorBarProps) {
  const allDays = stages.flatMap((s) => s.broadcast_days);

  // Build level options
  const levels: { value: ScopeLevel; label: string }[] = [
    { value: 'series', label: 'Series' },
    ...(hasMultipleStages ? [{ value: 'stage' as ScopeLevel, label: 'Stage' }] : []),
    { value: 'day', label: 'Day' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-navy-700/50 bg-navy-850 px-4 py-2.5 shadow-lg">
      {/* Level segmented control */}
      <div className="flex rounded-md bg-navy-800 p-0.5">
        {levels.map((l) => (
          <button
            key={l.value}
            onClick={() => {
              onScopeLevelChange(l.value);
              window.umami?.track('scope-change', { level: l.value });
            }}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              scopeLevel === l.value
                ? 'bg-clutch-red text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* Stage dropdown */}
      {scopeLevel === 'stage' && stages.length > 0 && (
        <select
          value={selectedStageId}
          onChange={(e) => {
            const stage = stages.find((s) => s.id === e.target.value);
            onStageIdChange(e.target.value);
            window.umami?.track('scope-stage-select', { stageName: stage?.name ?? 'unknown' });
          }}
          className="rounded-md border border-navy-700 bg-navy-800 px-2.5 py-1 text-xs text-gray-200 outline-none focus:border-clutch-red/50"
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      {/* Day dropdown */}
      {scopeLevel === 'day' && allDays.length > 0 && (
        <select
          value={selectedDayId}
          onChange={(e) => {
            const day = allDays.find((d) => d.id === e.target.value);
            onDayIdChange(e.target.value);
            window.umami?.track('scope-day-select', { dayLabel: day?.label ?? 'unknown' });
          }}
          className="rounded-md border border-navy-700 bg-navy-800 px-2.5 py-1 text-xs text-gray-200 outline-none focus:border-clutch-red/50"
        >
          {hasMultipleStages
            ? stages.map((s) => (
                <optgroup key={s.id} label={s.name}>
                  {s.broadcast_days.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} ({fmtDate(d.date)})
                    </option>
                  ))}
                </optgroup>
              ))
            : allDays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} ({fmtDate(d.date)})
                </option>
              ))}
        </select>
      )}

      {/* Active scope label */}
      <span className="text-xs text-gray-500">
        Showing: <span className="font-medium text-gray-300">{activeLabel}</span>
      </span>
    </div>
  );
}
