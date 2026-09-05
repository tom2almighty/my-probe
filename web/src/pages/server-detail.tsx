//! 服务器详情页：实时指标、历史图表、Agent 接入信息。延迟探测统一在「延迟探测」页面管理。

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowDownUp,
  ArrowLeft,
  Cpu,
  HardDrive,
  KeyRound,
  MemoryStick,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import {
  ChartBlock,
  LOAD_SERIES,
  METRIC_RANGES,
  MetricChart,
  NET_SERIES,
  type RangeKey,
  RangeTabs,
  USAGE_SERIES,
  toChartRows,
} from "@/components/metric-chart";
import { SecretDialog } from "@/components/secret-dialog";
import { ServerFormDialog, type ServerFormValue } from "@/components/server-form";
import { ExpireBadge, OnlineBadge, RenewInfo, StatTile, TrafficBar } from "@/components/status";
import { TrafficResetDialog } from "@/components/traffic-reset-dialog";
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
import { modeLabel, trafficText, withLiveUsed } from "@/lib/traffic";
import type { MetricPoint, ServerDetail, TrafficCycle } from "@/lib/types";
import { fmtBytes, fmtPct, fmtTime, pct, uptimeText } from "@/lib/utils";

export default function ServerDetailPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const onError = useErrorHandler();

  const detail = useAsync<ServerDetail>(() => api.server(id), [id]);
  const [range, setRange] = useState<RangeKey>("1h");
  const cfg = METRIC_RANGES.find((r) => r.key === range) ?? METRIC_RANGES[0];
  const history = useAsync<MetricPoint[]>(
    () => api.metrics(id, Date.now() - cfg.ms, cfg.points),
    [id, range],
  );

  const [liveM, setLiveM] = useState<MetricPoint | null>(null);
  // 实时事件里的已用流量（0 表示这条事件没带，沿用快照）
  const [liveUsed, setLiveUsed] = useState(0);
  const [liveOnline, setLiveOnline] = useState<boolean | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

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
      setLiveUsed(e.traffic_used);
      setLiveOnline(true);
      history.setData((rows) => [...(rows ?? []), p].slice(-1000));
    } else if (e.type === "server_status" && e.id === id) {
      setLiveOnline(e.online);
    } else if (e.type === "servers_changed") {
      detail.reload();
    }
  });

  const rows = useMemo(() => toChartRows(history.data), [history.data]);

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

  const doResetTraffic = async (usedBytes?: number) => {
    try {
      await api.resetTraffic(id, usedBytes);
      toast.success("已校正本周期流量");
      // 实时覆盖值已经过期，等下一次上报重新累加
      setLiveUsed(0);
      detail.reload();
    } catch (e) {
      onError(e, "校正失败");
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
  const traffic = withLiveUsed(s.traffic, liveUsed);

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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
        <StatTile
          label="本周期流量"
          value={traffic.pct == null ? fmtBytes(traffic.used) : fmtPct(traffic.pct)}
          hint={traffic.pct == null ? `不限额 · ${modeLabel(traffic.mode)}` : trafficText(traffic)}
          icon={<ArrowDownUp className="size-4" />}
          tone={
            traffic.pct == null
              ? "default"
              : traffic.pct >= 100
                ? "danger"
                : traffic.pct >= 80
                  ? "warning"
                  : "default"
          }
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
          <div className="min-w-0">
            <CardTitle className="text-base">流量</CardTitle>
            <CardDescription>
              由 Agent 采集网卡累计值折算，与服务商账单会有差异；周期按 UTC 计算
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setResetOpen(true)}>
            <SlidersHorizontal className="size-3.5" /> 校正
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <TrafficBar traffic={traffic} label={`本周期 · ${modeLabel(traffic.mode)}`} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoItem label="下行">
              <span className="tabular-nums">{fmtBytes(traffic.rx)}</span>
            </InfoItem>
            <InfoItem label="上行">
              <span className="tabular-nums">{fmtBytes(traffic.tx)}</span>
            </InfoItem>
            <InfoItem label="周期起点">
              {traffic.cycle_start ? utcDay(traffic.cycle_start) : "不分周期"}
            </InfoItem>
            <InfoItem label="下次重置">
              {traffic.next_reset == null ? "不重置" : utcDay(traffic.next_reset)}
            </InfoItem>
          </div>
          {s.traffic_history.length > 0 && <TrafficHistory rows={s.traffic_history} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">历史指标</CardTitle>
            <CardDescription>
              {rows.length ? `${rows.length} 个采样点` : "暂无采样"}，长范围由主控按时间桶聚合
            </CardDescription>
          </div>
          <RangeTabs value={range} onChange={setRange} ranges={METRIC_RANGES} />
        </CardHeader>
        <CardContent className="space-y-6">
          <ChartBlock title="占用率" legend={USAGE_SERIES} hint="虚线为该时段峰值">
            <MetricChart data={rows} series={USAGE_SERIES} spanMs={cfg.ms} />
          </ChartBlock>
          <ChartBlock title="网络速率" legend={NET_SERIES}>
            <MetricChart data={rows} height={200} series={NET_SERIES} spanMs={cfg.ms} />
          </ChartBlock>
          <ChartBlock title="平均负载" legend={LOAD_SERIES}>
            <MetricChart data={rows} height={160} series={LOAD_SERIES} spanMs={cfg.ms} />
          </ChartBlock>
        </CardContent>
      </Card>

      <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} server={s} onSubmit={saveServer} />

      <TrafficResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        traffic={traffic}
        onSubmit={doResetTraffic}
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

/** 周期边界一律按 UTC 展示，避免和主控的算法看起来差一天。 */
function utcDay(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** 已归档的历史周期：不分周期的机器没有这张表。计费口径以当前设置为准。 */
function TrafficHistory({ rows }: { rows: TrafficCycle[] }) {
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-xs font-medium text-muted-foreground">历史周期</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 text-left font-medium">周期起点</th>
              <th className="px-3 py-1.5 text-right font-medium">下行</th>
              <th className="px-3 py-1.5 text-right font-medium">上行</th>
              <th className="py-1.5 pl-3 text-right font-medium">计费用量</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cycle_start} className="border-t">
                <td className="whitespace-nowrap py-1.5 pr-3">{utcDay(c.cycle_start)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtBytes(c.rx)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtBytes(c.tx)}</td>
                <td className="py-1.5 pl-3 text-right font-medium tabular-nums">{fmtBytes(c.used)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
