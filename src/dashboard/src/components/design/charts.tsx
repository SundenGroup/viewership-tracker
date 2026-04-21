/* Charts — SVG, lightweight, theme-aware.
   Ported 1:1 from design_handoff_clutch_tracker/reference/src/charts.jsx. */

import { useId } from 'react';
import { fmtCompact } from '@/design/format';

// ── AreaChart ──────────────────────────────────────────────────────────────

export function AreaChart({
  data,
  width = 560,
  height = 160,
  color = 'var(--red)',
  showGrid = true,
  padding = 8,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  showGrid?: boolean;
  padding?: number;
}) {
  const baseId = useId();
  if (!data || !data.length) return null;
  const max = Math.max(...data);
  const min = 0;
  const w = width - padding * 2;
  const h = height - padding * 2;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const range = max - min || 1;
  const points: Array<[number, number]> = data.map((v, i) => [
    padding + i * step,
    padding + h - ((v - min) / range) * h,
  ]);
  const line = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const area = line + ` L${last[0]},${padding + h} L${first[0]},${padding + h} Z`;
  const gid = `af-${baseId}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showGrid &&
        [0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={padding}
            x2={width - padding}
            y1={padding + h * f}
            y2={padding + h * f}
            stroke="var(--border)"
            strokeDasharray="2 4"
            strokeWidth="1"
          />
        ))}
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────

export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = 'var(--red)',
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!data || !data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const range = max - min || 1;
  const pts = data
    .map((v, i) => [i * step, height - ((v - min) / range) * height])
    .map((p) => p.join(','))
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── StackedAreaChart ──────────────────────────────────────────────────────

export interface SeriesData {
  id: string;
  name?: string;
  color: string;
  data: number[];
  sum?: number;
  /** Render with a dashed stroke (used for the "Show total" overlay). */
  dash?: boolean;
}

export function StackedAreaChart({
  series,
  width = 900,
  height = 220,
  padding = 20,
}: {
  series: SeriesData[];
  width?: number;
  height?: number;
  padding?: number;
}) {
  if (!series || !series.length) return null;
  const first = series[0]!;
  const n = first.data.length;
  const stacked: Array<Array<[number, number]>> = Array.from({ length: n }, (_, i) => {
    let acc = 0;
    return series.map((s) => {
      const v = s.data[i] ?? 0;
      const lo = acc;
      acc += v;
      return [lo, acc] as [number, number];
    });
  });
  const max = Math.max(
    ...stacked.map((row) => (row[row.length - 1]?.[1] ?? 0)),
    1,
  );
  const w = width - padding * 2;
  const h = height - padding * 2;
  const step = n > 1 ? w / (n - 1) : 0;
  const toY = (v: number) => padding + h - (v / max) * h;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={padding}
          x2={width - padding}
          y1={padding + h * f}
          y2={padding + h * f}
          stroke="var(--border)"
          strokeDasharray="2 4"
        />
      ))}
      {series.map((s, si) => {
        const topPts = stacked.map(
          (row, i) => [padding + i * step, toY(row[si]?.[1] ?? 0)] as [number, number],
        );
        const botPts = stacked
          .map((row, i) => [padding + i * step, toY(row[si]?.[0] ?? 0)] as [number, number])
          .reverse();
        const all = [...topPts, ...botPts];
        const d = all.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ') + ' Z';
        return <path key={s.id} d={d} fill={s.color} fillOpacity="0.88" />;
      })}
    </svg>
  );
}

// ── Donut ─────────────────────────────────────────────────────────────────

export interface DonutSegment {
  value: number;
  color: string;
}

export function Donut({
  segments,
  size = 140,
  stroke = 22,
  centerLabel,
  centerSub,
}: {
  segments: DonutSegment[];
  size?: number;
  stroke?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const total = segments.reduce((a, b) => a + b.value, 0) || 1;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
      />
      {segments.map((s, i) => {
        const frac = s.value / total;
        const len = frac * c;
        const dash = `${len} ${c - len}`;
        const dashOffset = -offset;
        offset += len;
        return (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={dash}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
      })}
      {centerLabel && (
        <text
          x={size / 2}
          y={size / 2 - 2}
          textAnchor="middle"
          fontSize="22"
          fontWeight="500"
          fill="var(--fg)"
          fontFamily="var(--font-sans)"
        >
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text
          x={size / 2}
          y={size / 2 + 16}
          textAnchor="middle"
          fontSize="10"
          fill="var(--fg-dim)"
          fontFamily="var(--font-mono)"
          style={{ letterSpacing: '0.1em', textTransform: 'uppercase' }}
        >
          {centerSub}
        </text>
      )}
    </svg>
  );
}

// ── HBar ──────────────────────────────────────────────────────────────────

export function HBar({
  label,
  value,
  max,
  color = 'var(--fg)',
  caption,
  width = '100%',
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
  caption?: string;
  width?: string | number;
}) {
  const pct = Math.min(100, (value / (max || 1)) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, width }}>
      <div
        style={{
          width: 56,
          fontSize: 12,
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          height: 8,
          background: 'var(--bg-sunken)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{ height: '100%', width: pct + '%', background: color, borderRadius: 4 }}
        />
      </div>
      <div
        className="tabular"
        style={{ minWidth: 64, textAlign: 'right', fontSize: 12, color: 'var(--fg)' }}
      >
        {caption ?? fmtCompact(value)}
      </div>
    </div>
  );
}

// ── LineChart ─────────────────────────────────────────────────────────────

export function LineChart({
  series,
  width = 900,
  height = 220,
  padding = 24,
  maxOverride,
}: {
  series: SeriesData[];
  width?: number;
  height?: number;
  padding?: number;
  /** Force the y-axis max (used to keep overlay charts aligned with the main chart). */
  maxOverride?: number;
}) {
  if (!series || !series.length) return null;
  const n = series[0]!.data.length;
  const max = maxOverride ?? Math.max(...series.flatMap((s) => s.data), 1);
  const w = width - padding * 2;
  const h = height - padding * 2;
  const step = n > 1 ? w / (n - 1) : 0;
  const toY = (v: number) => padding + h - (v / max) * h;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={padding}
          x2={width - padding}
          y1={padding + h * f}
          y2={padding + h * f}
          stroke="var(--border-faint)"
          strokeDasharray="2 3"
        />
      ))}
      {series.map((s, si) => {
        const d = s.data
          .map((v, i) => (i === 0 ? 'M' : 'L') + (padding + i * step) + ',' + toY(v))
          .join(' ');
        return (
          <path
            key={s.id ?? si}
            d={d}
            fill="none"
            stroke={s.color}
            strokeWidth={s.dash ? 1.25 : 1.6}
            strokeDasharray={s.dash ? '4 4' : undefined}
            strokeLinejoin="round"
          />
        );
      })}
    </svg>
  );
}

// ── VBarChart ─────────────────────────────────────────────────────────────

export interface VBarItem {
  label: string;
  value: number;
  sub?: string;
  color?: string;
}

export function VBarChart({
  items,
  width = 540,
  height = 220,
  padding = 24,
  valueFmt = (v: number) => fmtCompact(v),
}: {
  items: VBarItem[];
  width?: number;
  height?: number;
  padding?: number;
  valueFmt?: (v: number) => string;
}) {
  if (!items || !items.length) return null;
  const max = Math.max(...items.map((i) => i.value), 1);
  const w = width - padding * 2;
  const h = height - padding * 2 - 28;
  const slot = w / items.length;
  const barW = Math.min(52, slot * 0.68);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={padding}
          x2={width - padding}
          y1={padding + h * (1 - f)}
          y2={padding + h * (1 - f)}
          stroke="var(--border-faint)"
          strokeDasharray="2 3"
        />
      ))}
      {items.map((it, i) => {
        const x = padding + i * slot + (slot - barW) / 2;
        const bh = (it.value / max) * h;
        const y = padding + h - bh;
        return (
          <g key={it.label}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={bh}
              fill={it.color || 'var(--red)'}
              rx="2"
            />
            <text
              x={x + barW / 2}
              y={y - 6}
              textAnchor="middle"
              fontSize="10"
              fill="var(--fg-muted)"
              fontFamily="var(--font-mono)"
            >
              {valueFmt(it.value)}
            </text>
            <text
              x={x + barW / 2}
              y={padding + h + 16}
              textAnchor="middle"
              fontSize="11"
              fill="var(--fg-muted)"
              fontFamily="var(--font-sans)"
            >
              {it.label}
            </text>
            {it.sub && (
              <text
                x={x + barW / 2}
                y={padding + h + 28}
                textAnchor="middle"
                fontSize="9"
                fill="var(--fg-dim)"
                fontFamily="var(--font-mono)"
                style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                {it.sub}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
