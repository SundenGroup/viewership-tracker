import type { ReactNode } from 'react';
import { fmtPct } from '@/design/format';

export type KpiSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<KpiSize, { v: number; l: number }> = {
  sm: { v: 22, l: 10 },
  md: { v: 32, l: 11 },
  lg: { v: 44, l: 11 },
  xl: { v: 64, l: 12 },
};

export function Kpi({
  label,
  value,
  sub,
  trend,
  size = 'lg',
  right,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  trend?: number | null;
  size?: KpiSize;
  right?: ReactNode;
}) {
  const s = SIZES[size];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="eyebrow" style={{ fontSize: s.l }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div
          className="tabular"
          style={{
            fontSize: s.v,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          {value}
        </div>
        {trend != null && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: trend >= 0 ? 'var(--live)' : 'var(--danger)',
            }}
          >
            {trend >= 0 ? '▲' : '▼'} {fmtPct(trend)}
          </div>
        )}
        {right}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{sub}</div>}
    </div>
  );
}
