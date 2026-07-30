/**
 * StatBlock — the handoff's plain KPI: mono eyebrow, big tabular value,
 * quiet sub. Deliberately NOT a card — the Analyze surfaces reserve boxes
 * for the one emphasized metric; everything else breathes on the page.
 */
import type { ReactNode } from 'react';

export function StatBlock({
  label,
  value,
  sub,
  size = 'lg',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const v = size === 'lg' ? 44 : 32;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{label}</div>
      <div
        className="tabular"
        style={{ fontSize: v, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1, whiteSpace: 'nowrap' }}
      >
        {value}
      </div>
      {sub != null && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{sub}</div>}
    </div>
  );
}
