//! 延迟面板：节点多选对比 + 时间范围 + 平滑开关 + 抖动 / 丢包统计。
//! 后台与公开视图共用，区别只在传入的历史查询实现。

import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import {
  ChartBlock,
  type LatencySeries,
  LatencyMultiChart,
  LatencyStrip,
  type LegendItem,
  METRIC_RANGES,
  ProbeChart,
  type ProbeStats,
  type RangeKey,
  RangeTabs,
  probeStats,
  seriesColor,
  seriesDash,
} from "@/components/metric-chart";
import { OkRate } from "@/components/status";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAsync, usePersistedFlag } from "@/lib/hooks";
import { DEFAULT_BANDS, latencyColor } from "@/lib/latency";
import type { LatencyBand, ProbePoint } from "@/lib/types";
import { cn, fmtLatency, fmtTime } from "@/lib/utils";

export interface LatencyTarget {
  server_id: number;
  server_name: string;
  online?: boolean;
  /** 两位国家码，用于图例里的国旗 */
  country?: string;
  /** 最近 24h 可用率，多节点对比表直接展示 */
  ok_24h?: number | null;
}

/** 同屏对比的节点上限：线再多就糊成一团，也不想一次发十几个请求。 */
const MAX_COMPARE = 8;
/** 没手动勾选过时默认选中的节点数 */
const DEFAULT_PICK = 5;

interface Props {
  probeId: number;
  /** 执行该探测的客户端；多于一个时可勾选对比 */
  targets: LatencyTarget[];
  /** 历史查询实现：后台传 api.probeHistory，公开视图传 api.publicProbeHistory */
  load: (pid: number, serverId: number, sinceMs: number, points: number) => Promise<ProbePoint[]>;
  /** 锁定客户端（服务器详情页已经在某台机器的上下文里） */
  lockedServerId?: number;
  /** 由页面统一控制时间范围时传入，此时面板里不再显示范围切换 */
  span?: { ms: number; points: number };
  /** 该探测目标生效的延迟配色（后端已回退过全局默认） */
  bands?: LatencyBand[];
  height?: number;
}

/** 一次并发拉取的结果，连同这批数据的时间窗 —— 多线图重采样要用。 */
interface Fetched {
  from: number;
  to: number;
  rows: ProbePoint[][];
}

/** 参与对比的一个节点：固定色 + 该节点的曲线。 */
interface CompareRow {
  target: LatencyTarget;
  color: string;
  dash?: string;
  rows: ProbePoint[];
}

