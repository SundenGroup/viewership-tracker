import { useState, useMemo } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, LoadingOverlay } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import { formatCompact, formatChartTime, platformColor, platformLabel } from '@/utils/formatters';
import type { TimeSeriesBucket, GroupedTimeSeriesBucket, TimeSeriesGroupBy, ScopeLevel } from '@/types/api';

interface TimeSeriesPanelProps {
  seriesId: string | undefined;
  scope?: { level: ScopeLevel; id: string };
  /** When set, calls public API instead of authenticated API. */
  publicShortName?: string;
}

type ViewMode = 'total' | 'platform' | 'language';

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'total', label: 'Total' },
  { value: 'platform', label: 'By Platform' },
  { value: 'language', label: 'By Language' },
];

type IntervalOption = 60 | 300 | 600;

const INTERVAL_OPTIONS: { value: IntervalOption; label: string }[] = [
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
];

// Distinct color palette for grouped lines/areas
const GROUP_COLORS = [
  '#FF154D', '#3b82f6', '#a78bfa', '#34d399', '#fb923c',
  '#f472b6', '#fbbf24', '#2dd4bf', '#818cf8', '#e879f9',
];

export function TimeSeriesPanel({ seriesId, scope: scopeProp, publicShortName }: TimeSeriesPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('total');
  const [interval, setInterval] = useState<IntervalOption>(60);

  const groupBy: TimeSeriesGroupBy = viewMode === 'total' ? 'total' : viewMode;

  const effectiveScope = scopeProp ?? { level: 'series' as ScopeLevel, id: seriesId! };

  const { data, loading, error } = useApi(
    () => {
      if (publicShortName) {
        return api.getPublicTimeSeries(publicShortName, {
          scope: effectiveScope.level,
          id: effectiveScope.id,
          interval,
          groupBy,
        });
      }
      return seriesId
        ? api.getTimeSeries({
            scope: effectiveScope.level,
            id: effectiveScope.id,
            interval,
            groupBy,
          })
        : Promise.resolve(null);
    },
    [effectiveScope.level, effectiveScope.id, interval, groupBy, publicShortName],
  );

  // ── Transform data for charts ──────────────────────────────────────────

  // Total mode: simple array
  const totalChartData = useMemo(() => {
    if (!data || viewMode !== 'total') return [];
    return (data.data as TimeSeriesBucket[]).map((d) => ({
      time: formatChartTime(d.timestamp),
      ccv: d.totalCCV,
      channels: d.channelCount,
    }));
  }, [data, viewMode]);

  // Grouped mode: pivot data so each group key becomes a column
  const { groupedChartData, groupKeys } = useMemo(() => {
    if (!data || viewMode === 'total') return { groupedChartData: [] as Record<string, unknown>[], groupKeys: [] as string[] };

    const raw = data.data as GroupedTimeSeriesBucket[];
    const keys = [...new Set(raw.map((d) => d.groupKey))];

    // Pivot: { time, [key1]: ccv, [key2]: ccv, ... }
    const byTime = new Map<string, Record<string, number>>();
    for (const d of raw) {
      const t = formatChartTime(d.timestamp);
      if (!byTime.has(t)) {
        byTime.set(t, {});
      }
      const row = byTime.get(t)!;
      row[d.groupKey] = d.totalCCV;
    }

    const chartData: Record<string, unknown>[] = [...byTime.entries()].map(([time, row]) => ({
      time,
      ...row,
    }));

    return { groupedChartData: chartData, groupKeys: keys };
  }, [data, viewMode]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (!seriesId) {
    return (
      <Card title="CCV Over Time">
        <p className="py-16 text-center text-sm text-gray-500">
          Select a series to view time series data.
        </p>
      </Card>
    );
  }

  const topBar = (
    <div className="flex items-center gap-3">
      {/* View mode toggle */}
      <div className="flex rounded-lg border border-navy-700/50 overflow-hidden">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.value}
            onClick={() => setViewMode(mode.value)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === mode.value
                ? 'bg-clutch-red text-white'
                : 'bg-navy-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {/* Interval toggle */}
      <div className="flex gap-1">
        {INTERVAL_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setInterval(opt.value)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              interval === opt.value
                ? 'bg-navy-600 text-gray-200'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  const isEmpty =
    viewMode === 'total'
      ? totalChartData.length === 0
      : groupedChartData.length === 0;

  return (
    <Card title="CCV Over Time" action={topBar} collapsible storageKey="cvt:panel:timeSeries">
      {loading && isEmpty ? (
        <LoadingOverlay />
      ) : error ? (
        <p className="py-12 text-center text-sm text-accent-red">{error}</p>
      ) : isEmpty ? (
        <p className="py-16 text-center text-sm text-gray-500">
          No time series data available yet. Start polling to collect data.
        </p>
      ) : viewMode === 'total' ? (
        <TotalChart data={totalChartData} />
      ) : viewMode === 'platform' ? (
        <PlatformChart data={groupedChartData} keys={groupKeys} />
      ) : (
        <StackedLanguageChart data={groupedChartData} keys={groupKeys} />
      )}
    </Card>
  );
}

// ── Total CCV area chart ────────────────────────────────────────────────

function TotalChart({ data }: { data: Array<{ time: string; ccv: number; channels: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="tsGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF154D" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#FF154D" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#141820', border: '1px solid #2A2F36', borderRadius: '8px', fontSize: '12px' }}
          labelStyle={{ color: '#9ca3af' }}
          formatter={(value: number, name: string) => [
            formatCompact(value),
            name === 'ccv' ? 'Total CCV' : 'Channels',
          ]}
        />
        <Area type="monotone" dataKey="ccv" stroke="#FF154D" strokeWidth={2} fill="url(#tsGradient)" name="ccv" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Platform overlaid lines ──────────────────────────────────────────────

function PlatformChart({ data, keys }: { data: Array<Record<string, unknown>>; keys: string[] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#141820', border: '1px solid #2A2F36', borderRadius: '8px', fontSize: '12px' }}
          labelStyle={{ color: '#9ca3af' }}
          formatter={(value: number) => [formatCompact(value)]}
        />
        <Legend
          verticalAlign="top"
          iconType="circle"
          wrapperStyle={{ fontSize: '11px', color: '#9ca3af', paddingBottom: '8px' }}
          formatter={(value: string) => platformLabel(value)}
        />
        {keys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={platformColor(key) || GROUP_COLORS[i % GROUP_COLORS.length]}
            strokeWidth={2}
            dot={false}
            name={key}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Language stacked area ────────────────────────────────────────────────

function StackedLanguageChart({ data, keys }: { data: Array<Record<string, unknown>>; keys: string[] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#141820', border: '1px solid #2A2F36', borderRadius: '8px', fontSize: '12px' }}
          labelStyle={{ color: '#9ca3af' }}
          formatter={(value: number) => [formatCompact(value)]}
        />
        <Legend
          verticalAlign="top"
          iconType="circle"
          wrapperStyle={{ fontSize: '11px', color: '#9ca3af', paddingBottom: '8px' }}
          formatter={(value: string) => (value || 'Unknown').toUpperCase()}
        />
        {keys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="1"
            stroke={GROUP_COLORS[i % GROUP_COLORS.length]}
            fill={GROUP_COLORS[i % GROUP_COLORS.length]}
            fillOpacity={0.3}
            name={key}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
