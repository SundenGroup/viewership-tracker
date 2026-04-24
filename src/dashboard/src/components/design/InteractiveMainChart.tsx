import { useEffect, useMemo, useState } from 'react';
import { Row } from './Layout';
import { Tab } from './Tab';
import { AreaChart, LineChart, StackedAreaChart, type SeriesData } from './charts';
import { PlatformPip } from './PlatformPip';
import { fmtCompact } from '@/design/format';

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
  initialDimension = 'platform',
  initialMode = 'line',
  initialShowTotal = true,
  timestamps,
  timezone,
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
          <Tab active={dimension === 'platform'} onClick={() => setDimension('platform')}>
            Platform
          </Tab>
          <Tab active={dimension === 'region'} onClick={() => setDimension('region')}>
            Category
          </Tab>
          <Tab active={dimension === 'language'} onClick={() => setDimension('language')}>
            Language
          </Tab>
          {showTotal && (
            <Tab active={dimension === 'total'} onClick={() => setDimension('total')}>
              Total
            </Tab>
          )}
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
      <div style={{ height, position: 'relative' }}>
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
      </div>

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
    return (d: Date) => {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          month: sameDay ? undefined : 'short',
          day: sameDay ? undefined : 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(d);
        const month = parts.find((p) => p.type === 'month')?.value ?? '';
        const day = parts.find((p) => p.type === 'day')?.value ?? '';
        const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
        const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
        return sameDay ? `${hour}:${minute}` : `${month} ${day} · ${hour}:${minute}`;
      } catch {
        return '';
      }
    };
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
