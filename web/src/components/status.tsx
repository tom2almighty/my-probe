//! 状态展示小组件：在线徽标、到期徽标、资源占用条、指标小格。

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { latencyColor } from "@/lib/latency";
import { fmtMoney } from "@/lib/money";
import { modeLabel, resetText, trafficText } from "@/lib/traffic";
import {
  type LatencyBand,
  type ProbeTargetStat,
  RENEW_CYCLE_LABELS,
  type RenewCycle,
  type Traffic,
} from "@/lib/types";
import { cn, fmtBytes, fmtLatency, fmtPct } from "@/lib/utils";

/** 在线 / 离线 */
export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <Badge variant={online ? "success" : "danger"}>
      <span className={cn("size-1.5 rounded-full", online ? "bg-emerald-500 animate-pulse" : "bg-red-500")} />
      {online ? "在线" : "离线"}
    </Badge>
  );
}

/** 到期倒计时：永久 / 已过期 / 临期 / 正常 */
export function ExpireBadge({
  days,
  date,
  neverExpire,
}: {
  days: number | null;
  date: string | null;
  /** 永不到期。和「没填日期」一样都是 days == null，靠这个标记区分出「永久」 */
  neverExpire?: boolean;
}) {
  if (neverExpire) {
    return <Badge variant="muted">永久</Badge>;
  }
  if (days == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const variant = days < 0 ? "danger" : days <= 7 ? "warning" : "muted";
  const text = days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `剩 ${days} 天`;
  return (
    <Badge variant={variant} title={date ?? undefined}>
      {text}
    </Badge>
  );
}

/** 续费信息：价格 + 周期。免费机器只标「免费」，不显示 0 元。 */
export function RenewInfo({
  price,
  cycle,
  currency,
}: {
  price: number;
  cycle: RenewCycle;
  currency: string;
}) {
  if (cycle === "free") {
    return <Badge variant="muted">免费</Badge>;
  }
  if (cycle === "none" || !price) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium">{fmtMoney(price, currency)}</span>
      <span className="ml-1 text-xs text-muted-foreground">/ {RENEW_CYCLE_LABELS[cycle]}</span>
    </span>
  );
}

/** 带标签的占用条 */
export function UsageBar({
  label,
  pct,
  detail,
  warnAt = 80,
}: {
  label: string;
  pct: number | null;
  detail?: string;
  warnAt?: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{pct == null ? "—" : fmtPct(pct)}</span>
      </div>
      <Progress value={pct ?? 0} warnAt={warnAt} />
      {detail && <div className="truncate text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** 本周期流量：设了限额就画占用条，不限额时只报用量。 */
export function TrafficBar({ traffic, label = "流量" }: { traffic: Traffic; label?: string }) {
  if (traffic.limit <= 0) {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium tabular-nums">{fmtBytes(traffic.used)}</span>
        </div>
        {/* 没有分母就没有进度条，用虚线占位，和相邻的占用条对齐 */}
        <div className="h-1.5 rounded-full border border-dashed" />
        <div className="truncate text-[11px] text-muted-foreground">不限额 · {modeLabel(traffic.mode)}</div>
      </div>
    );
  }
  const detail =
    traffic.next_reset == null ? trafficText(traffic) : `${trafficText(traffic)} · ${resetText(traffic)}`;
  return <UsageBar label={label} pct={traffic.pct} detail={detail} />;
}

/** 指标小格（概览 / 详情页顶部） */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneCls = {
    default: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  }[tone];
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums", toneCls)}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** 可用率着色文本 */
export function OkRate({ ok }: { ok: number | null }) {
  if (ok == null) return <span className="text-muted-foreground">—</span>;
  const pct = ok * 100;
  const cls =
    pct >= 99
      ? "text-emerald-600 dark:text-emerald-400"
      : pct >= 90
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  return <span className={cn("font-medium tabular-nums", cls)}>{pct.toFixed(1)}%</span>;
}

/** 某个探测在一台客户端上的现状：在线点 + 最近一次延迟 + 24h 可用率 */
export function ProbeTargetChip({
  target,
  bands,
  action,
}: {
  target: ProbeTargetStat;
  /** 该探测目标生效的延迟配色，用来给延迟数字上色 */
  bands: LatencyBand[];
  /** 尾部附加操作（如指派配色入口），可选 */
  action?: React.ReactNode;
}) {
  const color = target.last?.ok ? latencyColor(bands, target.last.latency_ms) : null;
  return (
    <div
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
      title={`24h 平均 ${fmtLatency(target.avg_latency_ms)}`}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", target.online ? "bg-emerald-500" : "bg-red-500")}
      />
      <span className="font-medium">{target.server_name}</span>
      {target.last ? (
        target.last.ok ? (
          <span className="tabular-nums" style={{ color: color ?? undefined }}>
            {fmtLatency(target.last.latency_ms)}
          </span>
        ) : (
          <span className="text-red-600 dark:text-red-400">丢包</span>
        )
      ) : (
        <span className="text-muted-foreground">等待上报</span>
      )}
      <OkRate ok={target.ok_24h} />
      {action}
    </div>
  );
}
