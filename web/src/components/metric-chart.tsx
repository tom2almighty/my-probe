import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricPoint, ProbePoint } from "@/lib/types";
import { cn, fmtBytes, fmtClock, fmtLatency, fmtPct } from "@/lib/utils";

export type Series = { key: string; label: string; color: string; unit?: "pct" | "bytes" | "abs" };

interface MetricChartProps {
  data: MetricPoint[];
  series: Series[];
  height?: number;
}

/** 多序列时间线图（CPU / 内存 / 网络等） */
export function MetricChart({ data, series, height = 260 }: MetricChartProps) {
  if (!data.length) {
    return <EmptyChart />;
  }

  const formatValue = (v: number | null | undefined, unit?: string) => {
    if (v == null || !Number.isFinite(v)) return "—";
    if (unit === "pct") return fmtPct(v);
    if (unit === "bytes") return fmtBytes(v);
    return v >= 10 ? String(Math.round(v)) : v.toFixed(2);
  };

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={(t: number) => fmtClock(t)}
            stroke="var(--border)"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            width={52}
            stroke="var(--border)"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="rounded-lg border bg-background p-3 text-xs shadow-md">
                  <div className="mb-2 font-medium text-muted-foreground">{fmtClock(Number(label))}</div>
                  {payload.map((p) => {
                    const key = String(p.dataKey);
                    const s = series.find((x) => x.key === key);
                    return (
                      <div key={key} className="flex items-center gap-2 py-0.5">
                        <span className="size-2 rounded-full" style={{ background: String(p.color) }} />
                        <span className="text-muted-foreground">{s?.label ?? key}</span>
                        <span className="ml-auto font-semibold">
                          {formatValue(p.value as number, s?.unit)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={1.8}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function EmptyChart() {
  return (
    <div className="flex h-52 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      暂无数据……等待 Agent 上报
    </div>
  );
}

/** 延迟统计：均值、极值、抖动与丢包率。 */
export interface ProbeStats {
  count: number;
  fails: number;
  /** 丢包率 0-1 */
  loss: number;
  last: ProbePoint | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** 相邻两次成功探测的平均延迟差，越小越稳 */
  jitter: number | null;
}

export function probeStats(rows: ProbePoint[]): ProbeStats {
  const oks = rows.filter((p) => p.ok && p.latency_ms != null).map((p) => p.latency_ms as number);
  let jitter: number | null = null;
  if (oks.length > 1) {
    let sum = 0;
    for (let i = 1; i < oks.length; i++) sum += Math.abs(oks[i] - oks[i - 1]);
    jitter = sum / (oks.length - 1);
  }
  const fails = rows.filter((p) => !p.ok).length;
  return {
    count: rows.length,
    fails,
    loss: rows.length > 0 ? fails / rows.length : 0,
    last: rows.length > 0 ? rows[rows.length - 1] : null,
    avg: oks.length > 0 ? oks.reduce((a, b) => a + b, 0) / oks.length : null,
    min: oks.length > 0 ? Math.min(...oks) : null,
    max: oks.length > 0 ? Math.max(...oks) : null,
    jitter,
  };
}

/**
 * 最近若干次探测的条带图：一眼看出波动与丢包。
 * 柱高对应延迟、红色满格表示丢包。
 */
export function LatencyStrip({ data, max = 72 }: { data: ProbePoint[]; max?: number }) {
  const rows = data.slice(-max);
  if (rows.length === 0) return null;
  const oks = rows.filter((p) => p.ok && p.latency_ms != null).map((p) => p.latency_ms as number);
  const peak = oks.length > 0 ? Math.max(...oks) : 1;
  const avg = oks.length > 0 ? oks.reduce((a, b) => a + b, 0) / oks.length : 0;
  return (
    <div className="flex h-8 items-end gap-px" aria-hidden>
      {rows.map((p) => {
        const ms = p.latency_ms ?? 0;
        const h = p.ok ? Math.max(12, (ms / (peak || 1)) * 100) : 100;
        const tone = !p.ok ? "bg-red-500/80" : ms > avg * 2 ? "bg-amber-500/80" : "bg-emerald-500/70";
        return (
          <div
            key={p.ts}
            className={cn("min-w-[2px] flex-1 rounded-sm", tone)}
            style={{ height: `${h}%` }}
            title={`${fmtClock(p.ts)} · ${p.ok ? fmtLatency(p.latency_ms) : "丢包"}`}
          />
        );
      })}
    </div>
  );
}

/** 探测延迟折线：丢包处画红色色块并断开曲线，可切换平滑。 */
export function ProbeChart({
  data,
  height = 200,
  smooth = false,
}: {
  data: ProbePoint[];
  height?: number;
  smooth?: boolean;
}) {
  if (!data.length) return <EmptyChart />;
  const rows = data.map((p) => ({
    ts: p.ts,
    latency: p.ok ? p.latency_ms : null,
    ok: p.ok,
    fail: p.ok ? 0 : 1,
  }));
  const { avg } = probeStats(data);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={(t: number) => fmtClock(t)}
            stroke="var(--border)"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            yAxisId="ms"
            width={52}
            unit=" ms"
            stroke="var(--border)"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          {/* 丢包用满高色块标出，与延迟共用一张图 */}
          <YAxis yAxisId="loss" domain={[0, 1]} hide />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as { ok: boolean; latency: number | null };
              return (
                <div className="rounded-lg border bg-background p-3 text-xs shadow-md">
                  <div className="mb-1 font-medium text-muted-foreground">{fmtClock(Number(label))}</div>
                  {row.ok ? (
                    <div className="font-semibold">{fmtLatency(row.latency)}</div>
                  ) : (
                    <div className="font-semibold text-red-600 dark:text-red-400">丢包 / 探测失败</div>
                  )}
                </div>
              );
            }}
          />
          <Area
            yAxisId="loss"
            type="stepAfter"
            dataKey="fail"
            stroke="none"
            fill="var(--destructive)"
            fillOpacity={0.16}
            isAnimationActive={false}
          />
          {avg != null && (
            <ReferenceLine
              yAxisId="ms"
              y={avg}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
            />
          )}
          <Line
            yAxisId="ms"
            type={smooth ? "monotone" : "linear"}
            dataKey="latency"
            stroke="var(--chart-2)"
            strokeWidth={1.8}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
