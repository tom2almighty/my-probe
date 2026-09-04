//! 告警页：阈值规则 + 通知渠道（Telegram，接口对其他渠道通用）。

import { useState } from "react";
import { Bell, Eye, EyeOff, Info, Plus, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAsync, useErrorHandler } from "@/lib/hooks";
import { type AlertRules, defaultAlertRules, type NotifierConfig } from "@/lib/types";

export default function AlertsPage() {
  const onError = useErrorHandler();
  const {
    data: rules,
    setData: setRules,
    loading: loadingRules,
  } = useAsync<AlertRules>(() => api.alerts(), []);
  const { data: notifiers, setData: setNotifiers } = useAsync<NotifierConfig[]>(() => api.notifiers(), []);

  const [savingRules, setSavingRules] = useState(false);
  const [savingNoti, setSavingNoti] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  const setRule = <K extends keyof AlertRules>(k: K, v: AlertRules[K]) =>
    setRules((r) => (r ? { ...r, [k]: v } : r));

  const saveRules = async () => {
    if (!rules) return;
    setSavingRules(true);
    try {
      await api.updateAlerts(rules);
      toast.success("告警规则已保存");
    } catch (e) {
      onError(e, "保存失败");
    } finally {
      setSavingRules(false);
    }
  };

  const patchNoti = (id: number, patch: Partial<NotifierConfig>) =>
    setNotifiers((l) => (l ?? []).map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const patchCfg = (id: number, k: string, v: string) =>
    setNotifiers((l) => (l ?? []).map((n) => (n.id === id ? { ...n, config: { ...n.config, [k]: v } } : n)));

  const addNotifier = () =>
    setNotifiers((l) => [
      ...(l ?? []),
      {
        id: Math.max(0, ...(l ?? []).map((n) => n.id)) + 1,
        name: "Telegram",
        type: "telegram",
        enabled: true,
        config: { bot_token: "", chat_id: "" },
      },
    ]);

  const saveNotifiers = async () => {
    setSavingNoti(true);
    try {
      await api.updateNotifiers(notifiers ?? []);
      toast.success("通知渠道已保存");
    } catch (e) {
      onError(e, "保存失败");
    } finally {
      setSavingNoti(false);
    }
  };

  const testNotifier = async (n: NotifierConfig) => {
    setTesting(n.id);
    try {
      const r = await api.testNotifier(n);
      if (r.ok) toast.success("测试通知已发送，请查看对应会话");
      else toast.error(r.error ?? "发送失败");
    } catch (e) {
      onError(e, "发送失败");
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">告警</h1>
        <p className="text-sm text-muted-foreground">配置触发条件与通知渠道，命中后向所有启用的渠道推送</p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">触发条件</CardTitle>
            <CardDescription>同一条件在恢复前只通知一次，避免重复打扰</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              title="恢复默认值"
              onClick={() => setRules(defaultAlertRules())}
            >
              <RotateCcw className="size-4" /> 默认值
            </Button>
            <Button size="sm" disabled={!rules || savingRules} onClick={saveRules}>
              <Save className="size-4" /> {savingRules ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="divide-y">
          {!rules ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {loadingRules ? "加载中…" : "读取失败"}
            </div>
          ) : (
            <>
              <RuleRow
                title="离线告警"
                desc="Agent 超过判定时间没有上报即视为离线"
                enabled={rules.offline_enabled}
                onEnabled={(v) => setRule("offline_enabled", v)}
              />
              <RuleRow
                title="CPU 使用率"
                desc="持续高于阈值时通知"
                enabled={rules.cpu_enabled}
                onEnabled={(v) => setRule("cpu_enabled", v)}
                value={rules.cpu_threshold}
                onValue={(v) => setRule("cpu_threshold", v)}
                unit="%"
                min={1}
                max={100}
              />
              <RuleRow
                title="内存使用率"
                desc="持续高于阈值时通知"
                enabled={rules.mem_enabled}
                onEnabled={(v) => setRule("mem_enabled", v)}
                value={rules.mem_threshold}
                onValue={(v) => setRule("mem_threshold", v)}
                unit="%"
                min={1}
                max={100}
              />
              <RuleRow
                title="磁盘使用率"
                desc="所有挂载点合计占用"
                enabled={rules.disk_enabled}
                onEnabled={(v) => setRule("disk_enabled", v)}
                value={rules.disk_threshold}
                onValue={(v) => setRule("disk_threshold", v)}
                unit="%"
                min={1}
                max={100}
              />
              <RuleRow
                title="探测延迟"
                desc="探测成功但延迟超过阈值时通知"
                enabled={rules.latency_enabled}
                onEnabled={(v) => setRule("latency_enabled", v)}
                value={rules.latency_threshold_ms}
                onValue={(v) => setRule("latency_threshold_ms", v)}
                unit="ms"
                min={1}
                max={60000}
                step={10}
              />
              <RuleRow
                title="到期提醒"
                desc="距离到期日不足设定天数时提醒续费"
                enabled={rules.expire_enabled}
                onEnabled={(v) => setRule("expire_enabled", v)}
                value={rules.expire_days}
                onValue={(v) => setRule("expire_days", v)}
                unit="天"
                min={1}
                max={365}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">通知渠道</CardTitle>
            <CardDescription>目前支持 Telegram Bot，渠道接口通用，后续可扩展其他方式</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={addNotifier}>
              <Plus className="size-4" /> 添加渠道
            </Button>
            <Button size="sm" disabled={savingNoti} onClick={saveNotifiers}>
              <Save className="size-4" /> {savingNoti ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {(notifiers ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              <Bell className="size-6" />
              还没有通知渠道，添加后才会真正收到告警
            </div>
          ) : (
            (notifiers ?? []).map((n) => (
              <div key={n.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Switch checked={n.enabled} onCheckedChange={(v) => patchNoti(n.id, { enabled: v })} />
                  <Input
                    value={n.name}
                    onChange={(e) => patchNoti(n.id, { name: e.target.value })}
                    placeholder="渠道备注名"
                    className="h-8 max-w-56"
                  />
                  <span className="rounded border bg-muted px-2 py-0.5 font-mono text-xs uppercase text-muted-foreground">
                    {n.type}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testing === n.id}
                      onClick={() => testNotifier(n)}
                    >
                      <Send className="size-4" /> {testing === n.id ? "发送中…" : "测试"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="移除该渠道"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setNotifiers((l) => (l ?? []).filter((x) => x.id !== n.id))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`bt-${n.id}`}>Bot Token</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`bt-${n.id}`}
                        type={revealed[n.id] ? "text" : "password"}
                        autoComplete="off"
                        value={n.config.bot_token ?? ""}
                        onChange={(e) => patchCfg(n.id, "bot_token", e.target.value)}
                        placeholder="123456789:AA..."
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        title={revealed[n.id] ? "隐藏" : "显示"}
                        onClick={() => setRevealed((r) => ({ ...r, [n.id]: !r[n.id] }))}
                      >
                        {revealed[n.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ci-${n.id}`}>Chat ID</Label>
                    <Input
                      id={`ci-${n.id}`}
                      value={n.config.chat_id ?? ""}
                      onChange={(e) => patchCfg(n.id, "chat_id", e.target.value)}
                      placeholder="-1001234567890"
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              向 @BotFather 创建机器人取得 Bot Token；Chat ID 可让机器人加入群或私聊后， 访问{" "}
              <code className="font-mono">https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> 查看。
              私聊需先主动给机器人发一条消息，否则无法推送。
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RuleRow({
  title,
  desc,
  enabled,
  onEnabled,
  value,
  onValue,
  unit,
  min,
  max,
  step = 1,
}: {
  title: string;
  desc: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  value?: number;
  onValue?: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <Switch checked={enabled} onCheckedChange={onEnabled} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      {value != null && onValue && (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={!enabled}
            value={value}
            onChange={(e) => onValue(Number(e.target.value) || 0)}
            className="h-8 w-24 text-right tabular-nums"
          />
          <span className="w-6 text-xs text-muted-foreground">{unit}</span>
        </div>
      )}
    </div>
  );
}
