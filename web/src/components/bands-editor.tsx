//! 延迟配色编辑器：2-5 个阈值分段，探测目标表单与「默认配色」弹窗共用。
//!
//! 只管编辑与预览，校验交给提交前的 `validateBands`，提示文案和后端一致。

import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BAND_PRESETS, MAX_BANDS, MIN_BANDS, bandsGradient, bandsLabel, normalizeBands } from "@/lib/latency";
import type { LatencyBand } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  value: LatencyBand[];
  onChange: (bands: LatencyBand[]) => void;
}

export function BandsEditor({ value, onChange }: Props) {
  const uid = useId();

  const patch = (i: number, next: Partial<LatencyBand>) =>
    onChange(normalizeBands(value.map((b, j) => (j === i ? { ...b, ...next } : b))));

  // 新分段插在末段之前：末段永远是那个不设上限的兜底段
  const add = () => {
    const prev = value[value.length - 2]?.max_ms ?? 0;
    const color = BAND_PRESETS.find((c) => !value.some((b) => b.color === c)) ?? BAND_PRESETS[0];
    const next = [...value];
    next.splice(value.length - 1, 0, { max_ms: prev + 100, color });
    onChange(normalizeBands(next));
  };

  const remove = (i: number) => onChange(normalizeBands(value.filter((_, j) => j !== i)));

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {value.map((b, i) => {
          const last = i === value.length - 1;
          const prev = i === 0 ? 0 : (value[i - 1].max_ms ?? 0);
          return (
            // 分段没有稳定 id，位置就是它的身份（顺序即语义）
            // biome-ignore lint/suspicious/noArrayIndexKey: 行的身份就是它的次序
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{last ? "更慢" : "≤"}</span>
              {last ? (
                <div className="flex h-9 flex-1 items-center rounded-md border border-dashed px-3 text-xs text-muted-foreground">
                  {prev} ms 以上
                </div>
              ) : (
                <div className="relative flex-1">
                  <Input
                    type="number"
                    min={1}
                    max={60000}
                    step={10}
                    aria-label={`第 ${i + 1} 段阈值（毫秒）`}
                    value={b.max_ms ?? ""}
                    onChange={(e) => patch(i, { max_ms: Number(e.target.value) || null })}
                    className="pr-9 tabular-nums"
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                    ms
                  </span>
                </div>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {BAND_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={`使用 ${c}`}
                    aria-pressed={b.color.toLowerCase() === c}
                    onClick={() => patch(i, { color: c })}
                    style={{ background: c }}
                    className={cn(
                      "size-5 rounded-[4px] border transition-transform hover:scale-110",
                      b.color.toLowerCase() === c
                        ? "border-foreground/60 ring-1 ring-foreground/30"
                        : "border-black/10",
                    )}
                  />
                ))}
                <input
                  type="color"
                  id={`${uid}-c${i}`}
                  aria-label={`第 ${i + 1} 段自定义颜色`}
                  title="自定义颜色"
                  value={b.color}
                  onChange={(e) => patch(i, { color: e.target.value })}
                  className="size-6 cursor-pointer rounded-[4px] border bg-transparent p-0.5"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                title={value.length <= MIN_BANDS ? `至少保留 ${MIN_BANDS} 个分段` : "删除该分段"}
                disabled={value.length <= MIN_BANDS}
                onClick={() => remove(i)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={value.length >= MAX_BANDS}
          title={value.length >= MAX_BANDS ? `最多 ${MAX_BANDS} 个分段` : undefined}
          onClick={add}
        >
          <Plus className="size-3.5" /> 添加分段
        </Button>
        <span className="text-[11px] text-muted-foreground">{bandsLabel(value)}</span>
      </div>

      {/* 实时预览：从快到慢的硬边界色带，和图表背景带是同一套颜色 */}
      <div className="h-2 rounded-full" style={{ background: bandsGradient(value) }} />
    </div>
  );
}
