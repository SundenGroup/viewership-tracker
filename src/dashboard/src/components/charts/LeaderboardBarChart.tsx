import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatCompact, platformColor } from '@/utils/formatters';
import type { LeaderboardEntry } from '@/types/api';

interface LeaderboardBarChartProps {
  data: LeaderboardEntry[];
  height?: number;
  maxItems?: number;
  metric?: 'peakCCV' | 'avgCCV';
}

export function LeaderboardBarChart({
  data,
  height = 300,
  maxItems = 10,
  metric = 'peakCCV',
}: LeaderboardBarChartProps) {
  const chartData = data.slice(0, maxItems).map((d) => ({
    name: d.displayName.length > 14 ? d.displayName.slice(0, 14) + '...' : d.displayName,
    value: d[metric],
    platform: d.platform,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
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
          width={120}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#141820',
            border: '1px solid #2A2F36',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          labelStyle={{ color: '#9ca3af' }}
          itemStyle={{ color: '#e5e7eb' }}
          formatter={(value: number) => [formatCompact(value), metric === 'peakCCV' ? 'Peak CCV' : 'Avg CCV']}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {chartData.map((entry, i) => (
            <Cell key={i} fill={platformColor(entry.platform)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
