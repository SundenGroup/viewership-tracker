import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatCompact, formatChartTime } from '@/utils/formatters';

interface DataPoint {
  timestamp: string;
  totalCCV: number;
  channelCount: number;
}

interface CCVAreaChartProps {
  data: DataPoint[];
  height?: number;
  showChannelCount?: boolean;
}

export function CCVAreaChart({
  data,
  height = 300,
  showChannelCount = false,
}: CCVAreaChartProps) {
  const chartData = data.map((d) => ({
    time: formatChartTime(d.timestamp),
    ccv: d.totalCCV,
    channels: d.channelCount,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="ccvGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="channelGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
        <XAxis
          dataKey="time"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatCompact(v)}
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
          formatter={(value: number, name: string) => [
            formatCompact(value),
            name === 'ccv' ? 'Total CCV' : 'Channels',
          ]}
        />
        <Area
          type="monotone"
          dataKey="ccv"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#ccvGradient)"
          name="ccv"
        />
        {showChannelCount && (
          <Area
            type="monotone"
            dataKey="channels"
            stroke="#34d399"
            strokeWidth={1.5}
            fill="url(#channelGradient)"
            name="channels"
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
