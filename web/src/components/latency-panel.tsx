//! 延迟面板：客户端切换 + 时间范围 + 平滑曲线开关 + 抖动 / 丢包统计。
//! 后台与公开视图共用，区别只在传入的历史查询实现。

import { Spline } from "lucide-react";
import { useState } from "react";

import { LatencyStrip, ProbeChart, probeStats } from "@/components/metric-chart";
import { Button } from "@/components/ui/button";
import { useAsync } from "@/lib/hooks";
import type { ProbePoint } from "@/lib/types";
import { cn, fmtLatency, fmtTime } from "@/lib/utils";

const RANGES = [
  { key: "1h", label: "1 小时", ms: 3_600_000, points: 180 },
  { key: "6h", label: "6 小时", ms: 6 * 3_600_000, points: 240 },
  { key: "24h", label: "24 小时", ms: 24 * 3_600_000, points: 288 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

export interface LatencyTarget {
  server_id: number;
  server_name: string;
  online?: boolean;
}

interface Props {
  probeId: number;
  /** 执行该探测的客户端；多于一个时可切换 */
  targets: LatencyTarget[];
  /** 历史查询实现：后台传 api.probeHistory，公开视图传 api.publicProbeHistory */
  load: (pid: number, serverId: number, sinceMs: number, points: number) => Promise<ProbePoint[]>;
  /** 锁定客户端（服务器详情页已经在某台机器的上下文里） */
  lockedServerId?: number;
  height?: number;
}

export function LatencyPanel({ probeId, targets, load, lockedServerId, height = 200 }: Props) {
  const [range, setRange] = useState<RangeKey>("1h");
  const [smooth, setSmooth] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const cfg = RANGES.find((r) => r.key === range) ?? RANGES[0];
  const serverId = lockedServerId ?? picked ?? targets[0]?.server_id ?? null;

  const { data, loading } = useAsync<ProbePoint[]>(
    () => (serverId == null ? Promise.resolve([]) : load(probeId, serverId, Date.now() - cfg.ms, cfg.points)),
    [probeId, serverId, range],
  );

  const rows = data ?? [];
  const st = probeStats(rows);

  if (targets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center text-xs text-muted-foreground">
        该探测尚未指派客户端，指派后即可看到延迟曲线
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!lockedServerId && targets.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {targets.map((t) => (
              <button
                key={t.server_id}
                type="button"
                onClick={() => setPicked(t.server_id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                  serverId === t.server_id
                    ? "border-primary bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    t.online === false ? "bg-red-500" : "bg-emerald-500",
                  )}
                />
                {t.server_name}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium transition-colors",
                  range === r.key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant={smooth ? "secondary" : "outline"}
            className="h-8"
            aria-pressed={smooth}
            onClick={() => setSmooth((v) => !v)}
            title="在原始折线与平滑曲线之间切换"
          >
            <Spline className="size-4" /> 平滑曲线
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Stat
          label="当前"
          value={st.last ? (st.last.ok ? fmtLatency(st.last.latency_ms) : "丢包") : "—"}
          tone={st.last && !st.last.ok ? "danger" : "default"}
        />
        <Stat label="平均" value={fmtLatency(st.avg)} />
        <Stat label="最小" value={fmtLatency(st.min)} />
        <Stat
          label="最大"
          value={fmtLatency(st.max)}
          tone={st.max != null && st.max > 500 ? "warning" : "default"}
        />
        <Stat label="抖动" value={st.jitter == null ? "—" : `±${Math.round(st.jitter)} ms`} />
        <Stat
          label="丢包"
          value={st.count === 0 ? "—" : `${(st.loss * 100).toFixed(1)}%`}
          tone={st.loss > 0.02 ? "danger" : st.loss > 0 ? "warning" : "success"}
        />
      </div>

      <LatencyStrip data={rows} />

      <ProbeChart data={rows} height={height} smooth={smooth} />

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {loading ? <span>加载中…</span> : <span>{st.count} 条记录</span>}
        {st.fails > 0 && <span className="text-red-600 dark:text-red-400">{st.fails} 次失败</span>}
        {rows.length > 0 && <span className="ml-auto">{fmtTime(rows[0].ts)} 起</span>}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const cls = {
    default: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  }[tone];
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", cls)}>{value}</div>
    </div>
  );
}