export function LatencyPanel({
  probeId,
  targets,
  load,
  lockedServerId,
  span,
  bands = DEFAULT_BANDS,
  height = 200,
}: Props) {
  const [range, setRange] = useState<RangeKey>("1h");
  // 平滑是全局偏好：同屏多个面板与刷新之后保持一致
  const [smooth, setSmooth] = usePersistedFlag("myprobe.chart.smooth", false);
  // null = 还没手动勾选过，用默认选择
  const [selected, setSelected] = useState<number[] | null>(null);
  const smoothId = `smooth-${useId()}`;
  const cfg = span ?? METRIC_RANGES.find((r) => r.key === range) ?? METRIC_RANGES[0];

  // 默认选择：节点不多就全选，多了只取按名称排序的前几个，避免首屏发十几个请求
  const fallbackIds = useMemo(
    () =>
      [...targets]
        .sort((a, b) => a.server_name.localeCompare(b.server_name, "zh-Hans-CN"))
        .slice(0, DEFAULT_PICK)
        .map((t) => t.server_id),
    [targets],
  );

  // 勾选集按 targets 顺序整理，并剔除已经不在指派列表里的节点；至少留一个
  const picked = useMemo(() => {
    const want = new Set(selected ?? fallbackIds);
    const ids = targets.filter((t) => want.has(t.server_id)).map((t) => t.server_id);
    return ids.length > 0 ? ids : targets.slice(0, 1).map((t) => t.server_id);
  }, [selected, fallbackIds, targets]);

  const activeIds = useMemo(
    () => (lockedServerId == null ? picked : [lockedServerId]),
    [lockedServerId, picked],
  );
  // useAsync 的依赖只能放原始值，数组每次渲染都是新对象会导致反复请求
  const idKey = activeIds.join(",");

  const { data, loading } = useAsync<Fetched>(async () => {
    const to = Date.now();
    const from = to - cfg.ms;
    const rows = await Promise.all(activeIds.map((sid) => load(probeId, sid, from, cfg.points)));
    return { from, to, rows };
  }, [probeId, idKey, cfg.ms, cfg.points]);

  // 取色按节点在 targets 里的固定下标：取消勾选某个节点，其余线不会跟着换色
  const compare = useMemo<CompareRow[]>(
    () =>
      activeIds.map((sid, i) => {
        const at = targets.findIndex((t) => t.server_id === sid);
        const idx = at < 0 ? i : at;
        return {
          target: targets[at] ?? { server_id: sid, server_name: `#${sid}` },
          color: seriesColor(idx),
          dash: seriesDash(idx),
          rows: data?.rows[i] ?? [],
        };
      }),
    [activeIds, targets, data],
  );

  const series = useMemo<LatencySeries[]>(
    () =>
      compare.map((c) => ({
        key: `s${c.target.server_id}`,
        label: c.target.server_name,
        color: c.color,
        dash: c.dash,
        rows: c.rows,
      })),
    [compare],
  );

  const legend = useMemo<LegendItem[]>(
    () =>
      compare.map((c) => ({
        label: c.target.server_name,
        color: c.color,
        country: c.target.country,
        dashed: !!c.dash,
      })),
    [compare],
  );

  const toggle = (sid: number) => {
    if (activeIds.includes(sid)) {
      if (activeIds.length === 1) return; // 至少留一个节点，点掉最后一个忽略
      setSelected(activeIds.filter((x) => x !== sid));
      return;
    }
    if (activeIds.length >= MAX_COMPARE) {
      toast.info(`最多同时对比 ${MAX_COMPARE} 个节点`);
      return;
    }
    setSelected([...activeIds, sid]);
  };

  const pickAll = () => {
    const ids = targets.map((t) => t.server_id);
    if (ids.length > MAX_COMPARE) toast.info(`最多同时对比 ${MAX_COMPARE} 个节点，已取前 ${MAX_COMPARE} 个`);
    setSelected(ids.slice(0, MAX_COMPARE));
  };

  const invert = () => {
    const ids = targets.filter((t) => !activeIds.includes(t.server_id)).map((t) => t.server_id);
    if (ids.length === 0) return; // 已经全选，反选会清空，忽略
    setSelected(ids.slice(0, MAX_COMPARE));
  };

  if (targets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center text-xs text-muted-foreground">
        该探测尚未指派客户端，指派后即可看到延迟曲线
      </div>
    );
  }

  const multi = compare.length > 1;
  const rows = compare[0]?.rows ?? [];
  const st = probeStats(rows);
  const total = compare.reduce((a, c) => a + c.rows.length, 0);
  const firstTs = Math.min(...compare.map((c) => c.rows[0]?.ts ?? Number.POSITIVE_INFINITY));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!lockedServerId && targets.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            {targets.map((t, i) => {
              const on = activeIds.includes(t.server_id);
              const full = !on && activeIds.length >= MAX_COMPARE;
              return (
                <label
                  key={t.server_id}
                  title={
                    full
                      ? `最多同时对比 ${MAX_COMPARE} 个节点`
                      : t.online === false
                        ? `${t.server_name}：离线，曲线停在最后一次上报`
                        : t.server_name
                  }
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
                    "transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    on
                      ? "border-primary/60 bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                    full && "opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => toggle(t.server_id)}
                  />
                  {/* 勾选态填的是这条线的颜色，色块本身就是图例 */}
                  <span
                    className={cn(
                      "size-3 shrink-0 rounded-[3px] border",
                      on ? "border-transparent" : "border-input",
                    )}
                    style={on ? { background: seriesColor(i) } : undefined}
                  />
                  {t.country && <Flag code={t.country} />}
                  {t.server_name}
                  {t.online === false && <span className="size-1.5 shrink-0 rounded-full bg-red-500" />}
                </label>
              );
            })}
            <div className="flex items-center gap-2 pl-1 text-[11px]">
              <button
                type="button"
                onClick={pickAll}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                全选
              </button>
              <button
                type="button"
                onClick={invert}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                反选
              </button>
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!span && <RangeTabs value={range} onChange={setRange} ranges={METRIC_RANGES} />}
          <div className="flex items-center gap-1.5" title="在原始折线与平滑曲线之间切换">
            <Switch id={smoothId} checked={smooth} onCheckedChange={setSmooth} />
            <Label htmlFor={smoothId} className="cursor-pointer text-xs text-muted-foreground">
              平滑
            </Label>
          </div>
        </div>
      </div>

      {multi ? (
        <>
          <ChartBlock title="节点对比" legend={legend} hint="灰底表示所有节点同时不通">
            <LatencyMultiChart
              series={series}
              from={data?.from ?? Date.now() - cfg.ms}
              to={data?.to ?? Date.now()}
              height={height + 20}
              smooth={smooth}
            />
          </ChartBlock>
          <CompareTable rows={compare} bands={bands} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat
              label="当前"
              value={st.last ? (st.last.ok ? fmtLatency(st.last.latency_ms) : "丢包") : "—"}
              tone={st.last && !st.last.ok ? "danger" : "default"}
              color={st.last?.ok ? latencyColor(bands, st.last.latency_ms) : null}
            />
            <Stat label="平均" value={fmtLatency(st.avg)} color={latencyColor(bands, st.avg)} />
            <Stat label="最小" value={fmtLatency(st.min)} />
            <Stat label="最大" value={fmtLatency(st.max)} color={latencyColor(bands, st.max)} />
            <Stat label="抖动" value={st.jitter == null ? "—" : `±${Math.round(st.jitter)} ms`} />
            <Stat
              label="丢包"
              value={st.count === 0 ? "—" : `${(st.loss * 100).toFixed(1)}%`}
              tone={st.loss > 0.02 ? "danger" : st.loss > 0 ? "warning" : "success"}
            />
          </div>

          <LatencyStrip data={rows} bands={bands} />

          <ProbeChart data={rows} height={height} smooth={smooth} spanMs={cfg.ms} bands={bands} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {loading ? <span>加载中…</span> : <span>{total} 条记录</span>}
        {!multi && st.fails > 0 && (
          <span className="text-red-600 dark:text-red-400">{st.fails} 个采样点有丢包</span>
        )}
        {Number.isFinite(firstTs) && <span className="ml-auto">{fmtTime(firstTs)} 起</span>}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  color,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger";
  /** 阈值配色；只在没有其他语义色（tone=default）时生效 */
  color?: string | null;
}) {
  const cls = {
    default: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  }[tone];
  const banded = tone === "default" && color ? color : undefined;
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", cls)} style={{ color: banded }}>
        {value}
      </div>
    </div>
  );
}

