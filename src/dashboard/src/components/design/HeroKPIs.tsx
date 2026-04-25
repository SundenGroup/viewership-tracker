/**
 * HeroKPIs — 3-cell headline KPI strip (Peak CCV · Avg CCV · Hours watched)
 * for post-event surfaces (Public Recap, Detailed Report, Simple Report).
 *
 * Each cell shows:
 *   - eyebrow label
 *   - giant tabular value (fmtN for precision, fmtCompact for hours)
 *   - YoY delta chip (optional)
 *   - contextual micro-visualization:
 *     · Peak:  mini sparkline with peak-point marker
 *     · Avg:   avg/peak ratio bar
 *     · Hours: per-day segmented bar + "24/7 equivalent viewers" ballpark
 *
 * Variants: "xl" (detailed report, public recap desktop),
 *           "md" (simple report),
 *           "mobile" (public mobile recap).
 *
 * Ported 1:1 from design_handoff_viewership_tracker v6 src/ui.jsx.
 */

import type { ReactNode } from 'react';
import { fmtCompact, fmtN, fmtPct } from '@/design/format';
import { getTimezoneAbbr } from '@/utils/formatters';

export type HeroKPIVariant = 'xl' | 'md' | 'mobile';

interface SizeTokens {
  value: number;
  label: number;
  sub: number;
  pad: string;
  gap: number;
  tick: number;
  micro: number;
}

const SIZES: Record<HeroKPIVariant, SizeTokens> = {
  xl: { value: 72, label: 12, sub: 12, pad: '28px 28px', gap: 6, tick: 6, micro: 44 },
  md: { value: 52, label: 11, sub: 11, pad: '22px 22px', gap: 5, tick: 5, micro: 34 },
  mobile: { value: 36, label: 10, sub: 10, pad: '16px 14px', gap: 4, tick: 4, micro: 26 },
};

