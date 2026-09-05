//! 图表组件：整机指标与延迟曲线、多线路对比，以及公开页 / 后台共用的时间范围切换。

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Flag } from "@/components/flag";
import { DEFAULT_BANDS, latencyColor, resolveBands } from "@/lib/latency";
import type { LatencyBand, MetricPoint, ProbePoint } from "@/lib/types";
import { cn, fmtAxis, fmtBytes, fmtLatency, fmtPct, fmtTime, pct } from "@/lib/utils";

/** 历史图表的时间范围。points 控制在后端 clamp 的上限（1000 点）之内。 */
export const METRIC_RANGES = [
  { key: "1h", label: "1 小时", ms: 3_600_000, points: 180 },
  { key: "6h", label: "6 小时", ms: 6 * 3_600_000, points: 240 },
  { key: "1d", label: "1 天", ms: 24 * 3_600_000, points: 288 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 3_600_000, points: 336 },
] as const;

export type RangeKey = (typeof METRIC_RANGES)[number]["key"];

/** 多线路对比用的固定色序，超出后循环取色、靠虚线区分。 */
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

/** 第 i 条线的颜色。下标固定绑定实体（节点 / 目标），取消勾选时其余线不换色。 */
export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

/** 超过一轮色序后改虚线，两条同色线也能分清。 */
export function seriesDash(i: number): string | undefined {
  const round = Math.floor(i / SERIES_COLORS.length);
  if (round === 0) return undefined;
  return round === 1 ? "5 3" : "2 2";
}