/** 丢包率的文字色，和单节点那一格的口径保持一致。 */
function lossTone(st: ProbeStats): string {
  if (st.count === 0) return "text-muted-foreground";
  if (st.loss > 0.02) return "text-red-600 dark:text-red-400";
  if (st.loss > 0) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/** 多节点对比时的逐节点指标表：一行一个节点，口径与单节点的六格一致。 */
function CompareTable({ rows, bands }: { rows: CompareRow[]; bands: LatencyBand[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-[11px] text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">节点</th>
            <th className="px-2 py-1.5 text-right font-medium">当前</th>
            <th className="px-2 py-1.5 text-right font-medium">平均</th>
            <th className="px-2 py-1.5 text-right font-medium">最大</th>
            <th className="px-2 py-1.5 text-right font-medium">抖动</th>
            <th className="px-2 py-1.5 text-right font-medium">丢包</th>
            <th className="px-2 py-1.5 text-right font-medium">24h 可用</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const st = probeStats(c.rows);
            return (
              <tr key={c.target.server_id} className="border-t">
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    {/* 线样式与图里那条线一致，表和图靠这个对上号 */}
                    <span
                      className="w-3 shrink-0 border-t-2"
                      style={{ borderColor: c.color, borderStyle: c.dash ? "dashed" : "solid" }}
                    />
                    {c.target.country && <Flag code={c.target.country} />}
                    <span className="truncate">{c.target.server_name}</span>
                    {c.target.online === false && (
                      <span className="size-1.5 shrink-0 rounded-full bg-red-500" title="离线" />
                    )}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {st.last == null ? (
                    "—"
                  ) : st.last.ok ? (
                    <span style={{ color: latencyColor(bands, st.last.latency_ms) ?? undefined }}>
                      {fmtLatency(st.last.latency_ms)}
                    </span>
                  ) : (
                    <span className="text-red-600 dark:text-red-400">丢包</span>
                  )}
                </td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  style={{ color: latencyColor(bands, st.avg) ?? undefined }}
                >
                  {fmtLatency(st.avg)}
                </td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  style={{ color: latencyColor(bands, st.max) ?? undefined }}
                >
                  {fmtLatency(st.max)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {st.jitter == null ? "—" : `±${Math.round(st.jitter)} ms`}
                </td>
                <td className={cn("px-2 py-1.5 text-right tabular-nums", lossTone(st))}>
                  {st.count === 0 ? "—" : `${(st.loss * 100).toFixed(1)}%`}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <OkRate ok={c.target.ok_24h ?? null} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
