//! 服务器新建 / 编辑表单弹窗（列表页与详情页共用）。
//! 按分组重排为四个区块，宽度放大到 2xl：价格、限额这类数字输入不再被相邻控件挤压。

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Flag } from "@/components/flag";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { COUNTRIES } from "@/lib/countries";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/lib/money";
import { TRAFFIC_UNITS, type TrafficUnit, splitLimit, toBytes } from "@/lib/traffic";
import {
  RENEW_CYCLE_LABELS,
  TRAFFIC_MODE_LABELS,
  type RenewCycle,
  type Server,
  type ServerInput,
  type TrafficMode,
} from "@/lib/types";
import { dateAfter } from "@/lib/utils";

/** 表单值就是后端的请求体，流量三个字段一并提交。 */
export type ServerFormValue = ServerInput;

function initial(server?: Server | null): ServerFormValue {
  return {
    name: server?.name ?? "",
    country: server?.country ?? "",
    note: server?.note ?? "",
    enabled: server?.enabled ?? true,
    expire_date: server?.expire_date ?? null,
    never_expire: server?.never_expire ?? false,
    renew_price: server?.renew_price ?? 0,
    renew_cycle: server?.renew_cycle ?? "month",
    currency: server?.currency ?? DEFAULT_CURRENCY,
    report_interval_s: server?.report_interval_s ?? 5,
    traffic_limit_bytes: server?.traffic.limit ?? 0,
    traffic_mode: server?.traffic.mode ?? "sum",
    traffic_reset_day: server?.traffic.reset_day ?? 1,
  };
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 传入表示编辑，不传表示新建 */
  server?: Server | null;
  onSubmit: (v: ServerFormValue) => Promise<void>;
}

