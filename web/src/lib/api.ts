//! API 客户端。前端带 `?mock` 或 VITE_MOCK=1 时走本地 mock，无需后端。

import { DEFAULT_BANDS, resolveBands } from "./latency";
import {
  type MockProbe,
  type MockServer,
  mockAlertRules,
  mockMetricSeries,
  mockNotifiers,
  mockProbeSeries,
  mockProbeStat,
  mockProbes,
  mockServers,
  mockStatus,
  mockTrafficCycles,
  subscribeMockEvents,
} from "./mock";
import { makeTraffic, usedBy } from "./traffic";
import type {
  AlertRules,
  CreateServerResp,
  LatencyBand,
  LoginResp,
  MetricPoint,
  NotifierConfig,
  Probe,
  ProbeInput,
  ProbeItem,
  ProbePoint,
  ProbeTargetStat,
  ProbeView,
  PublicOverview,
  Server,
  ServerDetail,
  ServerInput,
  StatusResp,
  Traffic,
  UiEvent,
} from "./types";

const TOKEN_KEY = "mp_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isMock(): boolean {
  return new URLSearchParams(window.location.search).has("mock") || import.meta.env.VITE_MOCK === "1";
}

export class AuthError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    throw new AuthError("登录已过期，请重新登录");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in (data as object)
        ? ((data as { error?: string }).error ?? "请求失败")
        : `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

/** 断线自动重连的事件源。 */
function connectWs(url: () => string, onEvent: (e: UiEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;
  const connect = () => {
    ws = new WebSocket(url());
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as UiEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(connect, 3000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    ws?.close();
  };
}

const wsProto = () => (location.protocol === "https:" ? "wss" : "ws");

/** 后台实时事件源（需要登录）。 */
export function connectUiWs(onEvent: (e: UiEvent) => void): () => void {
  if (isMock()) return subscribeMockEvents(onEvent);
  const token = getToken();
  if (!token) return () => {};
  return connectWs(() => `${wsProto()}://${location.host}/ws/ui?token=${encodeURIComponent(token)}`, onEvent);
}

/** 公开视图实时事件源（无需登录）。 */
export function connectPublicWs(onEvent: (e: UiEvent) => void): () => void {
  if (isMock()) return subscribeMockEvents(onEvent);
  return connectWs(() => `${wsProto()}://${location.host}/ws/public`, onEvent);
}

export interface ApiClient {
  login(u: string, p: string): Promise<LoginResp>;
  me(): Promise<{ username: string }>;
  changePassword(oldP: string, newP: string): Promise<void>;
  status(): Promise<StatusResp>;
  servers(): Promise<Server[]>;
  server(id: number): Promise<ServerDetail>;
  createServer(body: ServerInput): Promise<CreateServerResp>;
  updateServer(id: number, body: ServerInput): Promise<void>;
  deleteServer(id: number): Promise<void>;
  rotateSecret(id: number): Promise<{ secret: string }>;
  /** 手动校正本周期流量；`usedBytes` 省略表示归零 */
  resetTraffic(id: number, usedBytes?: number): Promise<{ traffic: Traffic }>;
  /** 该客户端当前执行的探测目标 */
  serverProbes(id: number): Promise<ProbeView[]>;
  /** 覆盖该客户端执行的探测目标 */
  setServerProbes(id: number, probeIds: number[]): Promise<void>;
  probes(): Promise<ProbeItem[]>;
  createProbe(body: ProbeInput): Promise<Probe>;
  updateProbe(pid: number, body: ProbeInput): Promise<void>;
  deleteProbe(pid: number): Promise<void>;
  /** 覆盖执行该探测的客户端 */
  assignProbeServers(pid: number, serverIds: number[]): Promise<void>;
  /** 全局默认延迟配色（未单独配置的探测目标都跟着它） */
  latencyBands(): Promise<LatencyBand[]>;
  saveLatencyBands(bands: LatencyBand[]): Promise<void>;
  metrics(id: number, sinceMs?: number, points?: number): Promise<MetricPoint[]>;
  probeHistory(pid: number, serverId: number | null, sinceMs: number, points?: number): Promise<ProbePoint[]>;
  alerts(): Promise<AlertRules>;
  updateAlerts(r: AlertRules): Promise<void>;
  notifiers(): Promise<NotifierConfig[]>;
  updateNotifiers(list: NotifierConfig[]): Promise<void>;
  testNotifier(cfg: NotifierConfig): Promise<{ ok: boolean; error?: string }>;
  // ---- 公开视图（无需登录） ----
  publicOverview(): Promise<PublicOverview>;
  publicMetrics(id: number, sinceMs?: number, points?: number): Promise<MetricPoint[]>;
  publicProbeHistory(
    pid: number,
    serverId: number | null,
    sinceMs: number,
    points?: number,
  ): Promise<ProbePoint[]>;
}

