import { Area, AreaChart, ResponsiveContainer } from "recharts";

interface SparklineProps {
  data: { ts: number; v: number }[];
  color?: string;
  height?: number;
  className?: string;
}

/** 迷你面积图：用于卡片内的趋势展示 */
export function Sparkline({ data, color = "var(--chart-1)", height = 48, className }: SparklineProps) {
  if (!data.length) return null;
  return (
    <div className={className} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill="url(#spark)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
