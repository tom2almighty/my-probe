//! 延迟配色：阈值分段按探测目标配置，所有展示端都从这里取色。
//!
//! 语义分工（多节点对比图里尤其重要）：线色代表「哪台机器」，这里的色代表「快慢」。

import type { LatencyBand } from "@/lib/types";

/** 兜底配色，与后端 default_latency_bands 一致。 */
export const DEFAULT_BANDS: LatencyBand[] = [
  { max_ms: 100, color: "#22c55e" },
  { max_ms: 160, color: "#f59e0b" },
  { color: "#ef4444" },
];

/** 表单里的预设色：Tailwind 500 级，亮暗模式都能看清。 */
export const BAND_PRESETS = ["#22c55e", "#f59e0b", "#ef4444", "#3b82f6", "#8b5cf6", "#64748b"];

/** 分段数量上下限，与后端校验一致。 */
export const MIN_BANDS = 2;
export const MAX_BANDS = 5;

/** 延迟落在哪一段就取那段的颜色；无数据返回 null 由调用方决定灰色。 */
export function latencyColor(bands: LatencyBand[], ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const list = bands.length > 0 ? bands : DEFAULT_BANDS;
  for (const b of list) {
    // 最后一段没有 max_ms，兜住所有更慢的值
    if (b.max_ms == null || ms <= b.max_ms) return b.color;
  }
  return list[list.length - 1].color;
}

/** 目标自己的配色，没配就用传入的默认（通常来自后端的 bands 或全局默认）。 */
export function resolveBands(
  bands: LatencyBand[] | null | undefined,
  fallback: LatencyBand[] = DEFAULT_BANDS,
): LatencyBand[] {
  return bands && bands.length > 0 ? bands : fallback;
}

/**
 * 一组线路的公共配色：全部一致时返回它，否则返回 null。
 *
 * 多条线放在一张图里，只有大家的快慢阈值相同，背景色带才有唯一含义；
 * 阈值不同就别画背景，让快慢只体现在数字上，免得看图的人误读。
 */
export function commonBands(list: (LatencyBand[] | null | undefined)[]): LatencyBand[] | null {
  if (list.length === 0) return null;
  const first = resolveBands(list[0]);
  const same = (b: LatencyBand[]) =>
    b.length === first.length &&
    b.every((x, i) => x.color === first[i].color && (x.max_ms ?? null) === (first[i].max_ms ?? null));
  return list.every((b) => same(resolveBands(b))) ? first : null;
}

/** 保证最后一段没有上限：编辑器增删行之后调用，维持「末段兜底」的约定。 */
export function normalizeBands(bands: LatencyBand[]): LatencyBand[] {
  return bands.map((b, i) =>
    i === bands.length - 1 ? { color: b.color } : { max_ms: b.max_ms ?? null, color: b.color },
  );
}

/** 客户端预校验，口径与后端 `validate_bands` 一致；通过返回 null，否则返回提示文案。 */
export function validateBands(bands: LatencyBand[]): string | null {
  if (bands.length < MIN_BANDS || bands.length > MAX_BANDS) {
    return `延迟配色需要 ${MIN_BANDS}-${MAX_BANDS} 个分段`;
  }
  let prev = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (!/^#[0-9a-fA-F]{6}$/.test(b.color)) return `第 ${i + 1} 段颜色需要是 #rrggbb 格式`;
    if (i === bands.length - 1) {
      if (b.max_ms != null) return "最后一段不设上限，用于兜住更慢的延迟";
      continue;
    }
    if (b.max_ms == null) return `第 ${i + 1} 段需要填阈值`;
    if (!Number.isInteger(b.max_ms) || b.max_ms < 1 || b.max_ms > 60_000) {
      return `第 ${i + 1} 段阈值需在 1-60000 ms`;
    }
    if (b.max_ms <= prev) return "阈值需要从小到大递增";
    prev = b.max_ms;
  }
  return null;
}

/** 分段说明文案，如「<100 / 100-160 / >160 ms」，列表与表单预览共用。 */
export function bandsLabel(bands: LatencyBand[]): string {
  const list = resolveBands(bands);
  return list
    .map((b, i) => {
      const prev = i === 0 ? null : list[i - 1].max_ms;
      if (b.max_ms == null) return `>${prev ?? 0}`;
      return prev == null ? `<${b.max_ms}` : `${prev}-${b.max_ms}`;
    })
    .join(" / ")
    .concat(" ms");
}

/** 分段的 CSS 渐变（硬边界），用于表单示例色带。 */
export function bandsGradient(bands: LatencyBand[]): string {
  const list = resolveBands(bands);
  const top = list[list.length - 2]?.max_ms ?? 100;
  // 最后一段没有上限，用前一段阈值 * 1.5 撑出可见宽度
  const span = top * 1.5;
  const stops: string[] = [];
  let from = 0;
  list.forEach((b, i) => {
    const to = b.max_ms == null || i === list.length - 1 ? span : Math.min(b.max_ms, span);
    stops.push(`${b.color} ${(from / span) * 100}%`, `${b.color} ${(to / span) * 100}%`);
    from = to;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
