//! 公开状态页：不登录即可查看节点状态，点卡片进节点详情；线路对比作为次级视图折叠在下方。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Waypoints } from "lucide-react";

import { Flag } from "@/components/flag";
import { LatencyPanel } from "@/components/latency-panel";
import { PublicHeader } from "@/components/public-header";
import { OnlineBadge, ProbeTargetChip, TrafficBar, UsageBar } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, usePublicEvents } from "@/lib/hooks";
import { withLiveUsed } from "@/lib/traffic";
import type { MetricPoint, ProbeItem, PublicOverview, PublicServer, Traffic } from "@/lib/types";
import { fmtBytes, fmtTime, pct, uptimeText } from "@/lib/utils";

export default function PublicPage() {
  const { data, loading, reload, setData } = useAsync<PublicOverview>(() => api.publicOverview(), []);
  const [live, setLive] = useState<Record<number, MetricPoint>>({});
  // 实时事件只带折算后的已用流量，rx/tx 仍取快照
  const [liveUsed, setLiveUsed] = useState<Record<number, number>>({});
  const [onlineMap, setOnlineMap] = useState<Record<number, boolean>>({});
  const [openProbe, setOpenProbe] = useState<number | null>(null);
  const [showProbes, setShowProbes] = useState(true);

  usePublicEvents((e) => {
    if (e.type === "metrics") {
      setLive((m) => ({
        ...m,
        [e.server_id]: {
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
        },
      }));
      if (e.traffic_used) setLiveUsed((t) => ({ ...t, [e.server_id]: e.traffic_used }));
      setOnlineMap((m) => (m[e.server_id] ? m : { ...m, [e.server_id]: true }));
    } else if (e.type === "server_status") {
      setOnlineMap((m) => ({ ...m, [e.id]: e.online }));
    } else if (e.type === "probe") {
      // 只更新受影响探测的那一台客户端，避免整页重拉
      setData((d) =>
        d
          ? {
              ...d,
              probes: d.probes.map((p) =>
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
            }
          : d,
      );
    } else if (e.type === "servers_changed") {
      reload();
    }
  });

  const servers = useMemo(
    () =>
      (data?.servers ?? []).map((s) => {
        const online = onlineMap[s.id] ?? s.online;
        return {
          s,
          online,
          m: online ? (live[s.id] ?? s.latest) : null,
          traffic: withLiveUsed(s.traffic, liveUsed[s.id]),
        };
      }),
    [data?.servers, live, liveUsed, onlineMap],
  );

  const online = servers.filter((x) => x.online).length;
  const probes = data?.probes ?? [];

  return (
    <div className="min-h-screen bg-muted/30">
      <PublicHeader subtitle="服务器与链路状态" onRefresh={reload}>
        <Badge variant={online === servers.length && servers.length > 0 ? "success" : "warning"}>
          {online} / {servers.length} 在线
        </Badge>
      </PublicHeader>

      <main className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold">节点</h2>
            <span className="text-xs text-muted-foreground">
              {servers.length} 台 · 点开某台可看历史曲线与它到各目标的延迟
            </span>
          </div>
          {servers.length === 0 ? (
            <Card>
              <div className="py-14 text-center text-sm text-muted-foreground">
                {loading ? "加载中…" : "还没有公开的节点"}
              </div>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {servers.map(({ s, online: on, m, traffic }) => (
                <ServerCard key={s.id} server={s} online={on} m={m} traffic={traffic} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowProbes((v) => !v)}
            aria-expanded={showProbes}
            className="flex w-full flex-wrap items-center gap-2 text-left"
          >
            {showProbes ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <h2 className="text-base font-semibold">线路对比</h2>
            <span className="text-xs text-muted-foreground">
              {probes.length} 个目标 · 展开后可勾选多个节点同图对比
            </span>
          </button>
          {showProbes &&
            (probes.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-muted-foreground">
                  <Waypoints className="size-6" />
                  {loading ? "加载中…" : "暂未公开延迟探测"}
                </div>
              </Card>
            ) : (
              <div className="space-y-3">
                {probes.map((p) => (
                  <ProbeCard
                    key={p.id}
                    probe={p}
                    open={openProbe === p.id}
                    onToggle={() => setOpenProbe((v) => (v === p.id ? null : p.id))}
                  />
                ))}
              </div>
            ))}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-center text-[11px] text-muted-foreground">
        数据由各节点 Agent 实时上报 · 最后更新 {data ? fmtTime(data.ts) : "—"}
      </footer>
    </div>
  );
}

/** 节点卡片：整卡是通往 /s/:id 的链接，卡面只放一眼能看完的现状。 */
function ServerCard({
  server,
  online,
  m,
  traffic,
}: {
  server: PublicServer;
  online: boolean;
  m: MetricPoint | null;
  traffic: Traffic;
}) {
  return (
    <Card className="transition-colors hover:border-primary/40 hover:bg-accent/30">
      <Link
        to={`/s/${server.id}`}
        className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start gap-2">
            <Flag code={server.country} className="mt-0.5 text-base" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{server.name}</div>
              <div className="truncate text-xs text-muted-foreground">{countryName(server.country)}</div>
            </div>
            <OnlineBadge online={online} />
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <UsageBar label="CPU" pct={m ? m.cpu : null} />
            <UsageBar
              label="内存"
              pct={m ? pct(m.mem_used, m.mem_total) : null}
              detail={m ? `${fmtBytes(m.mem_used)} / ${fmtBytes(m.mem_total)}` : undefined}
            />
            <UsageBar
              label="磁盘"
              pct={m ? pct(m.disk_used, m.disk_total) : null}
              detail={m ? `${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total)}` : undefined}
            />
            <TrafficBar traffic={traffic} />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
            <span className="tabular-nums">↓ {m ? fmtBytes(m.net_in) : "—"}/s</span>
            <span className="tabular-nums">↑ {m ? fmtBytes(m.net_out) : "—"}/s</span>
            <span>
              {m
                ? uptimeText(m.uptime)
                : server.last_seen
                  ? `${fmtTime(server.last_seen)} 后失联`
                  : "从未连接"}
            </span>
            <span className="ml-auto flex items-center gap-0.5">
              详情
              <ChevronRight className="size-3.5" />
            </span>
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}

/** 线路卡片：一个探测目标 + 它在各节点上的表现，点开看曲线。 */
function ProbeCard({ probe, open, onToggle }: { probe: ProbeItem; open: boolean; onToggle: () => void }) {
  const target = probe.protocol === "tcp" && probe.port ? `${probe.target}:${probe.port}` : probe.target;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-start gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{probe.name}</span>
              <Badge variant="outline" className="font-mono uppercase">
                {probe.protocol}
              </Badge>
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{target}</div>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">每 {probe.interval_s}s 一次</span>
        </button>

        {probe.targets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {probe.targets.map((t) => (
              <ProbeTargetChip key={t.server_id} target={t} bands={probe.bands} />
            ))}
          </div>
        )}

        {open && (
          <div className="space-y-2 border-t pt-3">
            {probe.targets.length > 1 && (
              <p className="text-[11px] text-muted-foreground">勾选多个节点可放在同一张图里对比线路</p>
            )}
            <LatencyPanel
              probeId={probe.id}
              targets={probe.targets}
              load={api.publicProbeHistory}
              bands={probe.bands}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
