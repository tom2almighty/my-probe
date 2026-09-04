//! 通用多选指派弹窗：客户端选执行哪些探测，或探测选由哪些客户端执行。

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface PickOption {
  id: number;
  label: string;
  /** 名称下方的次要说明 */
  hint?: string;
  /** 左侧图标：国旗、协议标签等 */
  icon?: React.ReactNode;
  /** 右侧状态：在线 / 暂停等 */
  status?: React.ReactNode;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  options: PickOption[];
  /** 打开时的初始选中项 */
  selected: number[];
  emptyText?: string;
  onSubmit: (ids: number[]) => Promise<void>;
}

export function PickDialog({
  open,
  onOpenChange,
  title,
  description,
  options,
  selected,
  emptyText = "暂无可选项",
  onSubmit,
}: Props) {
  const [ids, setIds] = useState<number[]>(selected);
  const [saving, setSaving] = useState(false);

  // 打开的那一刻同步一次；父页面因实时数据重渲染时不打断正在勾选的用户。
  const latest = useRef(selected);
  useEffect(() => {
    latest.current = selected;
  });
  useEffect(() => {
    if (open) setIds(latest.current);
  }, [open]);

  const toggle = (id: number) => setIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async () => {
    setSaving(true);
    try {
      await onSubmit(ids);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {options.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">
                已选 {ids.length} / {options.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setIds(options.map((o) => o.id))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setIds([])}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1.5">
              {options.map((o) => {
                const on = ids.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggle(o.id)}
                    aria-pressed={on}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      on ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px] leading-none",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {on ? "✓" : ""}
                    </span>
                    {o.icon}
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{o.label}</span>
                      {o.hint && (
                        <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span>
                      )}
                    </span>
                    {o.status && <span className="ml-auto shrink-0 text-[11px]">{o.status}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={saving || options.length === 0} onClick={submit}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
