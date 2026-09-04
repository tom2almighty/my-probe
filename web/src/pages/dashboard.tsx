//! 概览页：全局状态汇总、到期提醒、服务器实时卡片。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarClock, CircleCheck, CircleX, Radio, ServerIcon } from "lucide-react";

import { Flag } from "@/components/flag";
import { Sparkline } from "@/components/sparkline";
import { ExpireBadge, OnlineBadge, RenewInfo, StatTile, UsageBar } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, useUiEvents } from "@/lib/hooks";
import type { MetricPoint, Server, StatusResp } from "@/lib/types";
import { fmtBytes, fmtTime, pct, uptimeText } from "@/lib/utils";

/** 每台机器保留的实时 CPU 采样点数 */
const SPARK_POINTS = 40;

export default function DashboardPage() {
  const status = useAsync<StatusResp>(() => api.status(), []);
  const servers = useAsync<Server[]>(() => api.servers(), []);

  // 实时覆盖层：WebSocket 推来的最新指标 / 在线状态
  const [live, setLive] = useState<Record<number, MetricPoint>>({});
  const [onlineMap, setOnlineMap] = useState<Record<number, boolean>>({});
  const [spark, setSpark] = useState<Record<number, { ts: number; v: number }[]>>({});

  useUiEvents((e) => {
    if (e.type === "metrics") {
      const point: MetricPoint = {
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
      setLive((m) => ({ ...m, [e.server_id]: point }));
      setSpark((m) => {
        const prev = m[e.server_id] ?? [];
        return { ...m, [e.server_id]: [...prev, { ts: e.ts, v: e.cpu }].slice(-SPARK_POINTS) };
      });
      setOnlineMap((m) => (m[e.server_id] ? m : { ...m, [e.server_id]: true }));
    } else if (e.type === "server_status") {
      setOnlineMap((m) => ({ ...m, [e.id]: e.online }));
    } else if (e.type === "servers_changed") {
      servers.reload();
      status.reload();
    }
  });

  const rows = useMemo(() => {
    const list = servers.data ?? [];
    return list.map((s) => ({
      server: s,
      online: onlineMap[s.id] ?? s.online,
      metric: live[s.id] ?? s.latest,
      spark: spark[s.id] ?? [],
    }));
  }, [servers.data, live, onlineMap, spark]);

  const online = rows.filter((r) => r.online).length;
  const total = rows.length || status.data?.total || 0;
  const expiring = status.data?.expiring ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <p className="text-sm text-muted-foreground">全部节点的实时状态、资源占用与续费提醒</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <StatTile label="服务器" value={total} icon={<ServerIcon className="size-4" />} hint="纳管节点总数" />
        <StatTile
          label="在线"
          value={online}
          tone={total > 0 && online === total ? "success" : "default"}
          icon={<CircleCheck className="size-4" />}
          hint={total ? `${((online / total) * 100).toFixed(0)}% 在线` : "—"}
        />
        <StatTile
          label="离线"
          value={total - online}
          tone={total - online > 0 ? "danger" : "default"}
          icon={<CircleX className="size-4" />}
          hint={total - online > 0 ? "需要关注" : "全部正常"}
        />
        <StatTile
          label="探测目标"
          value={status.data?.probes ?? 0}
          icon={<Radio className="size-4" />}
          hint="启用中的延迟探测"
        />
      </div>

      {expiring.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="size-4 text-amber-500" />
              续费提醒
            </CardTitle>
            <CardDescription>7 天内到期或已过期的服务器</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {expiring.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
              >
                <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <ExpireBadge days={s.days_to_expire} date={s.expire_date} />
                <span className="text-xs text-muted-foreground">{s.expire_date ?? "—"}</span>
                <div className="ml-auto">
                  <RenewInfo price={s.renew_price} cycle={s.renew_cycle} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {servers.loading && rows.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-52 animate-pulse rounded-xl border bg-card" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyServers />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ server: s, online: up, metric, spark: sp }) => (
            <ServerCard key={s.id} server={s} online={up} metric={metric} spark={sp} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerCard({
  server: s,
  online,
  metric,
  spark,
}: {
  server: Server;
  online: boolean;
  metric: MetricPoint | null;
  spark: { ts: number; v: number }[];
}) {
  const m = online ? metric : null;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Flag code={s.country} className="shrink-0 text-lg" />
              <Link to={`/servers/${s.id}`} className="truncate hover:underline">
                {s.name}
              </Link>
            </CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-1.5">
              <span>{countryName(s.country)}</span>
              {!s.enabled && <Badge variant="muted">已停用</Badge>}
            </CardDescription>
          </div>
          <OnlineBadge online={online} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2.5">
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
            warnAt={85}
          />
        </div>

        {spark.length >= 3 && <Sparkline data={spark} height={36} className="-mb-1" />}

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-3 text-xs">
          <Info label="↓ 下行" value={m ? `${fmtBytes(m.net_in)}/s` : "—"} />
          <Info label="↑ 上行" value={m ? `${fmtBytes(m.net_out)}/s` : "—"} />
          <Info label="负载" value={m ? m.load1.toFixed(2) : "—"} />
          <Info label="运行" value={m ? uptimeText(m.uptime) : "—"} />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
          <ExpireBadge days={s.days_to_expire} date={s.expire_date} />
          <RenewInfo price={s.renew_price} cycle={s.renew_cycle} />
          <span className="ml-auto text-muted-foreground">
            {online
              ? m
                ? fmtTime(m.ts)
                : "等待上报"
              : s.last_seen
                ? `最后在线 ${fmtTime(s.last_seen)}`
                : "从未连接"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium tabular-nums">{value}</span>
    </div>
  );
}

function EmptyServers() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <ServerIcon className="size-6 text-muted-foreground" />
        </div>
        <div>
          <div className="font-medium">还没有纳管任何服务器</div>
          <div className="mt-1 text-sm text-muted-foreground">
            添加一台服务器后，把生成的密钥填进 Agent 即可开始上报
          </div>
        </div>
        <Button asChild>
          <Link to="/servers">
            去添加 <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