/** 拼查询串，null / undefined 的参数直接省略。 */
function qs(params: Record<string, number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

const realApi: ApiClient = {
  login: (u, p) =>
    request("/api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) }),
  me: () => request("/api/me"),
  changePassword: (oldP, newP) =>
    request("/api/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldP, new_password: newP }),
    }).then(() => undefined),
  status: () => request("/api/status"),
  servers: () => request("/api/servers"),
  server: (id) => request(`/api/servers/${id}`),
  createServer: (body) => request("/api/servers", { method: "POST", body: JSON.stringify(body) }),
  updateServer: (id, body) =>
    request(`/api/servers/${id}`, { method: "PUT", body: JSON.stringify(body) }).then(() => undefined),
  deleteServer: (id) => request(`/api/servers/${id}`, { method: "DELETE" }).then(() => undefined),
  rotateSecret: (id) => request(`/api/servers/${id}/rotate-secret`, { method: "POST" }),
  resetTraffic: (id, usedBytes) =>
    request(`/api/servers/${id}/traffic/reset`, {
      method: "POST",
      body: JSON.stringify({ used_bytes: usedBytes ?? null }),
    }),
  serverProbes: (id) => request(`/api/servers/${id}/probes`),
  setServerProbes: (id, probeIds) =>
    request(`/api/servers/${id}/probes`, {
      method: "PUT",
      body: JSON.stringify({ probe_ids: probeIds }),
    }).then(() => undefined),
  probes: () => request("/api/probes"),
  createProbe: (body) => request("/api/probes", { method: "POST", body: JSON.stringify(body) }),
  updateProbe: (pid, body) =>
    request(`/api/probes/${pid}`, { method: "PUT", body: JSON.stringify(body) }).then(() => undefined),
  deleteProbe: (pid) => request(`/api/probes/${pid}`, { method: "DELETE" }).then(() => undefined),
  assignProbeServers: (pid, serverIds) =>
    request(`/api/probes/${pid}/servers`, {
      method: "PUT",
      body: JSON.stringify({ server_ids: serverIds }),
    }).then(() => undefined),
  latencyBands: () => request("/api/latency-bands"),
  saveLatencyBands: (bands) =>
    request("/api/latency-bands", { method: "PUT", body: JSON.stringify(bands) }).then(() => undefined),
  metrics: (id, sinceMs, points) => request(`/api/servers/${id}/metrics${qs({ since_ms: sinceMs, points })}`),
  probeHistory: (pid, serverId, sinceMs, points) =>
    request(`/api/probes/${pid}/history${qs({ since_ms: sinceMs, points, server_id: serverId })}`),
  alerts: () => request("/api/alerts"),
  updateAlerts: (r) =>
    request("/api/alerts", { method: "PUT", body: JSON.stringify(r) }).then(() => undefined),
  notifiers: () => request("/api/notifiers"),
  updateNotifiers: (list) =>
    request("/api/notifiers", { method: "PUT", body: JSON.stringify(list) }).then(() => undefined),
  testNotifier: (cfg) => request("/api/notifiers/test", { method: "POST", body: JSON.stringify(cfg) }),
  publicOverview: () => request("/api/public/overview"),
  publicMetrics: (id, sinceMs, points) =>
    request(`/api/public/servers/${id}/metrics${qs({ since_ms: sinceMs, points })}`),
  publicProbeHistory: (pid, serverId, sinceMs, points) =>
    request(`/api/public/probes/${pid}/history${qs({ since_ms: sinceMs, points, server_id: serverId })}`),
};

// ---- mock 实现（内存态，支持增删改，刷新后重置） ----

const state = {
  servers: mockServers.map((s) => structuredClone(s)) as MockServer[],
  probes: mockProbes.map((p) => structuredClone(p)) as MockProbe[],
  alerts: structuredClone(mockAlertRules) as AlertRules,
  notifiers: structuredClone(mockNotifiers) as NotifierConfig[],
  status: structuredClone(mockStatus) as StatusResp,
  bands: structuredClone(DEFAULT_BANDS) as LatencyBand[],
};

const mockDelay = <T>(v: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(v), 120));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recountStatus() {
  state.status.total = state.servers.length;
  state.status.online = state.servers.filter((s) => s.online).length;
  state.status.offline = state.status.total - state.status.online;
  state.status.probes = state.probes.filter((p) => p.enabled).length;
  state.status.expiring = state.servers
    .filter((s) => s.days_to_expire != null && s.days_to_expire <= 7)
    .map((s) => ({
      id: s.id,
      name: s.name,
      days_to_expire: s.days_to_expire,
      expire_date: s.expire_date,
      renew_price: s.renew_price,
      renew_cycle: s.renew_cycle,
    }));
}

