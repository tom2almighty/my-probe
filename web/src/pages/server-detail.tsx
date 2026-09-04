//! 服务器详情页：实时指标、历史图表、延迟探测指派、Agent 接入信息。

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Cpu,
  HardDrive,
  KeyRound,
  ListChecks,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import { LatencyPanel } from "@/components/latency-panel";
import { MetricChart, type Series } from "@/components/metric-chart";
import { PickDialog, type PickOption } from "@/components/pick-dialog";
import { type EditingProbe, ProbeFormDialog, type ProbeFormValue } from "@/components/probe-form";
import { SecretDialog } from "@/components/secret-dialog";
import { ServerFormDialog, type ServerFormValue } from "@/components/server-form";
import { ExpireBadge, OkRate, OnlineBadge, RenewInfo, StatTile } from "@/components/status";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, useErrorHandler, useUiEvents } from "@/lib/hooks";
import type { MetricPoint, ProbeItem, ProbeView, Server, ServerDetail } from "@/lib/types";
import { fmtBytes, fmtLatency, fmtPct, fmtTime, pct, uptimeText } from "@/lib/utils";

const RANGES = [
  { key: "1h", label: "1 小时", ms: 3_600_000, points: 180 },
  { key: "6h", label: "6 小时", ms: 6 * 3_600_000, points: 240 },
  { key: "24h", label: "24 小时", ms: 24 * 3_600_000, points: 288 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 3_600_000, points: 336 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];
type ChartRow = MetricPoint & { mem_pct: number; disk_pct: number };

const USAGE_SERIES: Series[] = [
  { key: "cpu", label: "CPU", color: "var(--chart-1)", unit: "pct" },
  { key: "mem_pct", label: "内存", color: "var(--chart-2)", unit: "pct" },
  { key: "disk_pct", label: "磁盘", color: "var(--chart-3)", unit: "pct" },
];

const NET_SERIES: Series[] = [
  { key: "net_in", label: "下行", color: "var(--chart-4)", unit: "bytes" },
  { key: "net_out", label: "上行", color: "var(--chart-5)", unit: "bytes" },
];

const LOAD_SERIES: Series[] = [{ key: "load1", label: "1 分钟负载", color: "var(--chart-1)", unit: "abs" }];

export default function ServerDetailPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const onError = useErrorHandler();

  const detail = useAsync<ServerDetail>(() => api.server(id), [id]);
  const probeList = useAsync<ProbeItem[]>(() => api.probes(), []);
  const serverList = useAsync<Server[]>(() => api.servers(), []);
  const [range, setRange] = useState<RangeKey>("1h");
  const cfg = RANGES.find((r) => r.key === range) ?? RANGES[0];
  const history = useAsync<MetricPoint[]>(
    () => api.metrics(id, Date.now() - cfg.ms, cfg.points),
    [id, range],
  );

  const [liveM, setLiveM] = useState<MetricPoint | null>(null);
  const [liveOnline, setLiveOnline] = useState<boolean | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  const [probeOpen, setProbeOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [editingProbe, setEditingProbe] = useState<EditingProbe | null>(null);
  const [delProbe, setDelProbe] = useState<ProbeView | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useUiEvents((e) => {
    if (e.type === "metrics" && e.server_id === id) {
      const p: MetricPoint = {
        ts: e.ts,
        cpu: e.cpu,
        mem_used: e.mem_used,
        mem_total: e.mem_total,
        disk_used: e.disk_used,
        disk_total: e.disk_total,
        net_in: e.net_in,
        net_out: e.net_out,
        load1: e.load1,
        uptime: e.uptime,
      };
      setLiveM(p);
      setLiveOnline(true);
      history.setData((rows) => [...(rows ?? []), p].slice(-720));
    } else if (e.type === "server_status" && e.id === id) {
      setLiveOnline(e.online);
    } else if (e.type === "probe" && e.server_id === id) {
      detail.setData((d) =>
        d
          ? {
              ...d,
              probes: d.probes.map((p) =>
                p.id === e.probe_id ? { ...p, last: { ts: e.ts, ok: e.ok, latency_ms: e.latency_ms } } : p,
              ),
            }
          : d,
      );
    } else if (e.type === "servers_changed") {
      detail.reload();
    }
  });

  const rows = useMemo<ChartRow[]>(
    () =>
      (history.data ?? []).map((p) => ({
        ...p,
        mem_pct: pct(p.mem_used, p.mem_total),
        disk_pct: pct(p.disk_used, p.disk_total),
      })),
    [history.data],
  );

  /** 这台客户端当前执行的探测 id，用于指派弹窗的初始勾选。 */
  const assignedIds = useMemo(() => (detail.data?.probes ?? []).map((p) => p.id), [detail.data]);

  const probeOptions = useMemo<PickOption[]>(
    () =>
      (probeList.data ?? []).map((p) => ({
        id: p.id,
        label: p.name,
        hint: `${p.protocol.toUpperCase()} · ${p.protocol === "tcp" && p.port ? `${p.target}:${p.port}` : p.target}`,
        status: p.enabled ? null : <span className="text-muted-foreground">已暂停</span>,
      })),
    [probeList.data],
  );

  /** 在本页新建探测时默认只勾选当前这台客户端。 */
  const defaultProbeServers = useMemo(() => [id], [id]);

  const saveServer = async (v: ServerFormValue) => {
    try {
      await api.updateServer(id, v);
      toast.success("已保存");
      detail.reload();
    } catch (e) {
      onError(e, "保存失败");
      throw e;
    }
  };

  const doRotate = async () => {
    try {
      const { secret: sc } = await api.rotateSecret(id);
      setSecret(sc);
      toast.success("已生成新密钥");
      detail.reload();
    } catch (e) {
      onError(e, "重置失败");
    } finally {
      setRotateOpen(false);
    }
  };

  const doDelete = async () => {
    try {
      await api.deleteServer(id);
      toast.success("已删除");
      navigate("/servers", { replace: true });
    } catch (e) {
      onError(e, "删除失败");
      setDelOpen(false);
    }
  };

  const saveProbe = async (v: ProbeFormValue) => {
    try {
      if (editingProbe) {
        await api.updateProbe(editingProbe.id, v);
        toast.success("探测目标已更新");
      } else {
        await api.createProbe(v);
        toast.success("探测目标已添加");
      }
      detail.reload();
      probeList.reload();
    } catch (e) {
      onError(e, "保存失败");
      throw e;
    }
  };

  /** 覆盖这台客户端执行的探测集合。 */
  const saveAssign = async (probeIds: number[]) => {
    try {
      await api.setServerProbes(id, probeIds);
      toast.success("已更新该客户端的探测");
      detail.reload();
      probeList.reload();
    } catch (e) {
      onError(e, "保存失败");
      throw e;
    }
  };

  /** 单个探测的快速移除：只解除与这台客户端的关联，探测本身保留。 */
  const unassign = async (p: ProbeView) => {
    const rest = (detail.data?.probes ?? []).map((x) => x.id).filter((x) => x !== p.id);
    try {
      await api.setServerProbes(id, rest);
      toast.success(`已停止在本机探测「${p.name}」`);
      detail.reload();
      probeList.reload();
    } catch (e) {
      onError(e, "操作失败");
    }
  };

  const openNewProbe = () => {
    setEditingProbe(null);
    setProbeOpen(true);
  };

  /** 编辑时要带上该探测的完整客户端指派，避免保存后把别的机器踢掉。 */
  const openEditProbe = (row: ProbeView) => {
    const full = probeList.data?.find((p) => p.id === row.id);
    setEditingProbe(full ?? { ...row, server_ids: [id] });
    setProbeOpen(true);
  };

  const doDelProbe = async () => {
    if (!delProbe) return;
    try {
      await api.deleteProbe(delProbe.id);
      toast.success(`已删除「${delProbe.name}」`);
      detail.reload();
      probeList.reload();
    } catch (e) {
      onError(e, "删除失败");
    } finally {
      setDelProbe(null);
    }
  };

  const s = detail.data;
  if (!s) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        {detail.loading ? "加载中…" : "服务器不存在或已被删除"}
      </div>
    );
  }

  const online = liveOnline ?? s.online;
  const m = online ? (liveM ?? s.latest) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild title="返回列表">
          <Link to="/servers">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="mr-auto min-w-0">
          <div className="flex items-center gap-2">
            <Flag code={s.country} className="text-lg" />
            <h1 className="truncate text-xl font-semibold tracking-tight">{s.name}</h1>
            <OnlineBadge online={online} />
            {!s.enabled && <Badge variant="muted">停用</Badge>}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {countryName(s.country)}
            {s.note ? ` · ${s.note}` : ""}
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          title="刷新"
          onClick={() => {
            detail.reload();
            history.reload();
          }}
        >
          <RefreshCw className="size-4" />
        </Button>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" /> 编辑
        </Button>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setDelOpen(true)}
        >
          <Trash2 className="size-4" /> 删除
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="CPU"
          value={m ? fmtPct(m.cpu) : "—"}
          hint={m ? `负载 ${m.load1.toFixed(2)}` : "等待上报"}
          icon={<Cpu className="size-4" />}
          tone={m && m.cpu >= 90 ? "danger" : m && m.cpu >= 80 ? "warning" : "default"}
        />
        <StatTile
          label="内存"
          value={m ? fmtPct(pct(m.mem_used, m.mem_total)) : "—"}
          hint={m ? `${fmtBytes(m.mem_used)} / ${fmtBytes(m.mem_total)}` : "等待上报"}
          icon={<MemoryStick className="size-4" />}
        />
        <StatTile
          label="磁盘"
          value={m ? fmtPct(pct(m.disk_used, m.disk_total)) : "—"}
          hint={m ? `${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total)}` : "等待上报"}
          icon={<HardDrive className="size-4" />}
        />
        <StatTile
          label="网络"
          value={m ? `↓ ${fmtBytes(m.net_in)}/s` : "—"}
          hint={m ? `↑ ${fmtBytes(m.net_out)}/s` : "等待上报"}
          icon={<Activity className="size-4" />}
        />
      </div>

      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem label="到期">
            <div className="flex items-center gap-2">
              <ExpireBadge days={s.days_to_expire} date={s.expire_date} />
              {s.expire_date && <span className="text-xs text-muted-foreground">{s.expire_date}</span>}
            </div>
          </InfoItem>
          <InfoItem label="续费">
            <RenewInfo price={s.renew_price} cycle={s.renew_cycle} />
          </InfoItem>
          <InfoItem label="运行时长">{m ? uptimeText(m.uptime) : "—"}</InfoItem>
          <InfoItem label="上报间隔">{s.report_interval_s} 秒</InfoItem>
          <InfoItem label="最后上报">{s.last_seen ? fmtTime(s.last_seen) : "从未连接"}</InfoItem>
          <InfoItem label="接入密钥">
            <div className="flex items-center gap-2">
              <code className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {s.secret_preview}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setRotateOpen(true)}
              >
                <KeyRound className="size-3" /> 重置
              </Button>
            </div>
          </InfoItem>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">历史指标</CardTitle>
            <CardDescription>
              {rows.length ? `${rows.length} 个采样点` : "暂无采样"}，主控按 15 秒节流落库
            </CardDescription>
          </div>
          <div className="flex rounded-md border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === r.key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <ChartBlock title="占用率" legend={USAGE_SERIES}>
            <MetricChart data={rows} series={USAGE_SERIES} />
          </ChartBlock>
          <ChartBlock title="网络速率" legend={NET_SERIES}>
            <MetricChart data={rows} height={200} series={NET_SERIES} />
          </ChartBlock>
          <ChartBlock title="平均负载" legend={LOAD_SERIES}>
            <MetricChart data={rows} height={160} series={LOAD_SERIES} />
          </ChartBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">延迟探测</CardTitle>
            <CardDescription>
              这台客户端正在执行的探测，勾选即可开启 / 关闭，探测目标本身与服务器互不绑定
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
              <ListChecks className="size-4" /> 选择探测
            </Button>
            <Button size="sm" onClick={openNewProbe}>
              <Plus className="size-4" /> 新建探测
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {s.probes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
              <Waypoints className="size-6" />
              <span>
                这台客户端还没有探测任务
                <br />
                可以从已有目标里勾选，也可以新建一个
              </span>
              <div className="mt-2 flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
                  <ListChecks className="size-4" /> 选择探测
                </Button>
                <Button size="sm" onClick={openNewProbe}>
                  <Plus className="size-4" /> 新建探测
                </Button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-2.5" />
                    <th className="px-3 py-2.5 text-left font-medium">名称</th>
                    <th className="px-3 py-2.5 text-left font-medium">目标</th>
                    <th className="px-3 py-2.5 text-left font-medium">最近</th>
                    <th className="px-3 py-2.5 text-left font-medium">24h 可用率</th>
                    <th className="px-3 py-2.5 text-left font-medium">平均延迟</th>
                    <th className="px-3 py-2.5 text-left font-medium">频率</th>
                    <th className="px-3 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {s.probes.map((p) => (
                    <ProbeRow
                      key={p.id}
                      probe={p}
                      serverId={id}
                      serverName={s.name}
                      online={online}
                      open={expanded === p.id}
                      onToggle={() => setExpanded((v) => (v === p.id ? null : p.id))}
                      onEdit={() => openEditProbe(p)}
                      onUnassign={() => unassign(p)}
                      onDelete={() => setDelProbe(p)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} server={s} onSubmit={saveServer} />

      <ProbeFormDialog
        open={probeOpen}
        onOpenChange={setProbeOpen}
        probe={editingProbe}
        servers={serverList.data ?? []}
        defaultServerIds={defaultProbeServers}
        onSubmit={saveProbe}
      />

      <PickDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title={`「${s.name}」执行哪些探测`}
        description="勾选后由这台客户端发起，取消勾选只是停止本机探测，不会删除目标"
        options={probeOptions}
        selected={assignedIds}
        emptyText="还没有任何探测目标，先新建一个"
        onSubmit={saveAssign}
      />

      <SecretDialog
        open={!!secret}
        onOpenChange={(v) => !v && setSecret(null)}
        serverName={s.name}
        secret={secret}
      />

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置接入密钥？</AlertDialogTitle>
            <AlertDialogDescription>
              旧密钥立即失效，正在连接的 Agent 会掉线，需要用新密钥重新配置后才能恢复上报。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={doRotate}>生成新密钥</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{s.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该服务器的历史指标与探测记录会一并删除，且无法恢复；探测目标本身会保留，只是不再由这台机器执行。
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

      <AlertDialog open={!!delProbe} onOpenChange={(v) => !v && setDelProbe(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除探测「{delProbe?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该目标会从所有客户端上移除，历史探测记录一并删除。只想停掉本机探测的话，用列表里的「停止本机探测」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={doDelProbe}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function ChartBlock({
  title,
  legend,
  children,
}: {
  title: string;
  legend: { label: string; color: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{title}</span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

function ProbeRow({
  probe,
  serverId,
  serverName,
  online,
  open,
  onToggle,
  onEdit,
  onUnassign,
  onDelete,
}: {
  probe: ProbeView;
  serverId: number;
  serverName: string;
  online: boolean;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onUnassign: () => void;
  onDelete: () => void;
}) {
  const target = probe.protocol === "tcp" && probe.port ? `${probe.target}:${probe.port}` : probe.target;
  return (
    <>
      <tr className="border-b transition-colors last:border-0 hover:bg-muted/40">
        <td className="px-2 py-2.5">
          <Button variant="ghost" size="icon" className="size-7" title="展开延迟曲线" onClick={onToggle}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{probe.name}</span>
            {!probe.enabled && <Badge variant="muted">暂停</Badge>}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono uppercase">
              {probe.protocol}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{target}</span>
          </div>
        </td>
        <td className="px-3 py-2.5">
          {probe.last ? (
            probe.last.ok ? (
              <span className="tabular-nums">{fmtLatency(probe.last.latency_ms)}</span>
            ) : (
              <Badge variant="danger">失败</Badge>
            )
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2.5">
          <OkRate ok={probe.ok_24h} />
        </td>
        <td className="px-3 py-2.5 tabular-nums">{fmtLatency(probe.avg_latency_ms)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
          每 {probe.interval_s}s / {probe.timeout_ms}ms 超时
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="停止本机探测" onClick={onUnassign}>
            <Unlink className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="删除探测目标"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/20 last:border-0">
          <td colSpan={8} className="px-4 py-3">
            <LatencyPanel
              probeId={probe.id}
              targets={[{ server_id: serverId, server_name: serverName, online }]}
              lockedServerId={serverId}
              load={api.probeHistory}
            />
          </td>
        </tr>
      )}
    </>
  );
}
