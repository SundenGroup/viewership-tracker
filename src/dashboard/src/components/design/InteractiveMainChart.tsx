import { useEffect, useMemo, useRef, useState } from 'react';
import { Row } from './Layout';
import { Tab } from './Tab';
import { AreaChart, LineChart, StackedAreaChart, type SeriesData } from './charts';
import { PlatformPip } from './PlatformPip';
import { formatChartTimeInTz } from '@/utils/formatters';
import { fmtCompact, fmtN } from '@/design/format';

export type ChartDimension = 'platform' | 'region' | 'language' | 'total';
/** `stacked` = stacked areas per series. `line` = one line per series. */
export type ChartMode = 'stacked' | 'line';

export interface DimensionSeries {
  platform: SeriesData[];
  region: SeriesData[];
  language: SeriesData[];
  total: number[];
}

/**
 * Shared dimension-switcher chart. The parent builds per-dimension series from
 * real data; this component handles the toggle UI, legend, and rendering.
 */
export function InteractiveMainChart({
  series,
  totalData,
  height = 260,
  width = 1020,
  initialDimension = 'total',
  initialMode = 'line',
  initialShowTotal = true,
  timestamps,
  timezone,
  dayBoundaries,
  onTimestampClick,
  onRangeSelect,
  anchorTimestamp,
  rangeFrom,
  rangeTo,
}: {
  series: DimensionSeries;
  totalData: number[];
  height?: number;
  width?: number;
  initialDimension?: ChartDimension;
  initialMode?: ChartMode;
  initialShowTotal?: boolean;
  /** ISO timestamp per sample. When provided, an x-axis with ~6 ticks renders
   *  beneath the plot. Formatted in `timezone` (falls back to local). */
  timestamps?: string[];
  timezone?: string;
  /**
   * Vertical dashed boundary markers at the start of each broadcast day,
   * mirroring the legacy report's day-of-broadcast labelling. The `index`
   * is the data-array index where the day starts. Labels render at the
   * bottom of the chart.
   */
  dayBoundaries?: Array<{ index: number; label: string }>;
  /** Fired when the user clicks (no drag) on a chart point. */
  onTimestampClick?: (iso: string) => void;
  /**
   * Fired when the user drags across the chart to select a window
   * (≥5 px drag distance). Both timestamps come from the timestamps array.
   */
  onRangeSelect?: (fromIso: string, toIso: string) => void;
  /** ISO timestamp to render as a vertical dashed red line (single-pin marker). */
  anchorTimestamp?: string | null;
  /** ISO range start to render as a translucent rectangle. */
  rangeFrom?: string | null;
  /** ISO range end to render as a translucent rectangle. */
  rangeTo?: string | null;
}) {
  const [dimension, setDimension] = useState<ChartDimension>(initialDimension);
  const [mode, setMode] = useState<ChartMode>(initialMode);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showTotal, setShowTotal] = useState(initialShowTotal);

  useEffect(() => {
    setHidden(new Set());
  }, [dimension]);

  const activeSeries: SeriesData[] = useMemo(() => {
    if (dimension === 'total') {
      return [{ id: 'total', name: 'Total', color: 'var(--red)', data: totalData }];
    }
    return series[dimension] ?? [];
  }, [dimension, series, totalData]);

  const visible = activeSeries.filter((s) => !hidden.has(s.id));
  const stackTotals = useMemo(() => {
    if (!visible.length) return totalData;
    const len = visible[0]!.data.length;
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
      let sum = 0;
      visible.forEach((v) => (sum += v.data[i] ?? 0));
      out.push(sum);
    }
    return out;
  }, [visible, totalData]);

  const toggleSeries = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      <Row justify="space-between" style={{ marginBottom: 10 }} wrap>
        <Row gap={6}>
          <Tab active={dimension === 'total'} onClick={() => setDimension('total')}>
            Total
          </Tab>
          <Tab active={dimension === 'platform'} onClick={() => setDimension('platform')}>
            Platform
          </Tab>
          <Tab active={dimension === 'region'} onClick={() => setDimension('region')}>
            Category
          </Tab>
          <Tab active={dimension === 'language'} onClick={() => setDimension('language')}>
            Language
          </Tab>
        </Row>
        <Row gap={6}>
          <Tab active={mode === 'line'} onClick={() => setMode('line')}>
            Line
          </Tab>
          <Tab active={mode === 'stacked'} onClick={() => setMode('stacked')}>
            Stacked
          </Tab>
          {dimension !== 'total' && (
            <button
              type="button"
              onClick={() => setShowTotal((v) => !v)}
              className="btn btn-xs"
              title="Overlay event total on the chart"
              style={{
                background: showTotal ? 'var(--bg-card)' : 'transparent',
                borderColor: showTotal ? 'var(--border-strong)' : 'var(--border)',
                color: showTotal ? 'var(--fg)' : 'var(--fg-muted)',
                marginLeft: 4,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 0,
                  display: 'inline-block',
                  marginRight: 6,
                  verticalAlign: 'middle',
                  borderTop: `1px dashed ${showTotal ? 'var(--fg)' : 'var(--fg-dim)'}`,
                }}
              />
              Show total
            </button>
          )}
        </Row>
      </Row>
      <ChartHoverOverlay
        height={height}
        width={width}
        timestamps={timestamps}
        timezone={timezone}
        totalData={totalData}
        visible={visible}
        stackTotals={stackTotals}
        dimension={dimension}
        mode={mode}
        showTotal={showTotal}
        dayBoundaries={dayBoundaries}
        onTimestampClick={onTimestampClick}
        onRangeSelect={onRangeSelect}
        anchorTimestamp={anchorTimestamp}
        rangeFrom={rangeFrom}
        rangeTo={rangeTo}
      >
        {dimension === 'total' ? (
          // Total dimension always renders a single filled area chart.
          <AreaChart data={stackTotals.length ? stackTotals : totalData} width={width} height={height} />
        ) : mode === 'stacked' ? (
          <StackedAreaChart series={visible} width={width} height={height} />
        ) : (
          // Line mode — one line per visible series. When "Show total" is on
          // we append the total as a dashed series to the SAME chart so both
          // scale against the same y-axis max.
          <LineChart
            series={
              showTotal && totalData.length > 0
                ? [
                    ...visible,
                    {
                      id: '__total',
                      name: 'Total',
                      color: 'var(--fg-muted)',
                      data: totalData,
                      dash: true,
                    },
                  ]
                : visible
            }
            width={width}
            height={height}
          />
        )}
        {/* Dashed total overlay for STACKED mode — share y-max with stacked areas */}
        {dimension !== 'total' && mode === 'stacked' && showTotal && totalData.length > 0 && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <LineChart
              series={[
                {
                  id: '__total',
                  name: 'Total',
                  color: 'var(--fg-muted)',
                  data: totalData,
                  dash: true,
                },
              ]}
              width={width}
              height={height}
              maxOverride={Math.max(
                ...stackTotals,
                ...totalData,
                1,
              )}
            />
          </div>
        )}
      </ChartHoverOverlay>

      {/* X-axis time ticks — rendered as a separate row below the plot so
          they don't have to fight the SVG viewBox scale. About 6 evenly
          spaced labels; formatted HH:MM (adds month/day prefix when the
          span crosses midnight in the series timezone). */}
      {timestamps && timestamps.length > 1 && (
        <XAxisTicks
          timestamps={timestamps}
          timezone={timezone}
          count={6}
        />
      )}

      {dimension !== 'total' && activeSeries.length > 1 && (
        <Row gap={8} wrap style={{ marginTop: 12, fontSize: 12 }}>
          {activeSeries.map((s) => {
            const off = hidden.has(s.id);
            const sum = s.sum ?? s.data.reduce((a, b) => Math.max(a, b), 0);
            const isPlatform = dimension === 'platform';
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSeries(s.id)}
                className="btn btn-xs"
                style={{
                  opacity: off ? 0.4 : 1,
                  borderColor: off ? 'var(--border)' : 'var(--border-strong)',
                  background: off ? 'transparent' : 'var(--bg-card)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {isPlatform ? (
                  <PlatformPip id={s.id} size={11} />
                ) : (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: s.color,
                      display: 'inline-block',
                    }}
                  />
                )}
                {s.name ?? s.id}
                <span className="tabular" style={{ color: 'var(--fg-dim)' }}>
                  {fmtCompact(sum)}
                </span>
              </button>
            );
          })}
        </Row>
      )}
    </div>
  );
}