/** 时间范围切换，ranges 可以只给子集。 */
export function RangeTabs<K extends string>({
  value,
  onChange,
  ranges,
}: {
  value: K;
  onChange: (key: K) => void;
  ranges: readonly { key: K; label: string }[];
}) {
  return (
    <div className="flex rounded-md border p-0.5">
      {ranges.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            value === r.key
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** 图例条目。多节点对比时带上国旗，虚线序列的色块也画成虚线。 */
export interface LegendItem {
  label: string;
  color: string;
  /** 两位国家码，有值时在色块前补一个国旗 */
  country?: string;
  dashed?: boolean;
}

/** 图表分块：标题 + 图例，后台与公开页共用。 */
export function ChartBlock({
  title,
  legend,
  hint,
  children,
}: {
  title: string;
  legend: LegendItem[];
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{title}</span>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              {l.country && <Flag code={l.country} />}
              {l.dashed ? (
                <span className="w-3 border-t-2 border-dashed" style={{ borderColor: l.color }} />
              ) : (
                <span className="size-2 rounded-full" style={{ background: l.color }} />
              )}
              {l.label}
            </span>
          ))}
        </div>
        {hint && <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
export type Series = {
  key: string;
  label: string;
  color: string;
  unit?: "pct" | "bytes" | "abs";
  /** 聚合数据里的峰值字段；有值时额外画一条同色虚线。 */
  maxKey?: string;
};

/** 读取聚合点上的可选字段（峰值等）。 */
function num(row: object, key?: string): number | undefined {
  if (!key) return undefined;
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/** 提示框里的取值展示。 */
function fmtValue(v: number | null | undefined, unit?: Series["unit"]): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "pct") return fmtPct(v);
  if (unit === "bytes") return `${fmtBytes(v)}/s`;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(2);
}

/** 纵轴刻度：字节换成可读单位，百分比省掉小数。 */
function fmtTick(v: number, unit?: Series["unit"]): string {
  if (unit === "bytes") return fmtBytes(v, 0);
  if (unit === "pct") return String(Math.round(v));
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

/** 整机指标的三张标准图，后台详情页与公开节点页共用。 */
export const USAGE_SERIES: Series[] = [
  { key: "cpu", label: "CPU", color: "var(--chart-1)", unit: "pct", maxKey: "cpu_max" },
  { key: "mem_pct", label: "内存", color: "var(--chart-2)", unit: "pct" },
  { key: "disk_pct", label: "磁盘", color: "var(--chart-3)", unit: "pct" },
];

export const NET_SERIES: Series[] = [
  { key: "net_in", label: "下行", color: "var(--chart-4)", unit: "bytes", maxKey: "net_in_max" },
  { key: "net_out", label: "上行", color: "var(--chart-5)", unit: "bytes", maxKey: "net_out_max" },
];

export const LOAD_SERIES: Series[] = [
  { key: "load1", label: "1 分钟负载", color: "var(--chart-1)", unit: "abs", maxKey: "load1_max" },
];

export type ChartRow = MetricPoint & { mem_pct: number; disk_pct: number };

/** 补上内存 / 磁盘的百分比字段，占用率图直接用。 */
export function toChartRows(data: MetricPoint[] | undefined): ChartRow[] {
  return (data ?? []).map((p) => ({
    ...p,
    mem_pct: pct(p.mem_used, p.mem_total),
    disk_pct: pct(p.disk_used, p.disk_total),
  }));
}

interface MetricChartProps {
  data: MetricPoint[];
  series: Series[];
  height?: number;
  /** 时间跨度（ms），决定横轴刻度要不要带日期 */
  spanMs?: number;
}

/** 多序列时间线图（CPU / 内存 / 网络等）。聚合数据会顺带画出桶内峰值。 */
export function MetricChart({ data, series, height = 260, spanMs = 0 }: MetricChartProps) {
  if (!data.length) {
    return <EmptyChart />;
  }
  // 只有长范围的聚合结果才带峰值字段，原始点不画虚线
  const peaks = series.filter((s) => s.maxKey && data.some((d) => num(d, s.maxKey) != null));

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={(t: number) => fmtAxis(t, spanMs)}
            stroke="var(--border)"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            width={52}
            tickFormatter={(v: number) => fmtTick(v, series[0]?.unit)}
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
                  <div className="mb-2 font-medium text-muted-foreground">{fmtTime(Number(label))}</div>
                  {payload.map((p) => {
                    const key = String(p.dataKey);
                    const s = series.find((x) => x.key === key) ?? series.find((x) => x.maxKey === key);
                    return (
                      <div key={key} className="flex items-center gap-2 py-0.5">
                        <span className="size-2 rounded-full" style={{ background: String(p.color) }} />
                        <span className="text-muted-foreground">
                          {s?.label ?? key}
                          {s?.maxKey === key ? " 峰值" : ""}
                        </span>
                        <span className="ml-auto font-semibold">{fmtValue(p.value as number, s?.unit)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {peaks.map((s) => (
            <Line
              key={`${s.key}-peak`}
              type="monotone"
              dataKey={s.maxKey}
              stroke={s.color}
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.55}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
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

export function EmptyChart({ text = "暂无数据……等待 Agent 上报" }: { text?: string }) {
  return (
    <div className="flex h-52 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {text}
    </div>
  );
}

/** 单点丢包比例：聚合点用桶内比例，原始点成功 0 / 失败 1。 */
export function lossOf(p: ProbePoint): number {
  return p.loss ?? (p.ok ? 0 : 1);
}

/** 延迟统计：均值、极值、抖动与丢包率。 */
export interface ProbeStats {
  count: number;
  /** 有丢包的采样数（聚合数据里是出现过丢包的时段数） */
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
  const oks = rows.filter((p) => p.latency_ms != null).map((p) => p.latency_ms as number);
  let jitter: number | null = null;
  if (oks.length > 1) {
    let sum = 0;
    for (let i = 1; i < oks.length; i++) sum += Math.abs(oks[i] - oks[i - 1]);
    jitter = sum / (oks.length - 1);
  }
  // 最大值取桶内峰值（聚合数据）或样本本身，均值与最小值仍看主字段
  const peaks = rows.map((p) => p.latency_max ?? p.latency_ms).filter((v): v is number => v != null);
  const lossSum = rows.reduce((a, p) => a + lossOf(p), 0);
  return {
    count: rows.length,
    fails: rows.filter((p) => lossOf(p) > 0).length,
    loss: rows.length > 0 ? lossSum / rows.length : 0,
    last: rows.length > 0 ? rows[rows.length - 1] : null,
    avg: oks.length > 0 ? oks.reduce((a, b) => a + b, 0) / oks.length : null,
    min: oks.length > 0 ? Math.min(...oks) : null,
    max: peaks.length > 0 ? Math.max(...peaks) : null,
    jitter,
  };
}

/**
 * 最近若干次探测的条带图：一眼看出波动与丢包。
 * 柱高对应延迟，底色按该探测目标的阈值配色；丢包优先标红。
 */
export function LatencyStrip({
  data,
  max = 72,
  bands = DEFAULT_BANDS,
}: {
  data: ProbePoint[];
  max?: number;
  /** 该探测目标生效的阈值配色 */
  bands?: LatencyBand[];
}) {
  const rows = data.slice(-max);
  if (rows.length === 0) return null;
  const { max: peak } = probeStats(rows);
  return (
    <div className="flex h-8 items-end gap-px" aria-hidden>
      {rows.map((p) => {
        const loss = lossOf(p);
        const ms = p.latency_ms;
        const h = ms == null ? 100 : Math.max(12, (ms / (peak || 1)) * 100);
        // 丢包比“慢”更严重，先按丢包上色；其余交给阈值配色
        const tone = loss >= 1 ? "bg-red-500/80" : loss > 0 ? "bg-amber-500/80" : null;
        const color = latencyColor(bands, ms);
        const detail = loss >= 1 ? "丢包" : loss > 0 ? `丢包 ${(loss * 100).toFixed(0)}%` : "";
        return (
          <div
            key={p.ts}
            className={cn("min-w-[2px] flex-1 rounded-sm", tone ?? "bg-muted")}
            // 配色色块留一点透明，条带不至于太扎眼
            style={{ height: `${h}%`, background: tone ? undefined : (color ?? undefined) }}
            title={`${fmtTime(p.ts)} · ${fmtLatency(ms)}${detail ? ` · ${detail}` : ""}`}
          />
        );
      })}
    </div>
  );
}
/** 背景带够高就行；配 ifOverflow=hidden 裁剪，不会把 Y 轴撑大。 */
const BAND_TOP = 1_000_000;

/** 分段配色 → 背景带的 [下界, 上界)。最后一段没有上限，给一个足够大的值。 */
function bandAreas(bands: LatencyBand[]): { from: number; to: number; color: string }[] {
  const list = resolveBands(bands);
  let from = 0;
  return list.map((b) => {
    const to = b.max_ms ?? BAND_TOP;
    const area = { from, to, color: b.color };
    from = to;
    return area;
  });
}

/** 探测延迟折线：丢包处画红色色块并断开曲线，可切换平滑；聚合数据带峰值虚线。 */
export function ProbeChart({
  data,
  height = 200,
  smooth = false,
  spanMs = 0,
  bands = DEFAULT_BANDS,
}: {
  data: ProbePoint[];
  height?: number;
  smooth?: boolean;
  spanMs?: number;
  /** 阈值配色画成背景带；曲线保持中性色，颜色语义不打架 */
  bands?: LatencyBand[];
}) {
  if (!data.length) return <EmptyChart />;
  const rows = data.map((p) => ({
    ts: p.ts,
    latency: p.latency_ms,
    peak: p.latency_max ?? null,
    loss: lossOf(p),
  }));
  const hasPeak = rows.some((r) => r.peak != null);
  const { avg } = probeStats(data);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={(t: number) => fmtAxis(t, spanMs)}
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
          {/* 阈值配色画成背景带：ifOverflow=hidden 只裁剪不改 Y 轴范围；zIndex 压到网格线之下 */}
          {bandAreas(bands).map((b) => (
            <ReferenceArea
              key={b.from}
              yAxisId="ms"
              y1={b.from}
              y2={b.to}
              fill={b.color}
              fillOpacity={0.1}
              stroke="none"
              ifOverflow="hidden"
              zIndex={-150}
            />
          ))}
          {/* 丢包比例用色块标出，与延迟共用一张图 */}
          <YAxis yAxisId="loss" domain={[0, 1]} hide />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as { latency: number | null; peak: number | null; loss: number };
              return (
                <div className="rounded-lg border bg-background p-3 text-xs shadow-md">
                  <div className="mb-1 font-medium text-muted-foreground">{fmtTime(Number(label))}</div>
                  {row.loss >= 1 ? (
                    <div className="font-semibold text-red-600 dark:text-red-400">丢包 / 探测失败</div>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="font-semibold">{fmtLatency(row.latency)}</div>
                      {row.peak != null && (
                        <div className="text-muted-foreground">峰值 {fmtLatency(row.peak)}</div>
                      )}
                      {row.loss > 0 && (
                        <div className="text-red-600 dark:text-red-400">
                          丢包 {(row.loss * 100).toFixed(0)}%
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Area
            yAxisId="loss"
            type="stepAfter"
            dataKey="loss"
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
          {hasPeak && (
            <Line
              yAxisId="ms"
              type={smooth ? "monotone" : "linear"}
              dataKey="peak"
              stroke="var(--chart-2)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
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

/** 多线路对比里的一条曲线。 */
export interface LatencySeries {
  /** 同一张图里唯一的数据键 */
  key: string;
  label: string;
  color: string;
  /** 色序循环到第二轮以后用虚线区分，取自 seriesDash */
  dash?: string;
  rows: ProbePoint[];
}

/** 重采样后的一行：各线路的延迟均值 + 是否全线不通。 */
interface MultiRow {
  ts: number;
  down: number;
  [key: string]: number | null;
}
/**
 * 各探测的间隔不同、时间戳对不齐，先重采样到统一网格再画。
 * 桶内没有成功样本的线路留空（曲线断开），所有线路同时中断记为 down。
 */
function resample(series: LatencySeries[], from: number, to: number, buckets: number): MultiRow[] {
  const width = Math.max(1_000, Math.ceil((to - from) / Math.max(1, buckets)));
  const n = Math.max(1, Math.ceil((to - from) / width));
  const acc: Record<string, { sum: number; cnt: number }>[] = Array.from({ length: n }, () => ({}));
  for (const s of series) {
    for (const p of s.rows) {
      const i = Math.floor((p.ts - from) / width);
      if (i < 0 || i >= n) continue;
      acc[i][s.key] ??= { sum: 0, cnt: 0 };
      const cell = acc[i][s.key];
      if (p.latency_ms != null) {
        cell.sum += p.latency_ms;
        cell.cnt++;
      }
    }
  }
  const out: MultiRow[] = [];
  for (let i = 0; i < n; i++) {
    const keys = Object.keys(acc[i]);
    if (keys.length === 0) continue; // 这一段没有任何样本，不画
    const row: MultiRow = { ts: Math.round(from + (i + 0.5) * width), down: 0 };
    let mute = 0;
    for (const k of keys) {
      const c = acc[i][k];
      row[k] = c.cnt > 0 ? c.sum / c.cnt : null;
      if (c.cnt === 0) mute++;
    }
    row.down = mute === keys.length ? 1 : 0;
    out.push(row);
  }
  return out;
}

/** 多线路对比：一张图看多条延迟曲线（一台机器 × 多目标，或一个目标 × 多机器）。 */
export function LatencyMultiChart({
  series,
  from,
  to,
  buckets = 160,
  height = 220,
  smooth = true,
}: {
  series: LatencySeries[];
  from: number;
  to: number;
  buckets?: number;
  height?: number;
  /** 页面级对比图一直是平滑的；延迟面板里跟随「平滑」开关 */
  smooth?: boolean;
}) {
  const rows = useMemo(() => resample(series, from, to, buckets), [series, from, to, buckets]);
  if (rows.length === 0) return <EmptyChart />;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={(t: number) => fmtAxis(t, to - from)}
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
          {/* 全部线路同时不通时标出底色，多半是这台机器自己掉线 */}
          <YAxis yAxisId="down" domain={[0, 1]} hide />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const items = payload
                .filter((p) => p.dataKey !== "down")
                .map((p) => ({
                  key: String(p.dataKey),
                  label: series.find((s) => s.key === String(p.dataKey))?.label ?? String(p.dataKey),
                  color: String(p.color),
                  text: typeof p.value === "number" ? fmtLatency(p.value) : "丢包 / 无数据",
                }));
              return (
                <div className="rounded-lg border bg-background p-3 text-xs shadow-md">
                  <div className="mb-2 font-medium text-muted-foreground">{fmtTime(Number(label))}</div>
                  {items.map((it) => (
                    <div key={it.key} className="flex items-center gap-2 py-0.5">
                      <span className="size-2 rounded-full" style={{ background: it.color }} />
                      <span className="text-muted-foreground">{it.label}</span>
                      <span className="ml-auto font-semibold">{it.text}</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Area
            yAxisId="down"
            type="stepAfter"
            dataKey="down"
            stroke="none"
            fill="var(--destructive)"
            fillOpacity={0.14}
            isAnimationActive={false}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              yAxisId="ms"
              type={smooth ? "monotone" : "linear"}
              dataKey={s.key}
              stroke={s.color}
              strokeDasharray={s.dash}
              strokeWidth={1.6}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