export function HeroKPIs({
  variant = 'xl',
  peak,
  avg,
  hours,
  yoyPeak,
  yoyAvg,
  yoyHours,
  yoyLabel,
  days = 3,
  timeSeries,
  peakAt,
  timezone,
  peakIncludeDate,
}: {
  variant?: HeroKPIVariant;
  peak: number | null;
  avg: number | null;
  hours: number | null;
  yoyPeak?: number | null;
  yoyAvg?: number | null;
  yoyHours?: number | null;
  /** Tooltip / aria-label for the trend chip (e.g. "vs Day 1"). */
  yoyLabel?: string;
  days?: number;
  /** Per-minute total CCV series, drives the sparkline + peak marker. */
  timeSeries?: number[];
  /** ISO timestamp of the peak; enables "Peak at HH:MM TZ" label instead
   *  of the less-useful "peak hit at X% of event". */
  peakAt?: string | null;
  /** IANA timezone (e.g. Europe/Stockholm). Used to render peakAt. */
  timezone?: string;
  /** When true, include the month + day in the peak label (for stage and
   *  full-series scopes where the peak could be any day). For single-day
   *  scopes leave this false to keep the caption tight. */
  peakIncludeDate?: boolean;
}) {
  const sizes = SIZES[variant];

  const safePeak = peak ?? 0;
  const safeAvg = avg ?? 0;
  const safeHours = hours ?? 0;

  const peakIdx = timeSeries && timeSeries.length > 0 ? timeSeries.indexOf(Math.max(...timeSeries)) : -1;
  const avgPeakRatio = safePeak > 0 ? safeAvg / safePeak : 0;

  // Ballpark: "24/7 equivalent viewer" baseline — hours / (days * 24)
  const avgEqViewers = days > 0 ? Math.round(safeHours / (days * 24)) : 0;

  const Cell = ({
    label,
    value,
    yoy,
    context,
  }: {
    label: string;
    value: ReactNode;
    yoy?: number | null;
    context: ReactNode;
  }) => (
    <div
      style={{
        padding: sizes.pad,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: sizes.gap * 2,
        }}
      >
        <div className="eyebrow" style={{ fontSize: sizes.label }}>
          {label}
        </div>
        {yoy != null && (
          <div
            title={yoyLabel ? `vs ${yoyLabel}` : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: sizes.sub,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 999,
              background:
                yoy >= 0
                  ? 'color-mix(in oklab, var(--live) 15%, transparent)'
                  : 'color-mix(in oklab, var(--danger) 15%, transparent)',
              border: `1px solid ${
                yoy >= 0
                  ? 'color-mix(in oklab, var(--live) 30%, transparent)'
                  : 'color-mix(in oklab, var(--danger) 30%, transparent)'
              }`,
              color: yoy >= 0 ? 'var(--live)' : 'var(--danger)',
            }}
          >
            {yoy >= 0 ? '▲' : '▼'} {fmtPct(yoy).replace('+', '')}
            {yoyLabel && (
              <span style={{ opacity: 0.7, marginLeft: 3, fontWeight: 500 }}>
                vs {yoyLabel}
              </span>
            )}
          </div>
        )}
      </div>
      <div
        className="tabular display"
        style={{
          fontSize: sizes.value,
          fontWeight: 600,
          letterSpacing: '-0.035em',
          lineHeight: 0.95,
          color: 'var(--fg)',
          marginBottom: sizes.gap,
        }}
      >
        {value}
      </div>
      <div style={{ marginTop: sizes.gap * 1.5, height: sizes.micro }}>{context}</div>
    </div>
  );

  // — Peak CCV context: mini sparkline with a marked peak point
  const PeakContext = () => {
    if (!timeSeries || timeSeries.length < 2) {
      return (
        <div style={{ fontSize: sizes.sub, color: 'var(--fg-muted)' }}>
          single highest moment across event
        </div>
      );
    }
    const w = 200;
    const h = sizes.micro - 14;
    const max = Math.max(...timeSeries);
    const step = w / (timeSeries.length - 1);
    const pts = timeSeries.map((v, i) => [i * step, h - (v / max) * h] as [number, number]);
    const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const peakPt = peakIdx >= 0 ? pts[peakIdx] : null;
    const gradId = `hero-peak-${variant}`;

    // Prefer an exact wall-clock time in the series' timezone when we know
    // when the peak happened; otherwise fall back to "% of event".
    let peakLabel: string;
    if (peakAt) {
      try {
        const d = new Date(peakAt);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          month: peakIncludeDate ? 'short' : undefined,
          day: peakIncludeDate ? 'numeric' : undefined,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(d);
        const month = parts.find((p) => p.type === 'month')?.value ?? '';
        const day = parts.find((p) => p.type === 'day')?.value ?? '';
        const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
        const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
        const tz = timezone ? getTimezoneAbbr(d, timezone) : '';
        const datePart = peakIncludeDate && month && day ? `${month} ${day} · ` : '';
        peakLabel = `peak at ${datePart}${hour}:${minute}${tz ? ` ${tz}` : ''}`;
      } catch {
        const pct = timeSeries.length > 1 ? Math.round((peakIdx / (timeSeries.length - 1)) * 100) : 0;
        peakLabel = `peak hit at ${pct}% of event`;
      }
    } else {
      const pct = timeSeries.length > 1 ? Math.round((peakIdx / (timeSeries.length - 1)) * 100) : 0;
      peakLabel = `peak hit at ${pct}% of event`;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <svg width={w} height={h} style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--red)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path} L ${w},${h} L 0,${h} Z`} fill={`url(#${gradId})`} />
          <path
            d={path}
            fill="none"
            stroke="var(--red)"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          {peakPt && (
            <>
              <line
                x1={peakPt[0]}
                x2={peakPt[0]}
                y1={peakPt[1]}
                y2={h}
                stroke="var(--red)"
                strokeWidth="0.75"
                strokeDasharray="2 2"
                opacity="0.6"
              />
              <circle
                cx={peakPt[0]}
                cy={peakPt[1]}
                r="3"
                fill="var(--red)"
                stroke="var(--bg-card)"
                strokeWidth="1.5"
              />
            </>
          )}
        </svg>
        <div
          style={{
            fontSize: sizes.sub,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.02em',
          }}
        >
          {peakLabel}
        </div>
      </div>
    );
  };

  // — Avg CCV context: ratio bar (avg vs peak)
  const AvgContext = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          height: 6,
          background: 'var(--bg-sunken)',
          borderRadius: 2,
          overflow: 'hidden',
          border: '1px solid var(--border-faint)',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: avgPeakRatio * 100 + '%',
            height: '100%',
            background:
              'linear-gradient(90deg, color-mix(in oklab, var(--red) 70%, transparent), var(--red))',
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: -2,
            bottom: -2,
            width: 2,
            background: 'var(--fg-muted)',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: sizes.sub,
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.02em',
        }}
      >
        <span>{Math.round(avgPeakRatio * 100)}% of peak sustained</span>
        <span style={{ color: 'var(--fg-dim)' }}>peak {fmtCompact(safePeak)}</span>
      </div>
    </div>
  );

  // — Hours Watched context: per-day segmented bar + 24/7 equiv
  const HoursContext = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 3, height: 6 }}>
        {Array.from({ length: Math.max(1, days) }).map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: '100%',
              background: 'color-mix(in oklab, var(--red) 65%, transparent)',
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: sizes.sub,
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.02em',
        }}
      >
        <span>
          {days} {days === 1 ? 'day' : 'days'} of live broadcast
        </span>
        <span style={{ color: 'var(--fg-dim)' }}>
          ≈ {fmtCompact(avgEqViewers)} 24/7 equiv.
        </span>
      </div>
    </div>
  );

  const cells = [
    {
      key: 'peak',
      node: (
        <Cell label="Peak CCV" value={fmtN(safePeak)} yoy={yoyPeak ?? null} context={<PeakContext />} />
      ),
    },
    {
      key: 'avg',
      node: <Cell label="Avg CCV" value={fmtN(safeAvg)} yoy={yoyAvg ?? null} context={<AvgContext />} />,
    },
    {
      key: 'hours',
      node: (
        <Cell
          label="Viewed Hours"
          value={fmtCompact(safeHours)}
          yoy={yoyHours ?? null}
          context={<HoursContext />}
        />
      ),
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: variant === 'mobile' ? '1fr' : 'repeat(3, 1fr)',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {cells.map((c, i, arr) => (
        <div
          key={c.key}
          style={{
            borderRight:
              variant !== 'mobile' && i < arr.length - 1 ? '1px solid var(--border)' : 'none',
            borderBottom:
              variant === 'mobile' && i < arr.length - 1 ? '1px solid var(--border)' : 'none',
          }}
        >
          {c.node}
        </div>
      ))}
    </div>
  );
}
