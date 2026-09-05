//! 手动校正本周期流量：Agent 离线期间漏计、或换机后累计读数错位时用。

import { useEffect, useState } from "react";

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
import { TRAFFIC_UNITS, type TrafficUnit, modeLabel, splitLimit, toBytes, trafficText } from "@/lib/traffic";
import type { Traffic } from "@/lib/types";
import { fmtBytes } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  traffic: Traffic;
  /** 不传字节数表示直接归零 */
  onSubmit: (usedBytes?: number) => Promise<void>;
}

export function TrafficResetDialog({ open, onOpenChange, traffic, onSubmit }: Props) {
  const [v, setV] = useState(() => splitLimit(traffic.used));
  const [saving, setSaving] = useState(false);

  // 每次打开时以当前记录为初值
  useEffect(() => {
    if (open) setV(splitLimit(traffic.used));
  }, [open, traffic.used]);

  const bytes = toBytes(v.value, v.unit);

  const run = async (usedBytes?: number) => {
    setSaving(true);
    try {
      await onSubmit(usedBytes);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>校正本周期流量</DialogTitle>
          <DialogDescription>
            Agent 离线期间的流量必然漏计，换机后累计读数也会错位。按服务商面板上的数字填一次即可。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tr-used">已用流量（{modeLabel(traffic.mode)}）</Label>
            <div className="flex gap-2">
              <Input
                id="tr-used"
                type="number"
                min={0}
                step="0.01"
                value={v.value || ""}
                onChange={(e) => setV({ value: Number(e.target.value) || 0, unit: v.unit })}
              />
              <Select value={v.unit} onValueChange={(u) => setV({ value: v.value, unit: u as TrafficUnit })}>
                <SelectTrigger className="w-[76px] shrink-0" aria-label="单位">
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
          </div>
          <p className="text-[11px] text-muted-foreground">
            当前记录 {trafficText(traffic)}；改成 {fmtBytes(bytes)} 后，上下行按现有比例分摊，
            下一次上报会以新数字为基线继续累加。
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" disabled={saving} onClick={() => run(undefined)}>
            归零
          </Button>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={() => run(bytes)}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
