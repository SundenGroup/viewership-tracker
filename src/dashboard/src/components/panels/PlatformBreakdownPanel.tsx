import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, LoadingOverlay } from '@/components/common';
import { formatNumber, formatCompact, formatPercent, platformLabel, platformColor } from '@/utils/formatters';
import type { LiveCCVResponse, MetricsResponse, ScopeLevel } from '@/types/api';

interface PlatformBreakdownPanelProps {
  liveCCV: LiveCCVResponse | null;
  metrics: MetricsResponse | null;
  scopeLevel: ScopeLevel;
  loading: boolean;
}

export function PlatformBreakdownPanel({ liveCCV, metrics, scopeLevel, loading }: PlatformBreakdownPanelProps) {
  const isLive = scopeLevel === 'series';

  if (loading && !liveCCV && !metrics) {
    return <Card title="Platform Breakdown"><LoadingOverlay /></Card>;
  }

  // Build chart data from either live CCV (series scope) or aggregate metrics (day/stage scope)
  let chartData: Array<{
    name: string;
    platform: string;
    ccv: number;
    channels: number;
    pct: number;
    color: string;
  }> = [];
  let grandTotal = 1;
  let centerLabel = '';
  let subtitle = '';

  if (isLive) {
    // Live mode: derive from liveCCV channels
    if (!liveCCV || liveCCV.channels.length === 0) {
      return (
        <Card title="Platform Breakdown">
          <p className="py-8 text-center text-sm text-gray-500">No platform data available.</p>
        </Card>
      );
    }

    const platformMap = new Map<string, { ccv: number; channels: number }>();
    for (const ch of liveCCV.channels) {
      const p = ch.platform ?? 'unknown';
      const existing = platformMap.get(p) ?? { ccv: 0, channels: 0 };
      existing.ccv += ch.concurrentViewers;
      existing.channels += 1;
      platformMap.set(p, existing);
    }

    grandTotal = liveCCV.totalCCV || 1;
    chartData = [...platformMap.entries()]
      .sort((a, b) => b[1].ccv - a[1].ccv)
      .map(([platform, { ccv, channels }]) => ({
        name: platformLabel(platform),
        platform,
        ccv,
        channels,
        pct: ccv / grandTotal,
        color: platformColor(platform),
      }));

    centerLabel = formatCompact(liveCCV.totalCCV);
    subtitle = 'Live CCV by platform';
  } else {
    // Aggregate mode: derive from metrics.platformBreakdown
    const breakdown = metrics?.platformBreakdown;
    if (!breakdown || breakdown.length === 0) {
      return (
        <Card title="Platform Breakdown">
          <p className="py-8 text-center text-sm text-gray-500">No platform data available.</p>
        </Card>
      );
    }

    grandTotal = breakdown.reduce((sum, e) => sum + e.avgCCV, 0) || 1;
    chartData = breakdown
      .sort((a, b) => b.avgCCV - a.avgCCV)
      .map((e) => ({
        name: platformLabel(e.platform ?? e.key ?? 'unknown'),
        platform: e.platform ?? e.key ?? 'unknown',
        ccv: e.avgCCV,
        channels: 0, // not available in aggregate
        pct: e.avgCCV / grandTotal,
        color: platformColor(e.platform ?? e.key ?? 'unknown'),
      }));

    centerLabel = formatCompact(grandTotal);
    subtitle = 'Avg CCV by platform';
  }

  return (
    <Card title="Platform Breakdown" subtitle={subtitle} collapsible storageKey="cvt:panel:platformBreakdown">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Donut Chart */}
        <ResponsiveContainer width="100%" height={230}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="ccv"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={85}
              paddingAngle={2}
              strokeWidth={0}
            >
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: '#141820',
                border: '1px solid #2A2F36',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              formatter={(value: number, name: string) => [
                `${formatNumber(value)} (${formatPercent(value / grandTotal)})`,
                name,
              ]}
            />
            {/* Center label */}
            <text
              x="50%"
              y="46%"
              textAnchor="middle"
              className="fill-gray-200 text-xl font-bold"
              style={{ fontSize: '20px', fontWeight: 700 }}
            >
              {centerLabel}
            </text>
            <text
              x="50%"
              y="58%"
              textAnchor="middle"
              className="fill-gray-500 text-[10px]"
              style={{ fontSize: '10px' }}
            >
              {isLive ? 'Total CCV' : 'Avg CCV'}
            </text>
          </PieChart>
        </ResponsiveContainer>

        {/* Legend */}
        <div className="flex flex-col justify-center space-y-2">
          {chartData.map((entry) => (
            <div
              key={entry.platform}
              className="flex items-center justify-between rounded-lg bg-navy-800/60 px-3 py-2"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <div>
                  <div className="text-sm font-medium text-gray-200">
                    {entry.name}
                  </div>
                  {entry.channels > 0 && (
                    <div className="text-[10px] text-gray-500">
                      {entry.channels} channel{entry.channels !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-medium text-gray-200">
                  {formatCompact(entry.ccv)}
                </div>
                <div className="text-[10px] text-gray-500">
                  {formatPercent(entry.pct)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
