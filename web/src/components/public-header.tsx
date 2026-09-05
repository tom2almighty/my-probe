//! 公开页共用头部：品牌 / 返回、附加信息、主题切换、刷新与后台入口。
//! Mock 提示条紧贴头部，一并放在这里。

import { ArrowLeft, LogIn, Radio, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { getToken, isMock } from "@/lib/api";

export function PublicHeader({
  title = "MyProbe",
  subtitle,
  icon,
  backTo,
  onRefresh,
  children,
}: {
  title?: string;
  subtitle?: string;
  /** 标题前的小图标（国旗等） */
  icon?: React.ReactNode;
  /** 传入则左侧显示返回箭头，替代品牌图标 */
  backTo?: string;
  onRefresh?: () => void;
  /** 标题右侧的附加信息（在线数量、状态徽标等） */
  children?: React.ReactNode;
}) {
  const loggedIn = !!getToken();
  return (
    <>
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-3">
          {backTo ? (
            <Button variant="ghost" size="icon" asChild title="返回状态页">
              <Link to={backTo}>
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
          ) : (
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Radio className="size-4" />
            </div>
          )}
          <div className="mr-auto min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-bold leading-none">
              {icon}
              <span className="truncate">{title}</span>
            </div>
            {subtitle && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{subtitle}</div>}
          </div>
          {children}
          <ThemeToggle />
          {onRefresh && (
            <Button variant="outline" size="icon" title="刷新" onClick={onRefresh}>
              <RefreshCw className="size-4" />
            </Button>
          )}
          <Button variant={loggedIn ? "default" : "outline"} size="sm" asChild>
            <Link to={loggedIn ? "/overview" : "/login"} title={loggedIn ? "进入后台" : "后台登录"}>
              <LogIn className="size-4" />
              <span className="hidden sm:inline">{loggedIn ? "进入后台" : "后台登录"}</span>
            </Link>
          </Button>
        </div>
      </header>
      {isMock() && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
          Mock 数据模式：当前展示本地示例数据
        </div>
      )}
    </>
  );
}
