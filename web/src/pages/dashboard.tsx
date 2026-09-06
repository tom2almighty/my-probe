//! 概览页：全局状态统计与续费提醒。节点明细与实时曲线在「服务器列表」与公开页看，
//! 概览只回答「一切是否正常」，不再重复一份服务器卡片。

import { useAsync, useUiEvents } from "@/lib/hooks";
import { ArrowRight, CalendarClock, CircleCheck, CircleX, Radio, ServerIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { ExpireBadge, RenewInfo, StatTile } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { StatusResp } from "@/lib/types";

export default function DashboardPage() {
  const status = useAsync<StatusResp>(() => api.status(), []);

  // 在线状态翻转 / 列表变化都会广播事件，收到就重拉一次 status（就一个聚合查询）
  useUiEvents((e) => {
    if (e.type === "server_status" || e.type === "servers_changed") {
      status.reload();
    }
  });

  const d = status.data;
  const total = d?.total ?? 0;
  const online = d?.online ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <p className="text-sm text-muted-foreground">全部节点的运行概况与续费提醒</p>
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
          value={d?.probes ?? 0}
          icon={<Radio className="size-4" />}
          hint="启用中的延迟探测"
        />
      </div>

      {status.loading && !d ? (
        <div className="h-20 animate-pulse rounded-xl border bg-card" />
      ) : d && total === 0 ? (
        <EmptyServers />
      ) : (
        (d?.expiring.length ?? 0) > 0 && <ExpiringCard items={d!.expiring} />
      )}
    </div>
  );
}

/** 续费提醒：7 天内到期或已过期的服务器。 */
function ExpiringCard({ items }: { items: StatusResp["expiring"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4 text-amber-500" />
          续费提醒
        </CardTitle>
        <CardDescription>7 天内到期或已过期的服务器</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((s) => (
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
              <RenewInfo price={s.renew_price} cycle={s.renew_cycle} currency={s.currency} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
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
