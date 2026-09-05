//! 探测目标新建 / 编辑弹窗（TCP 端口连通性 或 ICMP ping）。
//! 探测目标独立于服务器，这里同时选择由哪些客户端执行。

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { BandsEditor } from "@/components/bands-editor";
import { Flag } from "@/components/flag";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_BANDS, bandsGradient, bandsLabel, validateBands } from "@/lib/latency";
import type { LatencyBand, Probe, Protocol, Server } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ProbeFormValue {
  name: string;
  target: string;
  protocol: Protocol;
  port: number | null;
  timeout_ms: number;
  interval_s: number;
  enabled: boolean;
  /** 执行该探测的客户端 */
  server_ids: number[];
  /** null = 跟随全局默认配色 */
  latency_bands: LatencyBand[] | null;
}

/** 编辑时传入的探测目标（带已指派的客户端）。 */
export type EditingProbe = Probe & { server_ids?: number[] };

function initial(probe?: EditingProbe | null, defaults?: number[]): ProbeFormValue {
  return {
    name: probe?.name ?? "",
    target: probe?.target ?? "",
    protocol: probe?.protocol ?? "tcp",
    port: probe?.port ?? 443,
    timeout_ms: probe?.timeout_ms ?? 5000,
    interval_s: probe?.interval_s ?? 60,
    enabled: probe?.enabled ?? true,
    server_ids: probe?.server_ids ?? defaults ?? [],
    latency_bands: probe?.latency_bands ?? null,
  };
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 传入表示编辑，不传表示新建 */
  probe?: EditingProbe | null;
  /** 可选的客户端列表 */
  servers: Server[];
  /** 新建时默认勾选的客户端 */
  defaultServerIds?: number[];
  /** 全局默认配色，用于「跟随默认」时的预览与切自定义时的起始值 */
  defaultBands?: LatencyBand[];
  onSubmit: (v: ProbeFormValue) => Promise<void>;
}

