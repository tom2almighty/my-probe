//! 流量的换算与展示助手。周期边界按 UTC 计算，与主控保持一致。

import { type Traffic, TRAFFIC_MODE_LABELS, type TrafficMode } from "./types";
import { fmtBytes } from "./utils";

/** 限额输入的单位。一律按 1024 进制，和列表里的 GB/TB 显示口径一致。 */
export const TRAFFIC_UNITS = [
  { key: "GB", bytes: 1024 ** 3 },
  { key: "TB", bytes: 1024 ** 4 },
] as const;

export type TrafficUnit = (typeof TRAFFIC_UNITS)[number]["key"];

function unitBytes(unit: TrafficUnit): number {
  return TRAFFIC_UNITS.find((u) => u.key === unit)?.bytes ?? 1024 ** 3;
}

export function toBytes(value: number, unit: TrafficUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * unitBytes(unit));
}

/** 字节数 → 表单用的 (数值, 单位)：能整除 TB 的按 TB 显示，否则用 GB。 */
export function splitLimit(bytes: number): { value: number; unit: TrafficUnit } {
  if (bytes <= 0) return { value: 0, unit: "GB" };
  const tb = bytes / 1024 ** 4;
  if (bytes % 1024 ** 4 === 0 || tb >= 1) return { value: round2(tb), unit: "TB" };
  return { value: round2(bytes / 1024 ** 3), unit: "GB" };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 按计费口径折算已用量（与主控 `TrafficMode::used` 一致）。 */
export function usedBy(mode: TrafficMode, rx: number, tx: number): number {
  switch (mode) {
    case "up":
      return tx;
    case "down":
      return rx;
    case "max":
      return Math.max(rx, tx);
    default:
      return rx + tx;
  }
}

export function modeLabel(mode: TrafficMode): string {
  return TRAFFIC_MODE_LABELS[mode] ?? mode;
}

/** 「1.2 TB / 2 TB」；不限额时只给已用量。 */
export function trafficText(t: Traffic): string {
  return t.limit > 0 ? `${fmtBytes(t.used)} / ${fmtBytes(t.limit)}` : fmtBytes(t.used);
}

/** 距下次重置的文案；不重置时说明不重置。 */
export function resetText(t: Traffic): string {
  if (t.next_reset == null) return "不按周期重置";
  const ms = t.next_reset - Date.now();
  if (ms <= 0) return "即将重置";
  const hours = Math.ceil(ms / 3_600_000);
  return hours < 24 ? `距重置 ${hours} 小时` : `距重置 ${Math.ceil(ms / 86_400_000)} 天`;
}

/**
 * 用实时事件里的已用量覆盖快照。rx/tx 拆分在事件里拿不到，只更新总量与百分比。
 * 0 表示这条事件没带累计值（老 Agent 不上报），此时保持快照不动。
 */
export function withLiveUsed(t: Traffic, used: number | undefined): Traffic {
  if (!used) return t;
  return { ...t, used, pct: t.limit > 0 ? (used / t.limit) * 100 : null };
}

// ---- 周期边界（UTC），mock 与「下次重置」展示共用 ----

/** 某月的第 day 天 00:00 UTC；day 超出该月天数时落到最后一天。 */
function midnightUtc(year: number, month: number, day: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(Math.max(day, 1), last));
}

/** 当前计费周期起点（unix 毫秒）；`resetDay` 为 0 表示不分周期。 */
export function cycleStart(resetDay: number, now = Date.now()): number {
  if (resetDay <= 0) return 0;
  const d = new Date(now);
  const thisMonth = midnightUtc(d.getUTCFullYear(), d.getUTCMonth(), resetDay);
  return now >= thisMonth ? thisMonth : midnightUtc(d.getUTCFullYear(), d.getUTCMonth() - 1, resetDay);
}

/** 下次重置时刻（unix 毫秒）；不重置时为 null。 */
export function nextReset(resetDay: number, now = Date.now()): number | null {
  if (resetDay <= 0) return null;
  const d = new Date(now);
  const thisMonth = midnightUtc(d.getUTCFullYear(), d.getUTCMonth(), resetDay);
  return now < thisMonth ? thisMonth : midnightUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, resetDay);
}

/** 由限额设置 + 累计收发拼出视图（mock 用，对应主控的 `traffic_view`）。 */
export function makeTraffic(
  plan: { limit_bytes: number; mode: TrafficMode; reset_day: number },
  rx: number,
  tx: number,
): Traffic {
  const used = usedBy(plan.mode, rx, tx);
  return {
    rx,
    tx,
    used,
    limit: plan.limit_bytes,
    mode: plan.mode,
    reset_day: plan.reset_day,
    pct: plan.limit_bytes > 0 ? (used / plan.limit_bytes) * 100 : null,
    cycle_start: cycleStart(plan.reset_day),
    next_reset: nextReset(plan.reset_day),
  };
}
