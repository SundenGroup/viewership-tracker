/**
 * ScopeScrubber — Series / Stage / Day segmented control + contextual
 * selector + View Group dropdown. Shared between Editor Desktop and
 * Public Live surfaces per design v6.
 *
 * Ported from design_handoff_viewership_tracker v6 src/ui.jsx,
 * adapted to work against real Clutch Tracker data (Stage, BroadcastDay,
 * ViewGroup) instead of the prototype's mock constants.
 */

import type { ScopeLevel, ViewGroup } from '@/types/api';
import { Row } from './Layout';

export type ScopeOption = {
  id: string;
  label: string;
  /** Optional secondary label shown after " · ", e.g. date or date range. */
  sub?: string;
  /** When set, decorates the option (e.g. "· LIVE"). */
  live?: boolean;
};

export function ScopeScrubber({
  level,
  onLevelChange,
  stageId,
  onStageChange,
  stages,
  dayId,
  onDayChange,
  days,
  viewGroup = 'all',
  onViewGroupChange,
  viewGroups,
  compact = false,
  showShowingLabel = true,
  className,
}: {
  level: ScopeLevel;
  onLevelChange?: (l: ScopeLevel) => void;
  stageId?: string;
  onStageChange?: (id: string) => void;
  stages?: ScopeOption[];
  dayId?: string;
  onDayChange?: (id: string) => void;
  days?: ScopeOption[];
  viewGroup?: string;
  onViewGroupChange?: (id: string) => void;
  viewGroups?: ViewGroup[];
  compact?: boolean;
  /** When false, hides the "Showing: Full series" caption. */
  showShowingLabel?: boolean;
  className?: string;
}) {
  const stage = stages?.find((s) => s.id === stageId) ?? stages?.[0] ?? null;
  const day = days?.find((d) => d.id === dayId) ?? days?.[0] ?? null;

  const vgOptions: Array<{ id: string; label: string }> = [
    { id: 'all', label: 'All' },
    ...(viewGroups?.map((g) => ({ id: g.name, label: g.name })) ?? []),
  ];

  const showing =
    level === 'series'
      ? 'Full series'
      : level === 'stage'
        ? stage?.label ?? '—'
        : day
          ? `${day.label}${day.sub ? ` · ${day.sub}` : ''}`
          : '—';

  const fontSize = compact ? 11.5 : 12.5;
  const h = compact ? 28 : 32;

  return (
    <Row gap={8} className={className} style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {/* Series / Stage / Day segmented */}
      <div
        style={{
          display: 'inline-flex',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 2,
          height: h,
          alignItems: 'stretch',
        }}
      >
        {(['series', 'stage', 'day'] as ScopeLevel[]).map((k) => {
          const active = level === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onLevelChange?.(k)}
              style={{
                padding: '0 12px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontSize,
                fontWeight: active ? 600 : 500,
                background: active ? 'var(--red)' : 'transparent',
                color: active ? '#fff' : 'var(--fg-muted)',
                transition: 'background 140ms',
              }}
            >
              {k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Contextual selector — stage or day dropdown */}
      {level === 'stage' && stages && stages.length > 0 && (
        <select
          value={stage?.id ?? ''}
          onChange={(e) => onStageChange?.(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize,
            padding: '0 10px',
            borderRadius: 6,
            height: h,
          }}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {s.sub ? ` · ${s.sub}` : ''}
              {s.live ? ' · LIVE' : ''}
            </option>
          ))}
        </select>
      )}
      {level === 'day' && days && days.length > 0 && (
        <select
          value={day?.id ?? ''}
          onChange={(e) => onDayChange?.(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize,
            padding: '0 10px',
            borderRadius: 6,
            height: h,
          }}
        >
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.sub ? ` · ${d.sub}` : ''}
              {d.live ? ' · LIVE' : ''}
            </option>
          ))}
        </select>
      )}

      {showShowingLabel && !compact && (
        <span style={{ fontSize: 12, color: 'var(--fg-dim)', marginLeft: 2 }}>
          Showing:{' '}
          <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{showing}</span>
        </span>
      )}

      {/* View Group dropdown with globe icon */}
      {onViewGroupChange && (
        <>
          <div style={{ flex: compact ? '0 0 auto' : 1 }} />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '0 10px',
              height: h,
              fontSize,
            }}
          >
            <span style={{ opacity: 0.6, display: 'inline-flex' }}>
              <svg
                width={13}
                height={13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <circle cx={12} cy={12} r={9} />
                <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
              </svg>
            </span>
            <select
              value={viewGroup}
              onChange={(e) => onViewGroupChange(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg)',
                fontSize,
                padding: 0,
                outline: 'none',
                fontWeight: 500,
              }}
            >
              {vgOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </Row>
  );
}
