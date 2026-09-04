//! 公开状态页：不登录即可查看服务器状态与延迟探测，右上角留后台入口。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, LogIn, Radio, RefreshCw, Waypoints } from "lucide-react";

import { Flag } from "@/components/flag";
import { LatencyPanel } from "@/components/latency-panel";
import { MetricChart, type Series } from "@/components/metric-chart";
import { OnlineBadge, ProbeTargetChip, UsageBar } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, getToken, isMock } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, usePublicEvents } from "@/lib/hooks";
import type { MetricPoint, ProbeItem, PublicOverview, PublicServer } from "@/lib/types";
import { fmtBytes, fmtTime, pct, uptimeText } from "@/lib/utils";

const USAGE_SERIES: Series[] = [
  { key: "cpu", label: "CPU", color: "var(--chart-1)", unit: "pct" },
  { key: "mem_pct", label: "内存", color: "var(--chart-2)", unit: "pct" },
];

export default function PublicPage() {
  const { data, loading, reload, setData } = useAsync<PublicOverview>(() => api.publicOverview(), []);
  const [live, setLive] = useState<Record<number, MetricPoint>>({});
  const [onlineMap, setOnlineMap] = useState<Record<number, boolean>>({});
  const [openServer, setOpenServer] = useState<number | null>(null);
  const [openProbe, setOpenProbe] = useState<number | null>(null);
  // 首屏默认展开第一条延迟曲线，用户点过之后完全听用户的
  const [probeTouched, setProbeTouched] = useState(false);
  const loggedIn = !!getToken();

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
      setOnlineMap((m) => (m[e.server_id] ? m : { ...m, [e.server_id]: true }));
    } else if (e.type === "server_status") {
      setOnlineMap((m) => ({ ...m, [e.id]: e.online }));
    } else if (e.type === "probe") {
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
        return { s, online, m: online ? (live[s.id] ?? s.latest) : null };
      }),
    [data?.servers, live, onlineMap],
  );

  const online = servers.filter((x) => x.online).length;
  const probes = data?.probes ?? [];
  const activeProbe = probeTouched ? openProbe : (probes[0]?.id ?? null);
  const toggleProbe = (id: number) => {
    setProbeTouched(true);
    setOpenProbe(activeProbe === id ? null : id);
  };

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Radio className="size-4" />
          </div>
          <div className="mr-auto">
            <div className="text-sm font-bold leading-none">MyProbe</div>
            <div className="text-[11px] text-muted-foreground">服务器与链路状态</div>
          </div>
          <Badge variant={online === servers.length && servers.length > 0 ? "success" : "warning"}>
            {online} / {servers.length} 在线
          </Badge>
          <Button variant="outline" size="icon" title="刷新" onClick={reload}>
            <RefreshCw className="size-4" />
          </Button>
          <Button variant={loggedIn ? "default" : "outline"} size="sm" asChild>
            <Link to={loggedIn ? "/overview" : "/login"}>
              <LogIn className="size-4" /> {loggedIn ? "进入后台" : "后台登录"}
            </Link>
          </Button>
        </div>
      </header>

      {isMock() && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
          Mock 数据模式：当前展示本地示例数据
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-base font-semibold">节点</h2>
            <span className="text-xs text-muted-foreground">{servers.length} 台</span>
          </div>
          {servers.length === 0 ? (
            <Card>
              <div className="py-14 text-center text-sm text-muted-foreground">
                {loading ? "加载中…" : "还没有公开的节点"}
              </div>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {servers.map(({ s, online: on, m }) => (
                <ServerCard
                  key={s.id}
                  server={s}
                  online={on}
                  m={m}
                  open={openServer === s.id}
                  onToggle={() => setOpenServer((v) => (v === s.id ? null : s.id))}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-base font-semibold">延迟探测</h2>
            <span className="text-xs text-muted-foreground">
              {probes.length} 个目标 · 点开可切换节点、时间范围与平滑曲线
            </span>
          </div>
          {probes.length === 0 ? (
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
                  open={activeProbe === p.id}
                  onToggle={() => toggleProbe(p.id)}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-center text-[11px] text-muted-foreground">
        数据由各节点 Agent 实时上报 · 最后更新 {data ? fmtTime(data.ts) : "—"}
      </footer>
    </div>
  );
}

function ServerCard({
  server,
  online,
  m,
  open,
  onToggle,
}: {
  server: PublicServer;
  online: boolean;
  m: MetricPoint | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-2">
          <Flag code={server.country} className="mt-0.5 text-base" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{server.name}</div>
            <div className="truncate text-xs text-muted-foreground">{countryName(server.country)}</div>
          </div>
          <OnlineBadge online={online} />
        </div>

        <div className="grid grid-cols-3 gap-3">
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
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">↓ {m ? fmtBytes(m.net_in) : "—"}/s</span>
          <span className="tabular-nums">↑ {m ? fmtBytes(m.net_out) : "—"}/s</span>
          <span>
            {m ? uptimeText(m.uptime) : server.last_seen ? `${fmtTime(server.last_seen)} 后失联` : "从未连接"}
          </span>
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto flex items-center gap-1 transition-colors hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}近 1 小时
          </button>
        </div>

        {open && <ServerChart id={server.id} />}
      </CardContent>
    </Card>
  );
}

function ServerChart({ id }: { id: number }) {
  const { data } = useAsync<MetricPoint[]>(() => api.publicMetrics(id, Date.now() - 3_600_000, 120), [id]);
  const rows = useMemo(
    () => (data ?? []).map((p) => ({ ...p, mem_pct: pct(p.mem_used, p.mem_total) })),
    [data],
  );
  return <MetricChart data={rows} series={USAGE_SERIES} height={140} />;
}

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
              <ProbeTargetChip key={t.server_id} target={t} />
            ))}
          </div>
        )}

        {open && (
          <div className="border-t pt-3">
            <LatencyPanel probeId={probe.id} targets={probe.targets} load={api.publicProbeHistory} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
