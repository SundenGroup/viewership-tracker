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
  ReferenceLine,
} from 'recharts';
import { Card, LoadingOverlay } from '@/components/common';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import { formatCompact, platformColor, platformLabel } from '@/utils/formatters';
import type { TimeSeriesBucket, GroupedTimeSeriesBucket, TimeSeriesGroupBy, ScopeLevel } from '@/types/api';

interface TimeSeriesPanelProps {
  seriesId: string | undefined;
  scope?: { level: ScopeLevel; id: string };
  /** When set, calls public API instead of authenticated API. */
  publicShortName?: string;
  /** Broadcast days for drawing day boundary markers on multi-day charts. */
  broadcastDays?: Array<{ label: string; broadcast_start: string | null }>;
  /** View Group filter: language codes. */
  languages?: string[];
  /** View Group filter: platform identifiers. */
  platforms?: string[];
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

// ── Formatting helpers ─────────────────────────────────────────────────

interface DayMarker {
  ts: number;
  label: string;
}

function formatTickTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTickDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.getDate();
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${month} ${day}, ${time}`;
}

function formatTooltipLabel(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Check whether data spans more than one calendar day. */
function isMultiDay(firstTs: number, lastTs: number): boolean {
  const a = new Date(firstTs);
  const b = new Date(lastTs);
  return a.getFullYear() !== b.getFullYear()
    || a.getMonth() !== b.getMonth()
    || a.getDate() !== b.getDate();
}

/**
 * Snap a target timestamp to the nearest data point timestamp.
 * Returns the exact ts value from sortedTs that is closest to (and >= ) target,
 * or the closest one before if none are after.
 */
function snapToDataPoint(target: number, sortedTs: number[]): number | null {
  if (sortedTs.length === 0) return null;
  // Find first ts >= target
  let lo = 0;
  let hi = sortedTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is the index of first ts >= target
  if (lo < sortedTs.length) return sortedTs[lo]!;
  // All ts are < target, return the last one
  return sortedTs[sortedTs.length - 1]!;
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function TimeSeriesPanel({ seriesId, scope: scopeProp, publicShortName, broadcastDays, languages, platforms }: TimeSeriesPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('total');
  const [interval, setInterval] = useState<IntervalOption>(60);

  const groupBy: TimeSeriesGroupBy = viewMode === 'total' ? 'total' : viewMode;

  const effectiveScope = scopeProp ?? { level: 'series' as ScopeLevel, id: seriesId! };

  const filterKey = [languages?.join(','), platforms?.join(',')].filter(Boolean).join('|');

  const { data, loading, error } = usePollingApi(
    () => {
      if (publicShortName) {
        return api.getPublicTimeSeries(publicShortName, {
          scope: effectiveScope.level,
          id: effectiveScope.id,
          interval,
          groupBy,
          languages,
          platforms,
        });
      }
      return seriesId
        ? api.getTimeSeries({
            scope: effectiveScope.level,
            id: effectiveScope.id,
            interval,
            groupBy,
            languages,
            platforms,
          })
        : Promise.resolve(null);
    },
    [effectiveScope.level, effectiveScope.id, interval, groupBy, publicShortName, filterKey],
    { intervalMs: 30_000 },
  );

  // ── Transform data for charts ──────────────────────────────────────────

  // Total mode: simple array with epoch timestamps
  const totalChartData = useMemo(() => {
    if (!data || viewMode !== 'total') return [];
    return (data.data as TimeSeriesBucket[]).map((d) => ({
      ts: new Date(d.timestamp).getTime(),
      ccv: d.totalCCV,
      channels: d.channelCount,
    }));
  }, [data, viewMode]);

  // Grouped mode: pivot data so each group key becomes a column
  const { groupedChartData, groupKeys } = useMemo(() => {
    if (!data || viewMode === 'total') return { groupedChartData: [] as Record<string, unknown>[], groupKeys: [] as string[] };

    const raw = data.data as GroupedTimeSeriesBucket[];
    const keys = [...new Set(raw.map((d) => d.groupKey))];

    // Pivot: { ts, [key1]: ccv, [key2]: ccv, ... }
    const byTime = new Map<number, Record<string, number>>();
    for (const d of raw) {
      const t = new Date(d.timestamp).getTime();
      if (!byTime.has(t)) {
        byTime.set(t, {});
      }
      const row = byTime.get(t)!;
      row[d.groupKey] = d.totalCCV;
    }

    const chartData: Record<string, unknown>[] = [...byTime.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, row]) => ({
        ts,
        ...row,
      }));

    return { groupedChartData: chartData, groupKeys: keys };
  }, [data, viewMode]);

  // ── Collect all data timestamps for snapping ───────────────────────────

  const allDataTs = useMemo(() => {
    const chartData = viewMode === 'total' ? totalChartData : groupedChartData;
    return chartData.map((d) => (d as { ts: number }).ts);
  }, [viewMode, totalChartData, groupedChartData]);

  // ── Compute day boundary markers (snapped to nearest data point) ──────

  const dayMarkers = useMemo((): DayMarker[] => {
    // Only show markers when viewing series or stage scope (multi-day)
    if (effectiveScope.level === 'day') return [];
    if (!broadcastDays || broadcastDays.length === 0) return [];
    if (allDataTs.length === 0) return [];

    const markers: DayMarker[] = [];
    for (const d of broadcastDays) {
      if (!d.broadcast_start) continue;
      const targetTs = new Date(d.broadcast_start).getTime();
      const snapped = snapToDataPoint(targetTs, allDataTs);
      if (snapped !== null) {
        markers.push({ ts: snapped, label: d.label });
      }
    }
    return markers;
  }, [broadcastDays, effectiveScope.level, allDataTs]);

  // Detect multi-day range for tick formatting
  const multiDay = useMemo(() => {
    if (allDataTs.length < 2) return false;
    return isMultiDay(allDataTs[0]!, allDataTs[allDataTs.length - 1]!);
  }, [allDataTs]);

  const tickFormatter = multiDay ? formatTickDateTime : formatTickTime;

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
        <TotalChart data={totalChartData} dayMarkers={dayMarkers} tickFormatter={tickFormatter} />
      ) : viewMode === 'platform' ? (
        <PlatformChart data={groupedChartData} keys={groupKeys} dayMarkers={dayMarkers} tickFormatter={tickFormatter} />
      ) : (
        <StackedLanguageChart data={groupedChartData} keys={groupKeys} dayMarkers={dayMarkers} tickFormatter={tickFormatter} />
      )}
    </Card>
  );
}

// ── Shared chart props ────────────────────────────────────────────────

interface ChartExtras {
  dayMarkers: DayMarker[];
  tickFormatter: (v: number) => string;
}

// ── Shared axis/tooltip/grid config ────────────────────────────────────

const TOOLTIP_STYLE = {
  contentStyle: { backgroundColor: '#141820', border: '1px solid #2A2F36', borderRadius: '8px', fontSize: '12px' },
  labelStyle: { color: '#9ca3af' },
};

function renderDayMarkers(markers: DayMarker[]) {
  return markers.map((m) => (
    <ReferenceLine
      key={m.ts}
      x={m.ts}
      stroke="#4b5563"
      strokeDasharray="4 4"
      label={{
        value: m.label,
        position: 'insideTopRight',
        fill: '#9ca3af',
        fontSize: 10,
        offset: 4,
      }}
    />
  ));
}

// ── Total CCV area chart ────────────────────────────────────────────────

function TotalChart({ data, dayMarkers, tickFormatter }: { data: Array<{ ts: number; ccv: number; channels: number }> } & ChartExtras) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 16, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="tsGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF154D" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#FF154D" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis
          dataKey="ts"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
          minTickGap={60}
        />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(v: number) => formatTooltipLabel(v)}
          formatter={(value: number, name: string) => [
            formatCompact(value),
            name === 'ccv' ? 'Total CCV' : 'Channels',
          ]}
        />
        {renderDayMarkers(dayMarkers)}
        <Area type="monotone" dataKey="ccv" stroke="#FF154D" strokeWidth={2} fill="url(#tsGradient)" name="ccv" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Platform overlaid lines ──────────────────────────────────────────────

function PlatformChart({ data, keys, dayMarkers, tickFormatter }: { data: Array<Record<string, unknown>>; keys: string[] } & ChartExtras) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 16, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis
          dataKey="ts"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
          minTickGap={60}
        />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(v: number) => formatTooltipLabel(v)}
          formatter={(value: number) => [formatCompact(value)]}
        />
        <Legend
          verticalAlign="top"
          iconType="circle"
          wrapperStyle={{ fontSize: '11px', color: '#9ca3af', paddingBottom: '8px' }}
          formatter={(value: string) => platformLabel(value)}
        />
        {renderDayMarkers(dayMarkers)}
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

function StackedLanguageChart({ data, keys, dayMarkers, tickFormatter }: { data: Array<Record<string, unknown>>; keys: string[] } & ChartExtras) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 16, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis
          dataKey="ts"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
          minTickGap={60}
        />
        <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(v: number) => formatTooltipLabel(v)}
          formatter={(value: number) => [formatCompact(value)]}
        />
        <Legend
          verticalAlign="top"
          iconType="circle"
          wrapperStyle={{ fontSize: '11px', color: '#9ca3af', paddingBottom: '8px' }}
          formatter={(value: string) => (value || 'Unknown').toUpperCase()}
        />
        {renderDayMarkers(dayMarkers)}
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
