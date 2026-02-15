import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { platformLabel, platformColor } from '@/utils/formatters';
import type { BreakdownEntry } from '@/types/api';

interface PlatformPieChartProps {
  data: BreakdownEntry[];
  height?: number;
  metric?: 'totalCCV' | 'avgCCV' | 'peakCCV';
}

export function PlatformPieChart({
  data,
  height = 250,
  metric = 'totalCCV',
}: PlatformPieChartProps) {
  const chartData = data
    .filter((d) => d.platform ?? d.key)
    .map((d) => ({
      name: platformLabel(d.platform ?? d.key ?? ''),
      value: d[metric],
      color: platformColor(d.platform ?? d.key ?? ''),
    }));

  if (chartData.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        No platform data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
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
          itemStyle={{ color: '#e5e7eb' }}
        />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          wrapperStyle={{ fontSize: '12px', color: '#9ca3af' }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
