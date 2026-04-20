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
}: {
  series: DimensionSeries;
  totalData: number[];
  height?: number;
  width?: number;
  initialDimension?: ChartDimension;
  initialMode?: ChartMode;
  initialShowTotal?: boolean;
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
          // Line mode — one line per visible series.
          <LineChart series={visible} width={width} height={height} />
        )}
        {/* Dashed total overlay — always shows the event's overall curve on top */}
        {dimension !== 'total' && showTotal && totalData.length > 0 && (
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
            />
          </div>
        )}
      </div>
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
