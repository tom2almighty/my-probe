//! 公开节点详情页 /s/:id：不登录即可看单台机器的历史曲线，以及它到各目标的延迟。

import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Activity, ArrowDownUp, Cpu, HardDrive, MemoryStick, Waypoints } from "lucide-react";

import { Flag } from "@/components/flag";
import { LatencyPanel } from "@/components/latency-panel";
import {
  ChartBlock,
  LOAD_SERIES,
  type LatencySeries,
  LatencyMultiChart,
  METRIC_RANGES,
  MetricChart,
  NET_SERIES,
  type RangeKey,
  RangeTabs,
  USAGE_SERIES,
  probeStats,
  seriesColor,
  seriesDash,
  toChartRows,
} from "@/components/metric-chart";
import { PublicHeader } from "@/components/public-header";
import { OkRate, OnlineBadge, StatTile } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, usePublicEvents } from "@/lib/hooks";
import { commonBands, latencyColor } from "@/lib/latency";
import { modeLabel, resetText, trafficText, withLiveUsed } from "@/lib/traffic";
import type { MetricPoint, ProbeItem, ProbePoint, PublicOverview } from "@/lib/types";
import { fmtBytes, fmtLatency, fmtPct, fmtTime, pct, uptimeText } from "@/lib/utils";

/** 一次拉取里所有探测的曲线，连同这批数据对应的时间窗。 */
interface ProbeHistories {
  from: number;
  to: number;
  rows: ProbePoint[][];
}