/** 区块标题：把一份长表单拆成可扫读的几段。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function ServerFormDialog({ open, onOpenChange, server, onSubmit }: Props) {
  const [v, setV] = useState<ServerFormValue>(() => initial(server));
  // 限额在表单里按 GB/TB 输入，提交前折算成字节
  const [limit, setLimit] = useState(() => splitLimit(server?.traffic.limit ?? 0));
  const [saving, setSaving] = useState(false);
  const editing = !!server;

  // 只在弹窗打开的那一刻取初值：编辑期间任何 servers_changed 广播都会让父页面
  // 重新拉详情、产生新的 server 对象，不能因此把用户正在填的内容冲掉。
  const latest = useRef({ server });
  useEffect(() => {
    latest.current = { server };
  });
  useEffect(() => {
    if (open) {
      setV(initial(latest.current.server));
      setLimit(splitLimit(latest.current.server?.traffic.limit ?? 0));
    }
  }, [open]);

  const set = <K extends keyof ServerFormValue>(k: K, val: ServerFormValue[K]) =>
    setV((s) => ({ ...s, [k]: val }));

  const free = v.renew_cycle === "free";

  // 「永不到期」与日期互斥，「免费」与价格互斥：两处都在提交前后端也会再规范化一次，
  // 这里同步清掉是为了让界面上看到的就是最终会存下去的东西
  const setNever = (on: boolean) =>
    setV((s) => ({ ...s, never_expire: on, expire_date: on ? null : s.expire_date }));

  const setCycle = (c: string) =>
    setV((s) => ({
      ...s,
      renew_cycle: c as RenewCycle,
      renew_price: c === "free" ? 0 : s.renew_price,
    }));

  const setLimitFields = (value: number, unit: TrafficUnit) => {
    setLimit({ value, unit });
    set("traffic_limit_bytes", toBytes(value, unit));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.name.trim()) {
      toast.error("请填写服务器名称");
      return;
    }
    if (v.report_interval_s < 1 || v.report_interval_s > 3600) {
      toast.error("上报间隔需在 1-3600 秒之间");
      return;
    }
    if (v.traffic_limit_bytes > 0 && v.traffic_limit_bytes < 1024 * 1024) {
      toast.error("流量限额太小，请至少设置 1 MB");
      return;
    }
    // 29-31 号并非每月都有，主控只接受 1-28
    if (v.traffic_reset_day < 0 || v.traffic_reset_day > 28) {
      toast.error("流量重置日需在 1-28 之间，填 0 表示不重置");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ ...v, name: v.name.trim(), note: v.note.trim() });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑服务器" : "添加服务器"}</DialogTitle>
          <DialogDescription>
            {editing ? "修改后会立即向在线 Agent 重新下发配置" : "保存后会生成一次性密钥，用于 Agent 接入"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          <Section title="基本信息">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sf-name">名称</Label>
                <Input
                  id="sf-name"
                  value={v.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="东京主站"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sf-country">归属地</Label>
                <Select
                  value={v.country || "__none"}
                  onValueChange={(c) => set("country", c === "__none" ? "" : c)}
                >
                  <SelectTrigger id="sf-country" className="w-full">
                    <SelectValue placeholder="选择国家 / 地区" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="__none">未设置</SelectItem>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        <span className="flex items-center gap-2">
                          <Flag code={c.code} />
                          {c.name}
                          <span className="text-xs text-muted-foreground">{c.code.toUpperCase()}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sf-note">备注</Label>
              <Textarea
                id="sf-note"
                rows={2}
                value={v.note}
                onChange={(e) => set("note", e.target.value)}
                placeholder="服务商、配置、用途等"
              />
            </div>
          </Section>

          <Section title="续费与到期">
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="sf-cycle">续费周期</Label>
                <Select value={v.renew_cycle} onValueChange={setCycle}>
                  <SelectTrigger id="sf-cycle" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RENEW_CYCLE_LABELS) as RenewCycle[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {RENEW_CYCLE_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* 价格占满剩余宽度：前面只有周期、后面只有币种，长数字不再被截断 */}
              <div className="space-y-1.5">
                <Label htmlFor="sf-price">续费价格</Label>
                <Input
                  id="sf-price"
                  type="number"
                  min={0}
                  step="0.01"
                  className="w-full"
                  disabled={free}
                  value={v.renew_price}
                  onChange={(e) => set("renew_price", Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sf-currency">币种</Label>
                <Select value={v.currency} onValueChange={(c) => set("currency", c)} disabled={free}>
                  <SelectTrigger id="sf-currency" className="w-[96px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="sf-expire">到期日期</Label>
                <Input
                  id="sf-expire"
                  type="date"
                  className="w-full"
                  disabled={v.never_expire}
                  value={v.expire_date ?? ""}
                  onChange={(e) => set("expire_date", e.target.value || null)}
                />
              </div>
              <div className="flex items-end pb-1">
                <div className="flex items-center gap-2">
                  <Switch id="sf-never" checked={v.never_expire} onCheckedChange={setNever} />
                  <Label htmlFor="sf-never" className="text-xs font-normal text-muted-foreground">
                    永不到期
                  </Label>
                </div>
              </div>
            </div>
            {!v.never_expire && !v.expire_date && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>快速填充：</span>
                {(
                  [
                    ["1 个月", 30],
                    ["3 个月", 90],
                    ["半年", 182],
                    ["1 年", 365],
                  ] as [string, number][]
                ).map(([label, days]) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => set("expire_date", dateAfter(days))}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
          </Section>

          <Section title="流量套餐">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sf-traffic-limit">周期限额</Label>
                <div className="flex gap-2">
                  <Input
                    id="sf-traffic-limit"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="不限制"
                    className="min-w-0 flex-1"
                    value={limit.value || ""}
                    onChange={(e) => setLimitFields(Number(e.target.value) || 0, limit.unit)}
                  />
                  <Select
                    value={limit.unit}
                    onValueChange={(u) => setLimitFields(limit.value, u as TrafficUnit)}
                  >
                    <SelectTrigger className="w-[72px] shrink-0" aria-label="限额单位">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRAFFIC_UNITS.map((u) => (
                        <SelectItem key={u.key} value={u.key}>
                          {u.key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-[11px] text-muted-foreground">留空或 0 表示不限流量</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sf-traffic-mode">计费口径</Label>
                <Select value={v.traffic_mode} onValueChange={(m) => set("traffic_mode", m as TrafficMode)}>
                  <SelectTrigger id="sf-traffic-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TRAFFIC_MODE_LABELS) as TrafficMode[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {TRAFFIC_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">按服务商的计量方式选择</p>
              </div>
            </div>
            <div className="space-y-1.5 sm:max-w-[calc(50%-0.5rem)]">
              <Label htmlFor="sf-traffic-day">重置日</Label>
              <Input
                id="sf-traffic-day"
                type="number"
                min={0}
                max={28}
                step={1}
                placeholder="1"
                value={v.traffic_reset_day}
                onChange={(e) => set("traffic_reset_day", Math.trunc(Number(e.target.value)) || 0)}
              />
              <p className="text-[11px] text-muted-foreground">
                每月几号（1-28）按 UTC 归零，填 0 表示不重置
              </p>
            </div>
          </Section>

          <Section title="连接设置">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sf-interval">上报间隔（秒）</Label>
                <Input
                  id="sf-interval"
                  type="number"
                  min={1}
                  max={3600}
                  value={v.report_interval_s}
                  onChange={(e) => set("report_interval_s", Number(e.target.value) || 5)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Agent 采集整机指标的频率，默认 5 秒；需小于离线判定窗口（默认 30 秒）
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>启用</Label>
                <div className="flex h-9 items-center gap-2">
                  <Switch checked={v.enabled} onCheckedChange={(c) => set("enabled", c)} />
                  <span className="text-sm text-muted-foreground">
                    {v.enabled ? "允许该 Agent 连接上报" : "已停用，Agent 将被拒绝"}
                  </span>
                </div>
              </div>
            </div>
          </Section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
