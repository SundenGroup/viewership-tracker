/**
 * SeriesSwitcher — compact series picker for the global TopNav.
 *
 * Native <select> (keyboard + screen-reader friendly) styled to match the
 * .btn chrome, with series grouped by status. Context-aware navigation is
 * the caller's job via onChange — e.g. staying on /explore when switching
 * series from the Explore page.
 */

import type { TournamentSeries } from '@/types/api';

export function SeriesSwitcher({
  seriesList,
  value,
  onChange,
  compact = false,
}: {
  seriesList: TournamentSeries[];
  value: string | null | undefined;
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  const groups: Array<[label: string, items: TournamentSeries[]]> = [
    ['Active', seriesList.filter((s) => s.status === 'active')],
    ['Draft', seriesList.filter((s) => s.status === 'draft')],
    ['Completed', seriesList.filter((s) => s.status === 'completed')],
  ];

  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value) onChange(e.target.value);
      }}
      title="Switch series"
      aria-label="Switch series"
      style={{
        maxWidth: compact ? 150 : 210,
        padding: '5px 8px',
        fontSize: 12,
        background: 'var(--bg-card)',
        color: value ? 'var(--fg)' : 'var(--fg-muted)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        outline: 'none',
        cursor: 'pointer',
      }}
    >
      <option value="">Series…</option>
      {groups.map(
        ([label, items]) =>
          items.length > 0 && (
            <optgroup key={label} label={label}>
              {items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.status === 'active' ? '● ' : ''}
                  {s.short_name || s.name}
                </option>
              ))}
            </optgroup>
          ),
      )}
    </select>
  );
}
