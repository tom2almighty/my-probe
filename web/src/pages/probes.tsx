//! 延迟探测页：探测目标独立于服务器，这里集中管理并指派执行的客户端。

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";

import { BandsEditor } from "@/components/bands-editor";
import { Flag } from "@/components/flag";
import { LatencyPanel } from "@/components/latency-panel";
import { PickDialog, type PickOption } from "@/components/pick-dialog";
import { type EditingProbe, ProbeFormDialog, type ProbeFormValue } from "@/components/probe-form";
import { ProbeTargetChip } from "@/components/status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, useErrorHandler, useUiEvents } from "@/lib/hooks";
import { DEFAULT_BANDS, validateBands } from "@/lib/latency";
import type { LatencyBand, ProbeItem, Server } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "enabled" | "paused";

export default function ProbesPage() {
  const { data, loading, reload, setData } = useAsync<ProbeItem[]>(() => api.probes(), []);
  const servers = useAsync<Server[]>(() => api.servers(), []);
  const bands = useAsync<LatencyBand[]>(() => api.latencyBands(), []);
  const onError = useErrorHandler();

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [bandsOpen, setBandsOpen] = useState(false);
  const [editing, setEditing] = useState<EditingProbe | null>(null);
  const [assigning, setAssigning] = useState<ProbeItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProbeItem | null>(null);

  useUiEvents((e) => {
    if (e.type === "probe") {
      setData((list) =>
        list?.map((p) =>
          p.id === e.probe_id
            ? {
                ...p,
                targets: p.targets.map((t) =>
                  t.server_id === e.server_id
                    ? { ...t, last: { ts: e.ts, ok: e.ok, latency_ms: e.latency_ms } }
                    : t,
                ),
              }
            : p,
        ),
      );
    } else if (e.type === "server_status") {
      setData((list) =>
        list?.map((p) => ({
          ...p,
          targets: p.targets.map((t) => (t.server_id === e.id ? { ...t, online: e.online } : t)),
        })),
      );
    } else if (e.type === "servers_changed") {
      reload();
      servers.reload();
    }
  });

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data ?? []).filter((p) => {
      if (filter === "enabled" && !p.enabled) return false;
      if (filter === "paused" && p.enabled) return false;
      if (!kw) return true;
      return (
        p.name.toLowerCase().includes(kw) ||
        p.target.toLowerCase().includes(kw) ||
        p.targets.some((t) => t.server_name.toLowerCase().includes(kw))
      );
    });
  }, [data, q, filter]);

  /** 有多少台客户端在跑探测 */
  const busyServers = useMemo(() => {
    const ids = new Set<number>();
    for (const p of data ?? []) {
      if (p.enabled) for (const id of p.server_ids) ids.add(id);
    }
    return ids.size;
  }, [data]);

  const serverOptions = useMemo<PickOption[]>(
    () =>
      (servers.data ?? []).map((s) => ({
        id: s.id,
        label: s.name,
        hint: countryName(s.country),
        icon: <Flag code={s.country} className="shrink-0" />,
        status: (
          <span className={s.online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
            {s.online ? "在线" : "离线"}
          </span>
        ),
      })),
    [servers.data],
  );

  const save = async (v: ProbeFormValue) => {
    try {
      if (editing) {
        await api.updateProbe(editing.id, v);
        toast.success("已保存");
      } else {
        await api.createProbe(v);
        toast.success(
          v.server_ids.length > 0
            ? `已添加，由 ${v.server_ids.length} 台客户端执行`
            : "已添加，稍后指派客户端即可开始探测",
        );
      }
      reload();
    } catch (e) {
      onError(e, "保存失败");
      throw e;
    }
  };

  const saveAssign = async (ids: number[]) => {
    if (!assigning) return;
    try {
      await api.assignProbeServers(assigning.id, ids);
      toast.success(ids.length > 0 ? `已指派 ${ids.length} 台客户端` : "已取消所有客户端");
      reload();
    } catch (e) {
      onError(e, "指派失败");
      throw e;
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteProbe(pendingDelete.id);
      toast.success(`已删除「${pendingDelete.name}」`);
      reload();
    } catch (e) {
      onError(e, "删除失败");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">延迟探测</h1>
          <p className="text-sm text-muted-foreground">
            共 {data?.length ?? 0} 个目标，{busyServers} 台客户端在执行
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setBandsOpen(true)}>
          <Palette className="size-4" /> 默认配色
        </Button>
        <Button variant="outline" size="icon" title="刷新" onClick={reload}>
          <RefreshCw className="size-4" />
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="size-4" /> 添加探测
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 目标 / 客户端"
            className="pl-8"
          />
        </div>
        <div className="flex rounded-md border p-0.5">
          {(
            [
              ["all", "全部"],
              ["enabled", "启用"],
              ["paused", "暂停"],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                filter === k
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
            {loading ? (
              "加载中…"
            ) : q || filter !== "all" ? (
              "没有匹配的探测目标"
            ) : (
              <>
                <Waypoints className="size-6" />
                还没有探测目标，点右上角「添加探测」并勾选执行的客户端
              </>
            )}
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <ProbeCard
              key={p.id}
              probe={p}
              open={expanded === p.id}
              onToggle={() => setExpanded((v) => (v === p.id ? null : p.id))}
              onEdit={() => {
                setEditing(p);
                setFormOpen(true);
              }}
              onAssign={() => setAssigning(p)}
              onDelete={() => setPendingDelete(p)}
            />
          ))}
        </div>
      )}

      <ProbeFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        probe={editing}
        servers={servers.data ?? []}
        defaultBands={bands.data ?? DEFAULT_BANDS}
        onSubmit={save}
      />

      <DefaultBandsDialog
        open={bandsOpen}
        onOpenChange={setBandsOpen}
        value={bands.data ?? DEFAULT_BANDS}
        onSaved={() => {
          bands.reload();
          reload();
        }}
      />

      <PickDialog
        open={!!assigning}
        onOpenChange={(v) => !v && setAssigning(null)}
        title={`由哪些客户端探测「${assigning?.name}」`}
        description="每台客户端各自独立探测同一目标，方便对比不同机房的链路质量"
        options={serverOptions}
        selected={assigning?.server_ids ?? []}
        emptyText="还没有客户端，先在「服务器」里添加一台"
        onSubmit={saveAssign}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingDelete?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该目标会从所有客户端上移除，历史探测记录一并删除，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={doDelete}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProbeCard({
  probe,
  open,
  onToggle,
  onEdit,
  onAssign,
  onDelete,
}: {
  probe: ProbeItem;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onDelete: () => void;
}) {
  const target = probe.protocol === "tcp" && probe.port ? `${probe.target}:${probe.port}` : probe.target;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="展开延迟曲线"
            onClick={onToggle}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{probe.name}</span>
              <Badge variant="outline" className="font-mono uppercase">
                {probe.protocol}
              </Badge>
              {!probe.enabled && <Badge variant="muted">暂停</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <span className="font-mono">{target}</span>
              <span>
                每 {probe.interval_s}s · {probe.timeout_ms}ms 超时
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={onAssign}>
              <Users className="size-4" /> 客户端 {probe.server_ids.length}
            </Button>
            <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}>
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="删除"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        {probe.targets.length === 0 ? (
          <button
            type="button"
            onClick={onAssign}
            className="w-full rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            未指派客户端 · 点击选择由哪些机器发起探测
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {probe.targets.map((t) => (
              <ProbeTargetChip key={t.server_id} target={t} bands={probe.bands} />
            ))}
          </div>
        )}

        {open && (
          <div className="border-t pt-3">
            <LatencyPanel
              probeId={probe.id}
              targets={probe.targets}
              load={api.probeHistory}
              bands={probe.bands}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 全局默认配色：没单独配置的探测目标都跟着它变。 */
function DefaultBandsDialog({
  open,
  onOpenChange,
  value,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  value: LatencyBand[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<LatencyBand[]>(value);
  const [saving, setSaving] = useState(false);
  const onError = useErrorHandler();

  // 打开那一刻取当前值：弹窗关着时父页面刷新不该冲掉正在编辑的草稿
  useEffect(() => {
    if (open) setDraft(value.map((b) => ({ ...b })));
  }, [open, value]);

  const submit = async () => {
    const bad = validateBands(draft);
    if (bad) return toast.error(bad);
    setSaving(true);
    try {
      await api.saveLatencyBands(draft);
      toast.success("已保存默认配色");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      onError(e, "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>默认延迟配色</DialogTitle>
          <DialogDescription>
            按延迟快慢分段上色，图表背景带与延迟数字都用它。单独配置过配色的目标不受影响。
          </DialogDescription>
        </DialogHeader>
        <BandsEditor value={draft} onChange={setDraft} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={submit}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
