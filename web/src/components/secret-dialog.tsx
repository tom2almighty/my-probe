//! Agent 接入密钥弹窗：一次性展示明文密钥并给出接入命令。

import { Check, Copy, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopy } from "@/lib/hooks";

/** 当前主控的 Agent 接入地址 */
function agentUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/agent`;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serverName: string;
  secret: string | null;
}

export function SecretDialog({ open, onOpenChange, serverName, secret }: Props) {
  const [copiedSecret, copySecret] = useCopy();
  const [, copyCmd] = useCopy();
  const url = agentUrl();

  const binCmd = [
    `MYPROBE_AGENT_SERVER=${url} \\`,
    `MYPROBE_AGENT_SECRET=${secret ?? ""} \\`,
    "  ./myprobe-agent",
  ].join("\n");

  const dockerCmd = [
    "docker run -d --name myprobe-agent \\",
    "  --restart always --network host --cap-add NET_RAW \\",
    `  -e MYPROBE_AGENT_SERVER=${url} \\`,
    `  -e MYPROBE_AGENT_SECRET=${secret ?? ""} \\`,
    "  ghcr.io/tom2almighty/myprobe-agent:latest",
  ].join("\n");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>「{serverName}」的接入密钥</DialogTitle>
          <DialogDescription>密钥只在这里完整展示一次，关闭后只能重新生成。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>请立即保存到 Agent 所在机器。重新生成后旧密钥立即失效，已连接的 Agent 会掉线。</span>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">密钥</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 font-mono text-xs">
                {secret ?? "—"}
              </code>
              <Button
                type="button"
                size="icon"
                variant="outline"
                title="复制密钥"
                onClick={() => secret && copySecret(secret)}
              >
                {copiedSecret ? (
                  <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
          </div>

          <Tabs defaultValue="bin">
            <TabsList>
              <TabsTrigger value="bin">单文件部署</TabsTrigger>
              <TabsTrigger value="docker">Docker</TabsTrigger>
            </TabsList>
            <TabsContent value="bin" className="space-y-2">
              <CmdBlock cmd={binCmd} onCopy={copyCmd} />
              <p className="text-[11px] text-muted-foreground">
                ICMP 探测需要 root 或 <code className="font-mono">setcap cap_net_raw+ep ./myprobe-agent</code>
                ；只用 TCP 探测则无需额外权限。
              </p>
            </TabsContent>
            <TabsContent value="docker" className="space-y-2">
              <CmdBlock cmd={dockerCmd} onCopy={copyCmd} />
              <p className="text-[11px] text-muted-foreground">
                <code className="font-mono">--network host</code> 让 Agent 读取宿主机网卡速率，
                <code className="font-mono">--cap-add NET_RAW</code> 供 ICMP 探测使用。
              </p>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CmdBlock({ cmd, onCopy }: { cmd: string; onCopy: (t: string) => void }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 pr-11 font-mono text-[11px] leading-relaxed">
        {cmd}
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-1 top-1"
        title="复制命令"
        onClick={() => onCopy(cmd)}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
}
