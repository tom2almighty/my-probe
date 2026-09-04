import { cn } from "@/lib/utils";

/** 国旗图标（flag-icons）：iso country code → `<span class="fi fi-xx">` */
export function Flag({ code, className }: { code?: string; className?: string }) {
  const c = (code || "").toLowerCase().trim();
  return (
    <span
      className={cn(
        "fi",
        c && `fi-${c}`,
        "flag inline-block h-[1em] w-[1.33em] bg-contain bg-no-repeat bg-center",
        className,
      )}
      title={c}
    />
  );
}