export function ProbeFormDialog({
  open,
  onOpenChange,
  probe,
  servers,
  defaultServerIds,
  defaultBands = DEFAULT_BANDS,
  onSubmit,
}: Props) {
  const [v, setV] = useState<ProbeFormValue>(() => initial(probe, defaultServerIds));
  const [saving, setSaving] = useState(false);
  const editing = !!probe;
  const bandsId = `pf-bands-${useId()}`;

  // 只在弹窗打开的那一刻取初值：父页面每几秒因实时数据重渲染，不能把用户输入冲掉。
  const latest = useRef({ probe, defaultServerIds });
  useEffect(() => {
    latest.current = { probe, defaultServerIds };
  });
  useEffect(() => {
    if (open) setV(initial(latest.current.probe, latest.current.defaultServerIds));
  }, [open]);

  const set = <K extends keyof ProbeFormValue>(k: K, val: ProbeFormValue[K]) =>
    setV((s) => ({ ...s, [k]: val }));

  const toggleServer = (id: number) =>
    setV((s) => ({
      ...s,
      server_ids: s.server_ids.includes(id) ? s.server_ids.filter((x) => x !== id) : [...s.server_ids, id],
    }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.name.trim()) return toast.error("请填写探测名称");
    if (!v.target.trim()) return toast.error("请填写目标地址");
    if (v.protocol === "tcp" && (!v.port || v.port < 1 || v.port > 65535)) {
      return toast.error("TCP 探测需要 1-65535 的端口");
    }
    if (v.timeout_ms < 1 || v.timeout_ms > 60000) return toast.error("超时时间需在 1-60000 ms");
    if (v.interval_s < 1 || v.interval_s > 3600) return toast.error("探测间隔需在 1-3600 秒");
    if (v.latency_bands) {
      const bad = validateBands(v.latency_bands);
      if (bad) return toast.error(bad);
    }

    setSaving(true);
    try {
      await onSubmit({
        ...v,
        name: v.name.trim(),
        target: v.target.trim(),
        port: v.protocol === "tcp" ? v.port : null,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑探测目标" : "添加探测目标"}</DialogTitle>
          <DialogDescription>
            由选中的客户端定时发起，用于观察各机房到同一目标的连通性与延迟。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pf-name">名称</Label>
            <Input
              id="pf-name"
              value={v.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="到 Cloudflare"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label>协议</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["tcp", "TCP", "连接指定端口，测握手耗时"],
                  ["icmp", "ICMP", "标准 ping，需 Agent 具备 NET_RAW"],
                ] as [Protocol, string, string][]
              ).map(([p, title, desc]) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => set("protocol", p)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    v.protocol === p ? "border-primary bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="text-sm font-medium">{title}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pf-target">目标地址</Label>
              <Input
                id="pf-target"
                value={v.target}
                onChange={(e) => set("target", e.target.value)}
                placeholder="1.1.1.1 或 example.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-port">端口</Label>
              <Input
                id="pf-port"
                type="number"
                min={1}
                max={65535}
                disabled={v.protocol !== "tcp"}
                value={v.protocol === "tcp" ? (v.port ?? "") : ""}
                onChange={(e) => set("port", Number(e.target.value) || null)}
                placeholder={v.protocol === "tcp" ? "443" : "不适用"}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pf-interval">探测间隔（秒）</Label>
              <Input
                id="pf-interval"
                type="number"
                min={1}
                max={3600}
                value={v.interval_s}
                onChange={(e) => set("interval_s", Number(e.target.value) || 60)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-timeout">超时（毫秒）</Label>
              <Input
                id="pf-timeout"
                type="number"
                min={1}
                max={60000}
                step={100}
                value={v.timeout_ms}
                onChange={(e) => set("timeout_ms", Number(e.target.value) || 5000)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>执行客户端</Label>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">已选 {v.server_ids.length}</span>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() =>
                    set(
                      "server_ids",
                      servers.map((s) => s.id),
                    )
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => set("server_ids", [])}
                >
                  清空
                </button>
              </div>
            </div>
            {servers.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                还没有客户端，先在「服务器」里添加一台并部署 Agent
              </p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                {servers.map((s) => {
                  const on = v.server_ids.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleServer(s.id)}
                      aria-pressed={on}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
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
                      <Flag code={s.country} className="shrink-0" />
                      <span className="truncate">{s.name}</span>
                      <span
                        className={cn(
                          "ml-auto shrink-0 text-[11px]",
                          s.online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        {s.online ? "在线" : "离线"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {v.server_ids.length === 0
                ? "未选择客户端时探测不会真正执行，可稍后再指派"
                : "每个客户端各自独立探测，可在延迟曲线里逐一对比"}
            </p>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <Label htmlFor={bandsId}>延迟配色</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {v.latency_bands
                    ? "只对该目标生效，用于图表背景带与延迟数字"
                    : `跟随全局默认（${bandsLabel(defaultBands)}）`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch
                  id={bandsId}
                  checked={!!v.latency_bands}
                  onCheckedChange={(c) =>
                    set("latency_bands", c ? defaultBands.map((b) => ({ ...b })) : null)
                  }
                />
                <Label htmlFor={bandsId} className="cursor-pointer text-xs text-muted-foreground">
                  自定义
                </Label>
              </div>
            </div>
            {v.latency_bands ? (
              <BandsEditor value={v.latency_bands} onChange={(b) => set("latency_bands", b)} />
            ) : (
              <div className="h-2 rounded-full" style={{ background: bandsGradient(defaultBands) }} />
            )}
          </div>

          <div className="flex items-center gap-2 rounded-lg border p-3">
            <Switch checked={v.enabled} onCheckedChange={(c) => set("enabled", c)} />
            <span className="text-sm text-muted-foreground">
              {v.enabled ? "启用，Agent 会按间隔持续探测" : "已暂停，保留历史记录但不再探测"}
            </span>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
