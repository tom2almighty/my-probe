import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Activity,
  BellRing,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Radio,
  Server as ServerIcon,
  Waypoints,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, isMock, setToken } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { ChangePasswordDialog } from "@/components/change-password";
import { ThemeToggle } from "@/components/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { to: "/overview", label: "概览", icon: LayoutDashboard },
  { to: "/servers", label: "服务器", icon: ServerIcon },
  { to: "/probes", label: "延迟探测", icon: Waypoints },
  { to: "/alerts", label: "告警与通知", icon: BellRing },
];

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Radio className="size-4" />
      </div>
      <div>
        <div className="text-sm font-bold leading-none">MyProbe</div>
        <div className="text-[11px] text-muted-foreground">服务器监控</div>
      </div>
    </div>
  );
}

export default function Layout() {
  const navigate = useNavigate();
  const { data: me } = useAsync(() => api.me(), []);
  const username = me?.username ?? "admin";
  const [pwOpen, setPwOpen] = useState(false);

  const logout = () => {
    setToken(null);
    navigate("/login");
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-muted/30">
      {/* 侧边栏（lg 以上固定显示） */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-14 items-center border-b px-4">
          <Brand />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1 border-t p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent"
              >
                <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                  {username.slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 truncate">
                  <div className="font-medium">{username}</div>
                  <div className="text-[11px] text-muted-foreground">管理员</div>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel>{username}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/">
                  <Globe /> 公开页面
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPwOpen(true)}>
                <KeyRound /> 修改密码
              </DropdownMenuItem>
              <DropdownMenuItem onClick={logout}>
                <LogOut /> 退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeToggle variant="ghost" />
        </div>
      </aside>

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <header className="flex items-center gap-2 border-b bg-background px-4 lg:hidden">
          <Brand />
          <nav className="ml-auto flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )
                }
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <ThemeToggle variant="ghost" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="rounded-md p-2 hover:bg-accent">
                <Activity className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem asChild>
                <Link to="/">
                  <Globe /> 公开页面
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPwOpen(true)}>
                <KeyRound /> 修改密码
              </DropdownMenuItem>
              <DropdownMenuItem onClick={logout}>
                <LogOut /> 退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {isMock() && (
          <div className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            <Badge variant="warning">Mock 数据模式</Badge>
            当前展示的是本地示例数据，不会连接真实后端。
          </div>
        )}

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}
