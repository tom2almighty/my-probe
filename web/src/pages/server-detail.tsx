//! 服务器详情页：实时指标、历史图表、Agent 接入信息。延迟探测统一在「延迟探测」页面管理。

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Cpu,
  HardDrive,
  KeyRound,
  MemoryStick,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import { MetricChart, type Series } from "@/components/metric-chart";
import { SecretDialog } from "@/components/secret-dialog";
import { ServerFormDialog, type ServerFormValue } from "@/components/server-form";
import { ExpireBadge, OnlineBadge, RenewInfo, StatTile } from "@/components/status";
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
import type { MetricPoint, ServerDetail } from "@/lib/types";
import { fmtBytes, fmtPct, fmtTime, pct, uptimeText } from "@/lib/utils";

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

      <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} server={s} onSubmit={saveServer} />

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
