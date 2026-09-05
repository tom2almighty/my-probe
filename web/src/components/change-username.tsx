//! 修改管理员用户名弹窗（侧边栏用户菜单入口）。

import { useEffect, useState } from "react";
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
  /** 当前用户名，打开时预填 */
  current: string;
  /** 保存成功后通知外面刷新显示 */
  onSaved?: (username: string) => void;
}

/** 与后端 change_username 保持一致：3-32 位，字母数字与 _ . - */
const NAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export function ChangeUsernameDialog({ open, onOpenChange, current, onSaved }: Props) {
  const [name, setName] = useState(current);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const onError = useErrorHandler();

  // 关闭后不保留输入，密码尤其不能留
  useEffect(() => {
    if (open) {
      setName(current);
      setPassword("");
    }
  }, [open, current]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (!NAME_RE.test(next)) {
      toast.error("用户名需为 3-32 位字母、数字或 _ . -");
      return;
    }
    if (next === current) {
      toast.error("新用户名与当前相同");
      return;
    }
    setSaving(true);
    try {
      const resp = await api.changeUsername(password, next);
      toast.success(`用户名已改为「${resp.username}」`);
      onSaved?.(resp.username);
      onOpenChange(false);
    } catch (err) {
      onError(err, "修改用户名失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改用户名</DialogTitle>
          <DialogDescription>当前登录状态会保留，下次登录请用新用户名。</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">新用户名</Label>
            <Input
              id="cu-name"
              autoComplete="username"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="3-32 位字母、数字或 _ . -"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cu-password">当前密码</Label>
            <Input
              id="cu-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="验证身份用"
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
