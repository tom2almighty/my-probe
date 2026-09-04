import type * as React from "react";

import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number; // 0-100
  /** 达到该值显示警示色 */
  warnAt?: number;
}

/** 简单条形进度条：>warnAt 显示 amber，>crit 显示 red，否则 primary。 */
function Progress({ value = 0, warnAt = 80, className, ...props }: ProgressProps) {
  const v = Math.max(0, Math.min(100, value));
  const color =
    v >= (warnAt + 10 > 100 ? 90 : warnAt + 10)
      ? "bg-red-500"
      : v >= warnAt
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export { Progress };
