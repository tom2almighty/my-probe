//! 主题：亮色 / 暗色 / 跟随系统三选一，选择存在 localStorage 里。
//! index.html 里有一段读同一个 key 的内联脚本，负责首屏渲染前就把 class 打上，避免闪一下白底。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "mp_theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const OPTIONS = [
  { value: "light" as const, label: "亮色", Icon: Sun },
  { value: "dark" as const, label: "暗色", Icon: Moon },
  { value: "system" as const, label: "系统", Icon: Monitor },
];

/** 没存过（或存了别的值）都按跟随系统处理。 */
function storedTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

interface ThemeState {
  /** 用户的选择，可能是 system */
  theme: Theme;
  /** 当前实际生效的外观 */
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setStored] = useState<Theme>(storedTheme);
  const [sysDark, setSysDark] = useState(systemDark);
  const resolved = theme === "system" ? (sysDark ? "dark" : "light") : theme;

  // 系统偏好可能随时变（比如 macOS 到点自动切深色），system 模式要跟着走
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Tailwind 的 dark 变体挂在 html.dark 上；color-scheme 让滚动条等原生控件一起变
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.setProperty("color-scheme", resolved);
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    setStored(t);
    // system 不落库，这样以后系统默认变了也能跟上
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  }, []);

  const value = useMemo<ThemeState>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 需要放在 ThemeProvider 内");
  return ctx;
}

/** 主题切换按钮：图标显示当前外观，菜单里可以显式选亮色 / 暗色 / 系统。 */
export function ThemeToggle({ variant = "outline" }: { variant?: "outline" | "ghost" }) {
  const { theme, resolved, setTheme } = useTheme();
  const Current = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size="icon" title="主题" aria-label="切换主题">
          <Current className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">主题</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon />
            {label}
            {theme === value && <Check className="ml-auto text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
