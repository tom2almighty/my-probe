//! 页面通用 hooks：实时事件订阅、数据加载、剪贴板。

import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { AuthError, connectPublicWs, connectUiWs, setToken } from "@/lib/api";
import type { UiEvent } from "@/lib/types";

/** 订阅主控推送的实时事件（自动重连，卸载时断开）。 */
export function useUiEvents(onEvent: (e: UiEvent) => void) {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => connectUiWs((e) => ref.current(e)), []);
}

/** 公开视图的实时事件（无需登录）。 */
export function usePublicEvents(onEvent: (e: UiEvent) => void) {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => connectPublicWs((e) => ref.current(e)), []);
}

/** 登录过期统一处理：清 token 回登录页。 */
export function useErrorHandler() {
  const navigate = useNavigate();
  return useCallback(
    (err: unknown, fallback = "请求失败") => {
      if (err instanceof AuthError) {
        setToken(null);
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : fallback);
    },
    [navigate],
  );
}

interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/** 拉取一次数据 + 手动 reload。deps 变化时重新拉取。 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const onError = useErrorHandler();
  const fnRef = useRef(fn);
  const errRef = useRef(onError);
  useEffect(() => {
    fnRef.current = fn;
    errRef.current = onError;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 由调用方声明，nonce 用于手动 reload
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => {
        if (alive) errRef.current(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, reload, setData };
}

/** 复制到剪贴板，带 2s 成功态。 */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast.error("复制失败，请手动选择文本"));
    } else {
      toast.error("当前环境不支持自动复制，请手动选择文本");
    }
  }, []);
  return [copied, copy];
}
