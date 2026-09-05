//! 服务器管理页：列表 / 新建 / 编辑 / 重置密钥 / 删除。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, Search, ServerIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import { ServerFormDialog, type ServerFormValue } from "@/components/server-form";
import { SecretDialog } from "@/components/secret-dialog";
import { ExpireBadge, OnlineBadge, RenewInfo } from "@/components/status";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useAsync, useErrorHandler, useUiEvents } from "@/lib/hooks";
import { modeLabel, resetText, trafficText, withLiveUsed } from "@/lib/traffic";
import type { MetricPoint, Server, Traffic } from "@/lib/types";
import { fmtBytes, fmtPct, fmtTime, pct } from "@/lib/utils";

type Filter = "all" | "online" | "offline";

export default function ServersPage() {
  const { data, loading, reload } = useAsync<Server[]>(() => api.servers(), []);
  const onError = useErrorHandler();

  const [live, setLive] = useState<Record<number, MetricPoint>>({});
  // 流量用量单独存：实时事件只带折算后的总量，rx/tx 仍取快照里的
  const [liveUsed, setLiveUsed] = useState<Record<number, number>>({});
  const [onlineMap, setOnlineMap] = useState<Record<number, boolean>>({});
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Server | null>(null);
  const [rotating, setRotating] = useState<Server | null>(null);

  useUiEvents((e) => {
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
    } else if (e.type === "servers_changed") {
      reload();
    }
  });

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data ?? [])
      .map((s) => {
        const online = onlineMap[s.id] ?? s.online;
        return {
          s,
          online,
          m: online ? (live[s.id] ?? s.latest) : null,
          traffic: withLiveUsed(s.traffic, liveUsed[s.id]),
        };
      })
      .filter(({ s, online }) => {
        if (filter === "online" && !online) return false;
        if (filter === "offline" && online) return false;
        if (!kw) return true;
        return (
          s.name.toLowerCase().includes(kw) ||
          s.note.toLowerCase().includes(kw) ||
          s.country.toLowerCase().includes(kw) ||
          countryName(s.country).toLowerCase().includes(kw)
        );
      });
  }, [data, live, liveUsed, onlineMap, q, filter]);

  // 所有机器里最高的 Agent 版本，用来标出哪台还没更新
  const newestVersion = useMemo(() => {
    let top: string | null = null;
    for (const s of data ?? []) {
      if (s.agent_version && (!top || cmpVer(s.agent_version, top) > 0)) top = s.agent_version;
    }
    return top;
  }, [data]);

  const create = async (v: ServerFormValue) => {
    try {
      const resp = await api.createServer(v);
      toast.success("服务器已创建");
      setSecret({ name: resp.name, secret: resp.secret });
      reload();
    } catch (e) {
      onError(e, "创建失败");
      throw e;
    }
  };

  const update = async (v: ServerFormValue) => {
    if (!editing) return;
    try {
      await api.updateServer(editing.id, v);
      toast.success("已保存");
      reload();
    } catch (e) {
      onError(e, "保存失败");
      throw e;
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteServer(pendingDelete.id);
      toast.success(`已删除「${pendingDelete.name}」`);
      reload();
    } catch (e) {
      onError(e, "删除失败");
    } finally {
      setPendingDelete(null);
    }
  };

  const doRotate = async () => {
    if (!rotating) return;
    try {
      const { secret: s } = await api.rotateSecret(rotating.id);
      setSecret({ name: rotating.name, secret: s });
      toast.success("已生成新密钥");
    } catch (e) {
      onError(e, "重置失败");
    } finally {
      setRotating(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">服务器</h1>
          <p className="text-sm text-muted-foreground">
            共 {data?.length ?? 0} 台，管理归属地、到期与续费信息
          </p>
        </div>
        <Button variant="outline" size="icon" title="刷新" onClick={reload}>
          <RefreshCw className="size-4" />
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="size-4" /> 添加服务器
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 地区 / 备注"
            className="pl-8"
          />
        </div>
        <div className="flex rounded-md border p-0.5">
          {(
            [
              ["all", "全部"],
              ["online", "在线"],
              ["offline", "离线"],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                filter === k
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 桌面端表格 */}
      <Card className="hidden overflow-hidden lg:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">服务器</th>
                <th className="px-3 py-2.5 text-left font-medium">状态</th>
                <th className="px-3 py-2.5 text-left font-medium">CPU</th>
                <th className="px-3 py-2.5 text-left font-medium">内存</th>
                <th className="px-3 py-2.5 text-left font-medium">磁盘</th>
                <th className="px-3 py-2.5 text-left font-medium">网络</th>
                <th className="px-3 py-2.5 text-left font-medium">流量</th>
                <th className="px-3 py-2.5 text-left font-medium">到期</th>
                <th className="px-3 py-2.5 text-left font-medium">续费</th>
                <th className="px-3 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, online, m, traffic }) => (
                <tr key={s.id} className="border-b transition-colors last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Flag code={s.country} className="text-base" />
                      <div className="min-w-0">
                        <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
                          {s.name}
                        </Link>
                        <div className="truncate text-xs text-muted-foreground">
                          {countryName(s.country)}
                          {s.note ? ` · ${s.note}` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <OnlineBadge online={online} />
                      {!s.enabled && <Badge variant="muted">停用</Badge>}
                    </div>
                    <AgentVersion version={s.agent_version} newest={newestVersion} />
                  </td>
                  <td className="px-3 py-2.5">
                    <MiniUsage pct={m ? m.cpu : null} />
                  </td>
                  <td className="px-3 py-2.5">
                    <MiniUsage
                      pct={m ? pct(m.mem_used, m.mem_total) : null}
                      hint={m ? `${fmtBytes(m.mem_used)} / ${fmtBytes(m.mem_total)}` : undefined}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <MiniUsage
                      pct={m ? pct(m.disk_used, m.disk_total) : null}
                      hint={m ? `${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total)}` : undefined}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums">
                    {m ? (
                      <>
                        <div>↓ {fmtBytes(m.net_in)}/s</div>
                        <div className="text-muted-foreground">↑ {fmtBytes(m.net_out)}/s</div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <TrafficCell traffic={traffic} />
                  </td>
                  <td className="px-3 py-2.5">
                    <ExpireBadge days={s.days_to_expire} date={s.expire_date} />
                  </td>
                  <td className="px-3 py-2.5 text-sm">
                    <RenewInfo price={s.renew_price} cycle={s.renew_cycle} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <RowActions
                      server={s}
                      onEdit={() => {
                        setEditing(s);
                        setFormOpen(true);
                      }}
                      onRotate={() => setRotating(s)}
                      onDelete={() => setPendingDelete(s)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty loading={loading} filtered={!!q || filter !== "all"} />}
      </Card>

      {/* 移动端卡片 */}
      <div className="space-y-3 lg:hidden">
        {rows.map(({ s, online, m, traffic }) => (
          <Card key={s.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start gap-2">
                <Flag code={s.country} className="mt-0.5 text-base" />
                <div className="min-w-0 flex-1">
                  <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
                    {s.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">{countryName(s.country)}</div>
                </div>
                <OnlineBadge online={online} />
                <RowActions
                  server={s}
                  onEdit={() => {
                    setEditing(s);
                    setFormOpen(true);
                  }}
                  onRotate={() => setRotating(s)}
                  onDelete={() => setPendingDelete(s)}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <MiniUsage label="CPU" pct={m ? m.cpu : null} />
                <MiniUsage label="内存" pct={m ? pct(m.mem_used, m.mem_total) : null} />
                <MiniUsage label="磁盘" pct={m ? pct(m.disk_used, m.disk_total) : null} />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  流量 · {modeLabel(traffic.mode)}
                  {traffic.limit > 0 && traffic.next_reset != null ? ` · ${resetText(traffic)}` : ""}
                </span>
                <span className="tabular-nums">
                  {trafficText(traffic)}
                  {traffic.pct != null && <span className="ml-1 font-medium">（{fmtPct(traffic.pct)}）</span>}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                <ExpireBadge days={s.days_to_expire} date={s.expire_date} />
                <RenewInfo price={s.renew_price} cycle={s.renew_cycle} />
                <AgentVersion version={s.agent_version} newest={newestVersion} />
                <span className="ml-auto text-muted-foreground">
                  {m ? fmtTime(m.ts) : s.last_seen ? fmtTime(s.last_seen) : "从未连接"}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && (
          <Card>
            <Empty loading={loading} filtered={!!q || filter !== "all"} />
          </Card>
        )}
      </div>

      <ServerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        server={editing}
        onSubmit={editing ? update : create}
      />

      <SecretDialog
        open={!!secret}
        onOpenChange={(v) => !v && setSecret(null)}
        serverName={secret?.name ?? ""}
        secret={secret?.secret ?? null}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingDelete?.name}」？</AlertDialogTitle>
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

      <AlertDialog open={!!rotating} onOpenChange={(v) => !v && setRotating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置「{rotating?.name}」的密钥？</AlertDialogTitle>
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
    </div>
  );
}

/** 表格里的流量格：限额存在时给「已用 / 限额 + 细条」，否则只报已用量。 */
function TrafficCell({ traffic }: { traffic: Traffic }) {
  const hint = `${modeLabel(traffic.mode)} · ${resetText(traffic)}`;
  if (traffic.limit <= 0) {
    return (
      <div className="min-w-24 whitespace-nowrap text-xs" title={hint}>
        <div className="tabular-nums">{fmtBytes(traffic.used)}</div>
        <div className="text-[11px] text-muted-foreground">不限额</div>
      </div>
    );
  }
  return (
    <div className="min-w-24 space-y-1" title={hint}>
      <div className="flex items-baseline justify-between gap-1.5 whitespace-nowrap text-xs">
        <span className="tabular-nums">{trafficText(traffic)}</span>
        <span className="font-medium tabular-nums">{fmtPct(traffic.pct ?? 0)}</span>
      </div>
      <Progress value={traffic.pct ?? 0} className="h-1" />
    </div>
  );
}

function MiniUsage({ label, pct: p, hint }: { label?: string; pct: number | null; hint?: string }) {
  return (
    <div className="min-w-16 space-y-1" title={hint}>
      <div className="flex items-baseline justify-between gap-1.5 text-xs">
        {label && <span className="text-muted-foreground">{label}</span>}
        <span className="font-medium tabular-nums">{p == null ? "—" : `${p.toFixed(0)}%`}</span>
      </div>
      <Progress value={p ?? 0} className="h-1" />
    </div>
  );
}

/** 按数字段逐位比较，"0.2.0" 比 "0.1.9" 新；后缀（rc 之类）忽略。 */
function cmpVer(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Agent 自报的版本；比别的机器旧就标黄，一眼看出哪台没更新。 */
function AgentVersion({ version, newest }: { version: string | null; newest: string | null }) {
  if (!version) return null;
  const outdated = !!newest && cmpVer(version, newest) < 0;
  const tone = outdated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  return (
    <span
      className={`text-[11px] tabular-nums ${tone}`}
      title={outdated ? `其他机器已经是 v${newest}，这台还没更新` : `Agent v${version}`}
    >
      v{version}
    </span>
  );
}

function RowActions({
  server,
  onEdit,
  onRotate,
  onDelete,
}: {
  server: Server;
  onEdit: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="更多操作">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem asChild>
          <Link to={`/servers/${server.id}`}>
            <ServerIcon /> 查看详情
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil /> 编辑
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRotate}>
          <KeyRound /> 重置密钥
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
          <Trash2 /> 删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Empty({ loading, filtered }: { loading: boolean; filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
      {loading ? (
        "加载中…"
      ) : filtered ? (
        "没有匹配的服务器"
      ) : (
        <>
          <ServerIcon className="size-6" />
          还没有服务器，点右上角「添加服务器」开始
        </>
      )}
    </div>
  );
}
