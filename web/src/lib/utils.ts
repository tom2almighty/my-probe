import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 格式化字节为可读字符串 */
export function fmtBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : digits)} ${units[u]}`;
}

/** 百分比展示 */
export function fmtPct(p: number): string {
  return `${Number.isFinite(p) ? p.toFixed(1) : "—"}%`;
}

/** unix 毫秒 → HH:mm:ss */
export function fmtClock(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

/** unix 毫秒 → MM-DD HH:mm */
export function fmtTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  return `${mm}-${dd} ${fmtClock(ts)}`;
}

/** 图表刻度：跨度超过一天时带上日期，否则只到分钟。 */
export function fmtAxis(ts: number, spanMs: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const hm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (spanMs > 36 * 3600_000) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return hm;
}

/** 延迟毫秒 → 展示 */
export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1) return "<1 ms";
  return `${Math.round(ms)} ms`;
}

/** 可用率 0-1 → 百分数 */
export function fmtOk(ok: number | null | undefined): string {
  if (ok == null) return "—";
  return `${(ok * 100).toFixed(1)}%`;
}

/** used / total → 百分比数值（total 为 0 时返回 0） */
export function pct(used: number, total: number): number {
  if (!total || !Number.isFinite(total) || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** 运行时长（秒）→ "12天 3小时" */
export function uptimeText(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/** unix 毫秒 → YYYY-MM-DD HH:mm */
export function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")} ${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

/** 今天起 N 天后的 YYYY-MM-DD（本地时区），用于日期输入框默认值 */
export function dateAfter(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}
