import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Card, LoadingOverlay } from '@/components/common';
import { formatCompact, formatNumber, formatPercent, formatViewedHours } from '@/utils/formatters';
import type { BreakdownEntry, LiveCCVResponse } from '@/types/api';

interface RegionDistPanelProps {
  data: BreakdownEntry[];
  loading: boolean;
  liveCCV?: LiveCCVResponse | null;
}

type Metric = 'liveCCV' | 'avgCCV' | 'viewedHours';

const METRIC_LABELS: Record<Metric, string> = {
  liveCCV: 'Live CCV',
  avgCCV: 'Avg CCV',
  viewedHours: 'Viewed Hours',
};

// Warm neutral palette (distinct from LanguageDistPanel)
const BAR_COLORS = [
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#6366f1', // indigo-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
  '#8b5cf6', // violet-500
  '#06b6d4', // cyan-500
  '#84cc16', // lime-500
  '#ef4444', // red-500
];

function formatValue(v: number, metric: Metric): string {
  if (metric === 'viewedHours') return formatViewedHours(v);
  return formatNumber(v);
}

export function RegionDistPanel({ data, loading, liveCCV }: RegionDistPanelProps) {
  const [metric, setMetric] = useState<Metric>('liveCCV');

  // Compute live CCV per region from live snapshot data
  const liveCCVByRegion = useMemo(() => {
    if (!liveCCV?.channels) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const ch of liveCCV.channels) {
      if (ch.concurrentViewers <= 0) continue;
      const region = ch.region ?? 'Unknown';
      map.set(region, (map.get(region) ?? 0) + ch.concurrentViewers);
    }
    return map;
  }, [liveCCV]);

  if (loading && data.length === 0) {
    return <Card title="Region Distribution"><LoadingOverlay /></Card>;
  }

  if (data.length === 0 && metric !== 'liveCCV') {
    return (
      <Card title="Region Distribution">
        <p className="py-8 text-center text-sm text-gray-500">No region data available.</p>
      </Card>
    );
  }

  // Build chart data based on metric
  let chartData: Array<{ name: string; value: number; pct: number; color: string }>;

  if (metric === 'liveCCV') {
    const entries = [...liveCCVByRegion.entries()]
      .sort((a, b) => b[1] - a[1]);
    const grandTotal = entries.reduce((sum, [, v]) => sum + v, 0);
    chartData = entries.map(([region, value], i) => ({
      name: region,
      value,
      pct: grandTotal > 0 ? value / grandTotal : 0,
      color: BAR_COLORS[i % BAR_COLORS.length]!,
    }));
  } else {
    const sorted = [...data]
      .filter((d) => d.region ?? d.key)
      .sort((a, b) => {
        const va = metric === 'viewedHours' ? a.totalCCV / 60 : a[metric];
        const vb = metric === 'viewedHours' ? b.totalCCV / 60 : b[metric];
        return vb - va;
      });
    const grandTotal = sorted.reduce((sum, d) => {
      const v = metric === 'viewedHours' ? d.totalCCV / 60 : d[metric];
      return sum + v;
    }, 0);
    chartData = sorted.map((d, i) => {
      const value = metric === 'viewedHours' ? d.totalCCV / 60 : d[metric];
      return {
        name: d.region ?? d.key ?? 'Unknown',
        value,
        pct: grandTotal > 0 ? value / grandTotal : 0,
        color: BAR_COLORS[i % BAR_COLORS.length]!,
      };
    });
  }

  if (chartData.length === 0) {
    return (
      <Card title="Region Distribution">
        <p className="py-8 text-center text-sm text-gray-500">No region data available.</p>
      </Card>
    );
  }

  const chartHeight = Math.max(200, chartData.length * 36 + 40);

  const metricToggle = (
    <div className="flex gap-1">
      {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
        <button
          key={m}
          onClick={() => setMetric(m)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            metric === m
              ? 'bg-red-500/20 text-red-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {METRIC_LABELS[m]}
        </button>
      ))}
    </div>
  );

  return (
    <Card
      title="Region Distribution"
      subtitle={`${chartData.length} regions detected`}
      collapsible
      storageKey="cvt:panel:regionDist"
      action={metricToggle}
    >
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 0, right: 10, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" horizontal={false} />
          <XAxis
            type="number"
            stroke="#6b7280"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatCompact(v)}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke="#6b7280"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={80}
          />
          <Tooltip
            content={({ active, payload }) => {
              const first = payload?.[0];
              if (!active || !first) return null;
              const d = first.payload as { name: string; value: number; pct: number };
              return (
                <div style={{ backgroundColor: '#141820', border: '1px solid #2A2F36', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ color: '#e5e7eb', fontWeight: 600 }}>{d.name}: {formatValue(d.value, metric)}</div>
                  <div style={{ color: '#9ca3af', marginTop: 2 }}>{formatPercent(d.pct)} · {METRIC_LABELS[metric]}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={20}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
