import { useState } from 'react';
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
import type { BreakdownEntry } from '@/types/api';

interface RegionDistPanelProps {
  data: BreakdownEntry[];
  loading: boolean;
}

type Metric = 'peakCCV' | 'avgCCV' | 'viewedHours';

const METRIC_LABELS: Record<Metric, string> = {
  peakCCV: 'Peak CCV',
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

function getValue(d: BreakdownEntry, metric: Metric): number {
  if (metric === 'viewedHours') return d.totalCCV / 60;
  return d[metric];
}

function formatValue(v: number, metric: Metric): string {
  if (metric === 'viewedHours') return formatViewedHours(v);
  return formatNumber(v);
}

export function RegionDistPanel({ data, loading }: RegionDistPanelProps) {
  const [metric, setMetric] = useState<Metric>('avgCCV');

  if (loading && data.length === 0) {
    return <Card title="Region Distribution"><LoadingOverlay /></Card>;
  }

  if (data.length === 0) {
    return (
      <Card title="Region Distribution">
        <p className="py-8 text-center text-sm text-gray-500">No region data available.</p>
      </Card>
    );
  }

  // Sort descending by chosen metric
  const sorted = [...data]
    .filter((d) => d.region ?? d.key)
    .sort((a, b) => getValue(b, metric) - getValue(a, metric));

  const grandTotal = sorted.reduce((sum, d) => sum + getValue(d, metric), 0);

  const chartData = sorted.map((d, i) => ({
    name: d.region ?? d.key ?? 'Unknown',
    value: getValue(d, metric),
    pct: grandTotal > 0 ? getValue(d, metric) / grandTotal : 0,
    color: BAR_COLORS[i % BAR_COLORS.length]!,
  }));

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
      subtitle={`${sorted.length} regions detected`}
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
            contentStyle={{
              backgroundColor: '#141820',
              border: '1px solid #2A2F36',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelStyle={{ color: '#9ca3af' }}
            formatter={(value: number, _name: string, entry: { payload?: { pct: number } }) => [
              `${formatValue(value, metric)} (${formatPercent(entry.payload?.pct ?? 0)})`,
              METRIC_LABELS[metric],
            ]}
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