// ── X-axis time tick strip ────────────────────────────────────────────────

function XAxisTicks({
  timestamps,
  timezone,
  count = 6,
}: {
  timestamps: string[];
  timezone?: string;
  count?: number;
}) {
  const n = timestamps.length;
  if (n < 2) return null;

  // Decide whether to show the date alongside the time: if the span crosses
  // midnight in the target timezone, include the month+day so "00:00" isn't
  // ambiguous.
  const fmt = useMemo(() => {
    const first = safeDate(timestamps[0]);
    const last = safeDate(timestamps[n - 1]);
    const sameDay =
      first && last
        ? daytag(first, timezone) === daytag(last, timezone)
        : true;
    return (d: Date) => formatChartTimeInTz(d, timezone, !sameDay);
  }, [timestamps, timezone, n]);

  const ticks: Array<{ pct: number; label: string }> = [];
  const slots = Math.max(2, Math.min(count, n));
  for (let i = 0; i < slots; i++) {
    const idx = Math.round((i / (slots - 1)) * (n - 1));
    const d = safeDate(timestamps[idx]);
    ticks.push({
      pct: (i / (slots - 1)) * 100,
      label: d ? fmt(d) : '',
    });
  }

  return (
    <div
      style={{
        position: 'relative',
        height: 16,
        marginTop: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--fg-dim)',
        letterSpacing: '0.02em',
      }}
    >
      {ticks.map((t, i) => {
        const isFirst = i === 0;
        const isLast = i === ticks.length - 1;
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: `${t.pct}%`,
              whiteSpace: 'nowrap',
              transform: isFirst
                ? 'translateX(0)'
                : isLast
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
            }}
          >
            {t.label}
          </span>
        );
      })}
    </div>
  );
}

function safeDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daytag(d: Date, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// ── Hover overlay: vertical tracker line + per-sample tooltip ────────────
// Wraps the SVG chart with a same-size div that owns pointer events. On
// move, we map pointer-x → data index, draw a vertical rule, and float a
// compact tooltip near the cursor showing the timestamp + per-series
// values at that sample. On pointer-leave the overlay vanishes.

function ChartHoverOverlay({
  height,
  width,
  timestamps,
  timezone,
  totalData,
  visible,
  stackTotals,
  dimension,
  mode,
  showTotal,
  dayBoundaries,
  onTimestampClick,
  onRangeSelect,
  anchorTimestamp,
  rangeFrom,
  rangeTo,
  children,
}: {
  height: number;
  width: number;
  timestamps?: string[];
  timezone?: string;
  totalData: number[];
  visible: SeriesData[];
  stackTotals: number[];
  dimension: ChartDimension;
  mode: ChartMode;
  showTotal: boolean;
  dayBoundaries?: Array<{ index: number; label: string }>;
  onTimestampClick?: (iso: string) => void;
  onRangeSelect?: (fromIso: string, toIso: string) => void;
  anchorTimestamp?: string | null;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  // Drag-to-select state. dragStartX is the container-local x where pointer
  // went down; dragEndX is where it currently is. We wait until pointer-up to
  // decide whether it was a click (small drag) or a range select.
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragEndX, setDragEndX] = useState<number | null>(null);

  // Pick the authoritative sample count — prefer timestamps, then the
  // actual rendered series so the tracker locks onto the rightmost sample
  // when the pointer rides the trailing edge.
  const n = timestamps?.length
    ? timestamps.length
    : dimension === 'total'
      ? totalData.length
      : visible[0]?.data.length ?? 0;

  // The SVG uses viewBox=0 0 width height with width="100%", so the chart
  // padding (svg units) maps to a fraction of the rendered container width.
  // We need this fraction to translate between mouse x and data-index in
  // both directions: hover detection and tracker placement.
  const svgPad = dimension === 'total' ? 8 : 24;
  const padFracW = width > 0 ? svgPad / width : 0;

  // Map a container-local x → data index (clamped to data bounds).
  const xToIdx = (x: number, rectW: number): number => {
    const dataLeft = padFracW * rectW;
    const dataRight = (1 - padFracW) * rectW;
    const frac = Math.max(
      0,
      Math.min(1, (x - dataLeft) / Math.max(1, dataRight - dataLeft)),
    );
    return Math.round(frac * (n - 1));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (n < 2) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const dataLeft = padFracW * rect.width;
    const dataRight = (1 - padFracW) * rect.width;
    // Outside the actual chart area → no hover. Avoids the tooltip clinging
    // to the last data point when the cursor is in the SVG padding zone.
    if (x < dataLeft || x > dataRight) {
      if (hoverIdx != null) {
        setHoverIdx(null);
        setHoverX(null);
      }
    } else {
      const frac = (x - dataLeft) / Math.max(1, dataRight - dataLeft);
      const idx = Math.round(frac * (n - 1));
      setHoverIdx(idx);
      setHoverX(x);
    }
    // While dragging, track the end x even outside the data zone (clamped
    // to the data area for the visual rectangle).
    if (dragStartX != null) {
      const clamped = Math.max(dataLeft, Math.min(dataRight, x));
      setDragEndX(clamped);
    }
  };
  const onPointerLeave = () => {
    setHoverIdx(null);
    setHoverX(null);
    // If user released outside the chart we also need to clear drag state
    // here (pointer-up only fires inside the captured area).
    if (dragStartX != null) {
      setDragStartX(null);
      setDragEndX(null);
    }
  };

  // Drag-to-select / click distinction. Only enabled when the parent passed
  // either an onTimestampClick or onRangeSelect — otherwise hover-only.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onTimestampClick && !onRangeSelect) return;
    if (n < 2) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const dataLeft = padFracW * rect.width;
    const dataRight = (1 - padFracW) * rect.width;
    if (x < dataLeft || x > dataRight) return;
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* harmless — capture isn't critical */
    }
    setDragStartX(x);
    setDragEndX(x);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartX == null) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) {
      setDragStartX(null);
      setDragEndX(null);
      return;
    }
    const x = e.clientX - rect.left;
    const dataLeft = padFracW * rect.width;
    const dataRight = (1 - padFracW) * rect.width;
    const clampedEnd = Math.max(dataLeft, Math.min(dataRight, x));
    const dist = Math.abs(clampedEnd - dragStartX);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (dist < 5) {
      // Click → single anchor
      if (onTimestampClick && timestamps && timestamps.length > 1) {
        const idx = xToIdx(clampedEnd, rect.width);
        if (timestamps[idx]) onTimestampClick(timestamps[idx]!);
      }
    } else {
      // Drag → range select
      if (onRangeSelect && timestamps && timestamps.length > 1) {
        const idxA = xToIdx(Math.min(dragStartX, clampedEnd), rect.width);
        const idxB = xToIdx(Math.max(dragStartX, clampedEnd), rect.width);
        const a = timestamps[idxA];
        const b = timestamps[idxB];
        if (a && b && a !== b) onRangeSelect(a, b);
      }
    }
    setDragStartX(null);
    setDragEndX(null);
  };

  // Build tooltip rows based on the current dimension + mode.
  const rows = useMemo(() => {
    if (hoverIdx == null) return [];
    if (dimension === 'total') {
      const v =
        (stackTotals.length ? stackTotals : totalData)[hoverIdx] ?? 0;
      return [{ id: 'total', name: 'Total CCV', color: 'var(--red)', value: v }];
    }
    const out = visible.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      color: s.color,
      value: s.data[hoverIdx] ?? 0,
    }));
    if (showTotal && totalData.length > 0) {
      out.push({
        id: '__total',
        name: 'Total',
        color: 'var(--fg-muted)',
        value: totalData[hoverIdx] ?? 0,
      });
    }
    // Sort desc by value so the biggest series bubbles to the top
    return out.sort((a, b) => b.value - a.value);
  }, [hoverIdx, dimension, mode, visible, totalData, stackTotals, showTotal]);

  const label = useMemo(() => {
    if (hoverIdx == null || !timestamps || !timestamps[hoverIdx]) return '';
    const d = new Date(timestamps[hoverIdx]);
    return formatChartTimeInTz(d, timezone, true) || d.toISOString();
  }, [hoverIdx, timestamps, timezone]);

  // Pixel x of the active sample — map data-index back to container width,
  // accounting for the SVG's left/right padding so the tracker sits exactly
  // on the rendered data point (not in the padding zone).
  const trackerX =
    hoverIdx != null && n > 1 && ref.current
      ? (() => {
          const rectW = ref.current.getBoundingClientRect().width;
          const dataLeft = padFracW * rectW;
          const dataWidth = rectW * (1 - 2 * padFracW);
          return dataLeft + (hoverIdx / (n - 1)) * dataWidth;
        })()
      : null;

  // Tooltip positioning: clamp to container so it never overflows.
  // When the cursor is in the right half, flip the tooltip to the left.
  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    pointerEvents: 'none',
    zIndex: 5,
    background:
      'color-mix(in oklab, var(--bg-card) 95%, transparent)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    padding: '8px 10px',
    boxShadow: 'var(--shadow-md)',
    minWidth: 140,
    maxWidth: 240,
    fontSize: 11.5,
    lineHeight: 1.4,
  };
  if (hoverX != null && ref.current) {
    const w = ref.current.getBoundingClientRect().width;
    if (hoverX > w / 2) {
      tooltipStyle.right = Math.max(8, w - hoverX + 12);
    } else {
      tooltipStyle.left = hoverX + 12;
    }
  }

  // Resolve anchor + range timestamps to data indices for visual overlays.
  const anchorIdx = useMemo(() => {
    if (!anchorTimestamp || !timestamps || timestamps.length === 0) return null;
    return findClosestTsIdx(timestamps, anchorTimestamp);
  }, [anchorTimestamp, timestamps]);
  const rangeIdxA = useMemo(() => {
    if (!rangeFrom || !timestamps || timestamps.length === 0) return null;
    return findClosestTsIdx(timestamps, rangeFrom);
  }, [rangeFrom, timestamps]);
  const rangeIdxB = useMemo(() => {
    if (!rangeTo || !timestamps || timestamps.length === 0) return null;
    return findClosestTsIdx(timestamps, rangeTo);
  }, [rangeTo, timestamps]);

  const idxToLeftPct = (i: number): number => {
    if (n < 2) return padFracW * 100;
    return (padFracW + (i / (n - 1)) * (1 - 2 * padFracW)) * 100;
  };

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{
        height,
        width: '100%',
        position: 'relative',
        cursor: onTimestampClick || onRangeSelect ? 'crosshair' : 'default',
        userSelect: 'none',
      }}
    >
      {children}

      {/* Day-boundary markers — vertical dashed lines + labels at each
          broadcast-day start. Mirrors the legacy report's chart annotations.
          Rendered above {children} (which contains the SVG data lines) but
          below the hover tracker so it doesn't fight the user's pointer. */}
      {dayBoundaries && dayBoundaries.length > 0 && n > 1 &&
        dayBoundaries.map((b) => {
          if (b.index < 0 || b.index >= n) return null;
          const leftPct = (padFracW + (b.index / (n - 1)) * (1 - 2 * padFracW)) * 100;
          return (
            <div
              key={`${b.index}-${b.label}`}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: 0,
                bottom: 0,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 16,
                  borderLeft: '1px dashed var(--fg-dim)',
                  opacity: 0.55,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: 4,
                  bottom: 2,
                  fontSize: 9.5,
                  color: 'var(--fg-muted)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                  background:
                    'color-mix(in oklab, var(--bg-card) 80%, transparent)',
                  padding: '1px 4px',
                  borderRadius: 2,
                }}
              >
                {b.label}
              </div>
            </div>
          );
        })}

      {/* Pinned range rectangle — translucent fill with dashed outline.
          Wins over the in-progress drag rectangle when both are present. */}
      {rangeIdxA != null && rangeIdxB != null && n > 1 && (
        <div
          style={{
            position: 'absolute',
            left: `${Math.min(idxToLeftPct(rangeIdxA), idxToLeftPct(rangeIdxB))}%`,
            width: `${Math.abs(idxToLeftPct(rangeIdxB) - idxToLeftPct(rangeIdxA))}%`,
            top: 0,
            bottom: 16,
            background: 'color-mix(in oklab, var(--red) 12%, transparent)',
            border: '1px dashed color-mix(in oklab, var(--red) 50%, transparent)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* In-progress drag rectangle — fades while held down. */}
      {dragStartX != null && dragEndX != null && Math.abs(dragEndX - dragStartX) >= 5 && ref.current && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(dragStartX, dragEndX),
            width: Math.abs(dragEndX - dragStartX),
            top: 0,
            bottom: 16,
            background: 'color-mix(in oklab, var(--red) 18%, transparent)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Anchor line — single pinned timestamp marker (red dashed vertical). */}
      {anchorIdx != null && n > 1 && (
        <div
          style={{
            position: 'absolute',
            left: `${idxToLeftPct(anchorIdx)}%`,
            top: 0,
            bottom: 16,
            borderLeft: '1px dashed var(--red)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Vertical tracker line + dot */}
      {hoverIdx != null && trackerX != null && (
        <>
          <div
            style={{
              position: 'absolute',
              left: trackerX,
              top: 0,
              bottom: 0,
              width: 1,
              background: 'var(--fg-muted)',
              opacity: 0.5,
              pointerEvents: 'none',
            }}
          />
          {/* Per-series dots at intersection — must use the EXACT same y-axis
              max as the rendered chart, otherwise the dots float off the
              lines. The line/stacked chart includes the dashed Total
              overlay in its max when showTotal is on, so we must too,
              otherwise per-series dots shift up and away from the lines. */}
          {rows.map((r) => {
            const seriesMax =
              dimension === 'total'
                ? Math.max(
                    ...(stackTotals.length ? stackTotals : totalData),
                    1,
                  )
                : mode === 'stacked'
                  ? Math.max(...stackTotals, ...totalData, 1)
                  : showTotal
                    ? Math.max(...visible.flatMap((s) => s.data), ...totalData, 1)
                    : Math.max(...visible.flatMap((s) => s.data), 1);
            const pct = seriesMax > 0 ? r.value / seriesMax : 0;
            // Match LineChart padding of 24 (and AreaChart padding of 8).
            const pad = dimension === 'total' ? 8 : 24;
            const yTop = pad + (height - pad * 2) * (1 - pct);
            return (
              <div
                key={r.id}
                style={{
                  position: 'absolute',
                  left: trackerX - 3,
                  top: yTop - 3,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: r.color,
                  border: '1.5px solid var(--bg)',
                  pointerEvents: 'none',
                }}
              />
            );
          })}
        </>
      )}

      {/* Tooltip */}
      {hoverIdx != null && rows.length > 0 && (
        <div style={tooltipStyle}>
          {label && (
            <div
              style={{
                color: 'var(--fg)',
                fontWeight: 600,
                marginBottom: 4,
                letterSpacing: '0.01em',
              }}
            >
              {label}
            </div>
          )}
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--fg-muted)',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: r.color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.name}
              </span>
              <span
                className="tabular"
                style={{
                  color: 'var(--fg)',
                  fontWeight: 500,
                  fontFamily: 'var(--font-mono)',
                }}
                title={fmtN(r.value)}
              >
                {fmtCompact(r.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Find the index in `timestamps` whose value is closest to `iso`. */
function findClosestTsIdx(timestamps: string[], iso: string): number {
  const target = new Date(iso).getTime();
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const d = Math.abs(new Date(timestamps[i]!).getTime() - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}