/** 去掉 mock 内部字段，只留接口里的探测目标。 */
function probeFields(p: MockProbe): Probe {
  return {
    id: p.id,
    name: p.name,
    target: p.target,
    protocol: p.protocol,
    port: p.port,
    timeout_ms: p.timeout_ms,
    interval_s: p.interval_s,
    enabled: p.enabled,
    latency_bands: p.latency_bands ? p.latency_bands.map((b) => ({ ...b })) : null,
  };
}

/** 主控在接口里就把全局默认回退好了，mock 也照做，前端不用再兜一次。 */
function effectiveBands(p: MockProbe): LatencyBand[] {
  return resolveBands(p.latency_bands, state.bands);
}

/** 只有预置样本有历史曲线，界面上新建的探测显示“暂无数据”。 */
function statFor(pid: number, serverId: number) {
  if (!mockProbes.some((x) => x.id === pid)) return { last: null, ok_24h: null, avg_latency_ms: null };
  return mockProbeStat(pid, serverId);
}

function probeItem(p: MockProbe, publicOnly = false): ProbeItem {
  const targets: ProbeTargetStat[] = state.servers
    .filter((s) => p.server_ids.includes(s.id))
    .filter((s) => !publicOnly || s.enabled)
    .map((s) => ({
      server_id: s.id,
      server_name: s.name,
      country: s.country,
      online: s.online,
      ...statFor(p.id, s.id),
    }));
  return { ...probeFields(p), bands: effectiveBands(p), server_ids: [...p.server_ids], targets };
}

function probeViewFor(p: MockProbe, serverId: number): ProbeView {
  return { ...probeFields(p), bands: effectiveBands(p), ...statFor(p.id, serverId) };
}

function applyProbeInput(p: MockProbe, body: ProbeInput) {
  p.name = body.name;
  p.target = body.target;
  p.protocol = body.protocol;
  p.port = body.port;
  p.timeout_ms = body.timeout_ms;
  p.interval_s = body.interval_s;
  p.enabled = body.enabled;
  p.server_ids = [...body.server_ids];
  p.latency_bands = body.latency_bands ? body.latency_bands.map((b) => ({ ...b })) : null;
}