export default function PublicServerPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const valid = Number.isFinite(id);
  const [range, setRange] = useState<RangeKey>("1h");
  const cfg = METRIC_RANGES.find((r) => r.key === range) ?? METRIC_RANGES[0];

  const overview = useAsync<PublicOverview>(() => api.publicOverview(), []);
  const history = useAsync<MetricPoint[]>(
    () => (valid ? api.publicMetrics(id, Date.now() - cfg.ms, cfg.points) : Promise.resolve([])),
    [id, range],
  );

  const [liveM, setLiveM] = useState<MetricPoint | null>(null);
  // 实时事件里的已用流量（0 表示这条事件没带，沿用快照）
  const [liveUsed, setLiveUsed] = useState(0);
  const [liveOnline, setLiveOnline] = useState<boolean | null>(null);
  const [openProbe, setOpenProbe] = useState<number | null>(null);

  usePublicEvents((e) => {
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
      overview.reload();
    }
  });

  const srv = overview.data?.servers.find((s) => s.id === id) ?? null;
  const probes = useMemo(
    () => (overview.data?.probes ?? []).filter((p) => p.server_ids.includes(id)),
    [overview.data?.probes, id],
  );
  const probeKey = probes.map((p) => p.id).join(",");

  // 一次并发拉齐所有探测，避免每条曲线各自发一轮请求
  const histories = useAsync<ProbeHistories>(async () => {
    const to = Date.now();
    const from = to - cfg.ms;
    const rows = await Promise.all(probes.map((p) => api.publicProbeHistory(p.id, id, from, cfg.points)));
    return { from, to, rows };
  }, [id, range, probeKey]);

  const latency = useMemo<LatencySeries[]>(
    () =>
      probes.map((p, i) => ({
        key: `p${p.id}`,
        label: p.name,
        color: seriesColor(i),
        dash: seriesDash(i),
        rows: histories.data?.rows[i] ?? [],
        bands: p.bands,
      })),
    [probes, histories.data],
  );

  // 这张图里一条线一个探测目标，各自的阈值可能来自不同配色方案：
  // 阈值不一致时图表不画背景色带，这里顺手说明一句，免得以为是漏了
  const mixedBands = commonBands(probes.map((p) => p.bands)) == null;

  if (!srv) {
    return (
      <div className="min-h-screen bg-muted/30">
        <PublicHeader subtitle="节点详情" backTo="/" />
        <div className="py-24 text-center text-sm text-muted-foreground">
          {overview.loading ? "加载中…" : "节点不存在或未公开"}
        </div>
      </div>
    );
  }

  const online = liveOnline ?? srv.online;
  const m = online ? (liveM ?? srv.latest) : null;
  const rows = toChartRows(history.data);
  const traffic = withLiveUsed(srv.traffic, liveUsed);
  const trafficPct = traffic.pct;

  return (
    <div className="min-h-screen bg-muted/30">
      <PublicHeader
        title={srv.name}
        subtitle={countryName(srv.country)}
        icon={<Flag code={srv.country} className="text-base" />}
        backTo="/"
        onRefresh={() => {
          overview.reload();
          history.reload();
          histories.reload();
        }}
      >
        <OnlineBadge online={online} />
      </PublicHeader>

      <main className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
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
            value={trafficPct == null ? fmtBytes(traffic.used) : fmtPct(trafficPct)}
            hint={
              trafficPct == null
                ? `不限额 · ${modeLabel(traffic.mode)}`
                : `${trafficText(traffic)} · ${resetText(traffic)}`
            }
            icon={<ArrowDownUp className="size-4" />}
            tone={
              trafficPct == null
                ? "default"
                : trafficPct >= 100
                  ? "danger"
                  : trafficPct >= 80
                    ? "warning"
                    : "default"
            }
          />
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            <div className="min-w-0">
              <CardTitle className="text-base">历史曲线</CardTitle>
              <CardDescription>
                {rows.length ? `${rows.length} 个采样点` : "暂无采样"}
                {m ? ` · 已运行 ${uptimeText(m.uptime)}` : ""}
              </CardDescription>
            </div>
            <RangeTabs value={range} onChange={setRange} ranges={METRIC_RANGES} />
          </CardHeader>
          <CardContent className="space-y-6">
            <ChartBlock title="占用率" legend={USAGE_SERIES} hint="虚线为该时段峰值">
              <MetricChart data={rows} series={USAGE_SERIES} height={220} spanMs={cfg.ms} />
            </ChartBlock>
            <ChartBlock title="网络速率" legend={NET_SERIES}>
              <MetricChart data={rows} series={NET_SERIES} height={180} spanMs={cfg.ms} />
            </ChartBlock>
            <ChartBlock title="平均负载" legend={LOAD_SERIES}>
              <MetricChart data={rows} series={LOAD_SERIES} height={150} spanMs={cfg.ms} />
            </ChartBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">本机延迟</CardTitle>
            <CardDescription>
              这台机器主动探测各目标的延迟，曲线断开表示当时不通；点开某一行可看条带与丢包明细
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {probes.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                <Waypoints className="size-6" />
                {overview.loading ? "加载中…" : "这台机器还没有公开的延迟探测"}
              </div>
            ) : (
              <>
                <ChartBlock
                  title="延迟对比"
                  legend={latency}
                  hint={mixedBands ? "各目标阈值不同，未画背景色带" : undefined}
                >
                  <LatencyMultiChart
                    series={latency}
                    from={histories.data?.from ?? Date.now() - cfg.ms}
                    to={histories.data?.to ?? Date.now()}
                    height={240}
                  />
                </ChartBlock>
                <div className="space-y-2">
                  {probes.map((p, i) => (
                    <ProbeRow
                      key={p.id}
                      probe={p}
                      serverId={id}
                      color={seriesColor(i)}
                      rows={histories.data?.rows[i] ?? []}
                      span={cfg}
                      open={openProbe === p.id}
                      onToggle={() => setOpenProbe((v) => (v === p.id ? null : p.id))}
                    />
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-center text-[11px] text-muted-foreground">
        最后上报 {srv.last_seen ? fmtTime(srv.last_seen) : "—"}
      </footer>
    </div>
  );
}

function ProbeRow({
  probe,
  serverId,
  color,
  rows,
  span,
  open,
  onToggle,
}: {
  probe: ProbeItem;
  serverId: number;
  color: string;
  rows: ProbePoint[];
  span: { ms: number; points: number };
  open: boolean;
  onToggle: () => void;
}) {
  const st = probeStats(rows);
  const target = probe.protocol === "tcp" && probe.port ? `${probe.target}:${probe.port}` : probe.target;
  const stat = probe.targets.find((t) => t.server_id === serverId);
  return (
    <div className="rounded-lg border bg-background">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-left transition-colors hover:bg-accent/40"
      >
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-sm font-medium">{probe.name}</span>
        <Badge variant="outline" className="font-mono uppercase">
          {probe.protocol}
        </Badge>
        <span className="truncate font-mono text-xs text-muted-foreground">{target}</span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          <Cell label="当前">
            {st.last ? (
              st.last.ok ? (
                <span style={{ color: latencyColor(probe.bands, st.last.latency_ms) ?? undefined }}>
                  {fmtLatency(st.last.latency_ms)}
                </span>
              ) : (
                <span className="text-red-600 dark:text-red-400">丢包</span>
              )
            ) : (
              "—"
            )}
          </Cell>
          <Cell label="平均">
            <span style={{ color: latencyColor(probe.bands, st.avg) ?? undefined }}>
              {fmtLatency(st.avg)}
            </span>
          </Cell>
          <Cell label="抖动">{st.jitter == null ? "—" : `±${Math.round(st.jitter)} ms`}</Cell>
          <Cell label="丢包">{st.count === 0 ? "—" : `${(st.loss * 100).toFixed(1)}%`}</Cell>
          <Cell label="24h 可用">
            <OkRate ok={stat?.ok_24h ?? null} />
          </Cell>
        </div>
      </button>
      {open && (
        <div className="border-t p-3">
          <LatencyPanel
            probeId={probe.id}
            targets={probe.targets}
            load={api.publicProbeHistory}
            lockedServerId={serverId}
            span={span}
            bands={probe.bands}
            height={180}
          />
        </div>
      )}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </span>
  );
}
