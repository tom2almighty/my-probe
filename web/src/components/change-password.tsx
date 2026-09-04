//! 修改管理员密码弹窗（侧边栏用户菜单入口）。

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useErrorHandler } from "@/lib/hooks";
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

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const EMPTY = { old: "", next: "", confirm: "" };

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const [v, setV] = useState(EMPTY);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const onError = useErrorHandler();

  // 关闭后不保留输入
  useEffect(() => {
    if (open) {
      setV(EMPTY);
      setReveal(false);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (v.next.length < 8) {
      toast.error("新密码至少 8 位");
      return;
    }
    if (v.next !== v.confirm) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (v.next === v.old) {
      toast.error("新密码不能与旧密码相同");
      return;
    }
    setSaving(true);
    try {
      await api.changePassword(v.old, v.next);
      toast.success("密码已修改");
      onOpenChange(false);
    } catch (err) {
      onError(err, "修改密码失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>当前登录状态会保留，其他设备需要用新密码重新登录。</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cp-old">当前密码</Label>
            <Input
              id="cp-old"
              type={reveal ? "text" : "password"}
              autoComplete="current-password"
              value={v.old}
              onChange={(e) => setV((s) => ({ ...s, old: e.target.value }))}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cp-new">新密码</Label>
            <div className="flex gap-2">
              <Input
                id="cp-new"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                value={v.next}
                onChange={(e) => setV((s) => ({ ...s, next: e.target.value }))}
                placeholder="至少 8 位"
                required
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={reveal ? "隐藏密码" : "显示密码"}
                onClick={() => setReveal((r) => !r)}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cp-confirm">确认新密码</Label>
            <Input
              id="cp-confirm"
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              value={v.confirm}
              onChange={(e) => setV((s) => ({ ...s, confirm: e.target.value }))}
              required
            />
          </div>

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