const mockApi: ApiClient = {
  async login(u, p) {
    await sleep(350);
    if (!u || p.length < 4) throw new Error("请输入用户名和至少 4 位密码");
    return { token: "mock-token", username: u };
  },
  me: async () => mockDelay({ username: "admin" }),
  async changePassword() {
    await sleep(200);
  },
  status: async () => mockDelay(state.status),
  servers: async () => mockDelay<Server[]>(state.servers),
  async server(id) {
    const s = state.servers.find((x) => x.id === id);
    if (!s) throw new Error("服务器不存在");
    const probes = state.probes.filter((p) => p.server_ids.includes(id)).map((p) => probeViewFor(p, id));
    return mockDelay({ ...s, probes, traffic_history: mockTrafficCycles(s) });
  },
  async createServer(body) {
    await sleep(200);
    const id = Math.max(0, ...state.servers.map((s) => s.id)) + 1;
    const s: MockServer = {
      id,
      name: body.name,
      country: body.country,
      note: body.note,
      enabled: body.enabled,
      expire_date: body.expire_date,
      renew_price: body.renew_price,
      renew_cycle: body.renew_cycle,
      report_interval_s: body.report_interval_s,
      created_at: new Date().toISOString(),
      last_seen: 0,
      online: false,
      days_to_expire: daysTo(body.expire_date),
      secret_preview: "ab12****ef",
      agent_version: null, // 新建的机器还没连上来，版本要等 Agent 自报
      traffic: planOf(body, 0, 0),
      latest: null,
      metrics: [],
    };
    state.servers.push(s);
    recountStatus();
    return { ...(s as Server), secret: `mock-secret-${id}-a1b2c3d4e5f60718` };
  },
  async updateServer(id, body) {
    await sleep(200);
    const s = state.servers.find((x) => x.id === id);
    if (!s) throw new Error("服务器不存在");
    Object.assign(s, body, {
      days_to_expire: daysTo(body.expire_date),
      // 限额 / 口径 / 重置日变了要按新设置重算，累计的收发字节不动
      traffic: planOf(body, s.traffic.rx, s.traffic.tx),
    });
    recountStatus();
  },
  async resetTraffic(id, usedBytes) {
    await sleep(200);
    const s = state.servers.find((x) => x.id === id);
    if (!s) throw new Error("服务器不存在");
    const t = s.traffic;
    const target = usedBytes ?? 0;
    // 和主控一致：按现有上下行比例缩放到目标总量，没有比例可依时全记在计费方向上
    const k = t.used > 0 ? target / t.used : 0;
    const rx = t.used > 0 ? Math.round(t.rx * k) : t.mode === "up" ? 0 : target;
    const tx = t.used > 0 ? Math.round(t.tx * k) : t.mode === "up" ? target : 0;
    const used = usedBy(t.mode, rx, tx);
    s.traffic = { ...t, rx, tx, used, pct: t.limit > 0 ? (used / t.limit) * 100 : null };
    return { traffic: s.traffic };
  },
  async deleteServer(id) {
    await sleep(200);
    state.servers = state.servers.filter((s) => s.id !== id);
    for (const p of state.probes) p.server_ids = p.server_ids.filter((sid) => sid !== id);
    recountStatus();
  },
  async rotateSecret(id) {
    await sleep(200);
    return { secret: `mock-secret-${id}-rotate-x9y8z7w6v5u4` };
  },
  serverProbes: async (id) =>
    mockDelay(state.probes.filter((p) => p.server_ids.includes(id)).map((p) => probeViewFor(p, id))),
  async setServerProbes(id, probeIds) {
    await sleep(200);
    for (const p of state.probes) {
      const want = probeIds.includes(p.id);
      const has = p.server_ids.includes(id);
      if (want && !has) p.server_ids.push(id);
      if (!want && has) p.server_ids = p.server_ids.filter((sid) => sid !== id);
    }
  },
  probes: async () => mockDelay(state.probes.map((p) => probeItem(p))),
  async createProbe(body) {
    await sleep(200);
    const id = Math.max(0, ...state.probes.map((p) => p.id)) + 1;
    const p: MockProbe = {
      id,
      name: body.name,
      target: body.target,
      protocol: body.protocol,
      port: body.port,
      timeout_ms: body.timeout_ms,
      interval_s: body.interval_s,
      enabled: body.enabled,
      server_ids: [...body.server_ids],
      base_latency_ms: 40,
      loss_rate: 0,
      latency_bands: body.latency_bands ? body.latency_bands.map((b) => ({ ...b })) : null,
    };
    state.probes.push(p);
    recountStatus();
    return probeFields(p);
  },
  async updateProbe(pid, body) {
    await sleep(200);
    const p = state.probes.find((x) => x.id === pid);
    if (!p) throw new Error("探测目标不存在");
    applyProbeInput(p, body);
    recountStatus();
  },
  async deleteProbe(pid) {
    await sleep(200);
    state.probes = state.probes.filter((p) => p.id !== pid);
    recountStatus();
  },
  async assignProbeServers(pid, serverIds) {
    await sleep(200);
    const p = state.probes.find((x) => x.id === pid);
    if (!p) throw new Error("探测目标不存在");
    p.server_ids = [...serverIds];
  },
  latencyBands: async () => mockDelay(state.bands.map((b) => ({ ...b }))),
  async saveLatencyBands(bands) {
    await sleep(200);
    state.bands = bands.map((b) => ({ ...b }));
  },
  metrics: async (id, sinceMs, points) => {
    // 只有预置节点有历史曲线，界面上新建的服务器显示“暂无数据”
    if (!state.servers.some((s) => s.id === id)) throw new Error("服务器不存在");
    return mockDelay(mockMetricSeries(id, sinceMs ?? Date.now() - 3_600_000, points));
  },
  probeHistory: async (pid, serverId, sinceMs, points) => {
    const p = state.probes.find((x) => x.id === pid);
    if (!p) throw new Error("探测目标不存在");
    const sid = serverId ?? p.server_ids[0];
    if (sid == null) return mockDelay<ProbePoint[]>([]);
    return mockDelay(mockProbeSeries(pid, sid, sinceMs, points));
  },
  alerts: async () => mockDelay(state.alerts),
  async updateAlerts(r) {
    await sleep(200);
    state.alerts = r;
  },
  notifiers: async () => mockDelay(state.notifiers),
  async updateNotifiers(list) {
    await sleep(200);
    state.notifiers = list.map((n, i) => ({ ...n, id: n.id || i + 1 }));
  },
  async testNotifier(cfg) {
    await sleep(600);
    if (!cfg.config.bot_token || !cfg.config.chat_id) {
      return { ok: false, error: "Bot Token 与 Chat ID 均不能为空" };
    }
    return { ok: true };
  },
  publicOverview: async () => {
    const servers = state.servers
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        country: s.country,
        online: s.online,
        last_seen: s.last_seen,
        traffic: s.traffic,
        latest: s.latest,
      }));
    return mockDelay({
      servers,
      probes: state.probes.filter((p) => p.enabled).map((p) => probeItem(p, true)),
      online: servers.filter((s) => s.online).length,
      total: servers.length,
      ts: Date.now(),
    });
  },
  publicMetrics: async (id, sinceMs, points) => {
    const s = state.servers.find((x) => x.id === id && x.enabled);
    if (!s) throw new Error("服务器不存在");
    return mockApi.metrics(id, sinceMs, points);
  },
  publicProbeHistory: async (pid, serverId, sinceMs, points) => {
    const p = state.probes.find((x) => x.id === pid && x.enabled);
    if (!p) throw new Error("探测目标不存在");
    const visible = p.server_ids.filter((sid) => state.servers.some((s) => s.id === sid && s.enabled));
    const sid = serverId != null && visible.includes(serverId) ? serverId : visible[0];
    if (sid == null) return mockDelay<ProbePoint[]>([]);
    return mockDelay(mockProbeSeries(pid, sid, sinceMs, points));
  },
};

/** 表单里的三个流量字段 → 展示用的流量视图。 */
function planOf(body: ServerInput, rx: number, tx: number): Traffic {
  return makeTraffic(
    {
      limit_bytes: body.traffic_limit_bytes,
      mode: body.traffic_mode,
      reset_day: body.traffic_reset_day,
    },
    rx,
    tx,
  );
}

/** 到期天数（本地日期差） */
function daysTo(date: string | null): number | null {
  if (!date) return null;
  const target = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(target)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today.getTime()) / 86_400_000);
}

export const api: ApiClient = isMock() ? mockApi : realApi;
