/**
 * SegmentedControl — ONE exclusive-choice control for Discover filters
 * (platform, sort, chart mode, review bucket). Time windows keep using
 * RangePill; sections keep using Tab. Before this, the same kind of
 * choice was drawn four different ways on one page.
 */
import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  icon?: ReactNode;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? '3px 8px' : '5px 10px';
  const fs = size === 'sm' ? 11.5 : 12;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="card segmented"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 3, borderRadius: 8 }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            title={o.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: pad,
              fontSize: fs,
              fontWeight: 600,
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: active ? 'var(--bg-hover)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              boxShadow: active ? 'inset 0 0 0 1px var(--border)' : 'none',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
