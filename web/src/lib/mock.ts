//! Mock 数据：本地预览前端样式用（`?mock` 或 VITE_MOCK=1 时启用）。
//! 合成样本是稳定的，覆盖在线/离线/临期/高负载/丢包等状态。

import { DEFAULT_CURRENCY } from "./money";
import { makeTraffic, usedBy } from "./traffic";
import type {
  AlertRules,
  LatencyBand,
  LatencyScheme,
  MetricPoint,
  Probe,
  ProbePoint,
  RenewCycle,
  Server,
  StatusResp,
  TrafficCycle,
  TrafficMode,
  UiEvent,
} from "./types";

const now = Date.now();
const HOUR = 3600_000;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

let rngState = 8888;
/** 模块初始化用的线性同余随机数。 */
function rnd(): number {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function between(min: number, max: number): number {
  return min + rnd() * (max - min);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 稳定伪随机：同样的 (a, b, i) 永远得到同一个值，重新拉取曲线不会跳变。 */
function hashRnd(a: number, b: number, i: number): number {
  let h = Math.imul(a, 73_856_093) ^ Math.imul(b, 19_349_663) ^ Math.imul(i, 83_492_791);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

export interface MockServer extends Server {
  metrics: MetricPoint[];
}

/** 探测目标是独立实体，server_ids 决定由哪些客户端执行。 */
export interface MockProbe extends Probe {
  server_ids: number[];
  /** 基准延迟与丢包率，用于合成各客户端上的曲线。 */
  base_latency_ms: number;
  loss_rate: number;
}

function makeMetrics(hours: number, baseCpu: number, baseMemPct: number): MetricPoint[] {
  const pts: MetricPoint[] = [];
  const n = hours * 12; // 5 分钟一个点
  const memTotal = 16 * 1024 ** 3;
  for (let i = 0; i < n; i++) {
    const t = now - (hours - i / 12) * HOUR;
    const wave = Math.sin(i / 6) * baseCpu * 0.25;
    const spike = rnd() > 0.94 ? between(20, 45) : 0;
    pts.push({
      ts: Math.round(t),
      cpu: Math.max(1, Math.min(99, baseCpu + wave + spike)),
      mem_used: Math.round(memTotal * baseMemPct * (1 + Math.sin(i / 9) * 0.05)),
      mem_total: memTotal,
      disk_used: 500 * 1024 ** 3 + i * 50_000_000,
      disk_total: 1024 * 1024 ** 3,
      net_in: Math.round(between(2, 120) * 1024),
      net_out: Math.round(between(5, 400) * 1024),
      load1: between(0.1, 4.5),
      uptime: 3600 * 24 * 5 + i * 300,
    });
  }
  return pts;
}

interface ServerCfg {
  daysLeft: number | null;
  price: number;
  cycle: RenewCycle;
  /** 永不到期，置真时 daysLeft 作废 */
  never?: boolean;
  /** 续费价格的币种，默认人民币 */
  currency?: string;
  cpu: number;
  mem: number;
  /** 流量套餐与本周期累计，覆盖限额 / 不限额 / 到量几种展示 */
  traffic: TrafficCfg;
}

interface TrafficCfg {
  /** 周期限额（字节），0 = 不限制 */
  limit: number;
  mode: TrafficMode;
  /** 每月重置日 1-28，0 = 不重置 */
  resetDay: number;
  /** 本周期已累计的下行 / 上行 */
  rx: number;
  tx: number;
}

/** 各预置节点的基准占用，合成任意时间窗的曲线时用。 */
const serverBase = new Map<number, ServerCfg>();

/** 演示后台"哪台还没更新"：4 号从未连上过，2 号停在旧版本。 */
function mockAgentVersion(id: number): string | null {
  if (id === 4) return null;
  if (id === 2) return "0.1.0";
  return "0.1.1";
}

function makeServer(id: number, name: string, country: string, online: boolean, cfg: ServerCfg): MockServer {
  serverBase.set(id, cfg);
  const metrics = makeMetrics(48, cfg.cpu, cfg.mem);
  return {
    id,
    name,
    country,
    note: online ? "" : "走维护通道中",
    enabled: true,
    // 永不到期的机器库里就没有日期，mock 照着来，前端拿到的形状和真主控一致
    expire_date:
      cfg.never || cfg.daysLeft == null
        ? null
        : new Date(now + cfg.daysLeft * 86_400_000).toISOString().slice(0, 10),
    never_expire: !!cfg.never,
    renew_price: cfg.price,
    renew_cycle: cfg.cycle,
    currency: cfg.currency ?? DEFAULT_CURRENCY,
    report_interval_s: 5,
    created_at: new Date(now - 120 * HOUR).toISOString(),
    last_seen: online ? now - 15_000 : now - 22 * 60_000,
    online,
    days_to_expire: cfg.never ? null : cfg.daysLeft,
    secret_preview: "ab12****ef",
    agent_version: mockAgentVersion(id),
    traffic: makeTraffic(
      { limit_bytes: cfg.traffic.limit, mode: cfg.traffic.mode, reset_day: cfg.traffic.resetDay },
      cfg.traffic.rx,
      cfg.traffic.tx,
    ),
    latest: online ? metrics[metrics.length - 1] : null,
    metrics,
  };
}

export const mockServers: MockServer[] = [
  makeServer(1, "东京主站", "jp", true, {
    daysLeft: 45,
    price: 99,
    cycle: "month",
    cpu: 34,
    mem: 0.46,
    traffic: { limit: 2 * TB, mode: "sum", resetDay: 1, rx: 0.82 * TB, tx: 0.41 * TB },
  }),
  // 快到量：用来看告警阈值那条黄线
  makeServer(2, "香港节点", "hk", true, {
    daysLeft: 3,
    price: 128,
    cycle: "quarter",
    cpu: 62,
    mem: 0.71,
    traffic: { limit: 1 * TB, mode: "max", resetDay: 5, rx: 0.94 * TB, tx: 0.36 * TB },
  }),
  // 不限流量：界面上不应该出现进度条；同时是永久 + 免费的机器（甲骨文那种）
  makeServer(3, "新加坡", "sg", true, {
    daysLeft: null,
    never: true,
    price: 0,
    cycle: "free",
    cpu: 18,
    mem: 0.28,
    traffic: { limit: 0, mode: "sum", resetDay: 1, rx: 3.4 * TB, tx: 1.1 * TB },
  }),
  // 已超额，且按「仅上传」计费
  makeServer(4, "美西洛杉矶", "us", false, {
    daysLeft: -2,
    price: 12,
    cycle: "month",
    currency: "USD",
    cpu: 12,
    mem: 0.2,
    traffic: { limit: 500 * GB, mode: "up", resetDay: 10, rx: 120 * GB, tx: 521 * GB },
  }),
  makeServer(5, "德国法兰克福", "de", true, {
    daysLeft: 210,
    price: 49,
    cycle: "year",
    currency: "EUR",
    cpu: 51,
    mem: 0.55,
    traffic: { limit: 20 * TB, mode: "sum", resetDay: 15, rx: 2.1 * TB, tx: 1.02 * TB },
  }),
  // 不按周期重置（长期总量套餐）
  makeServer(6, "韩国首尔", "kr", false, {
    daysLeft: 0,
    price: 77,
    cycle: "month",
    cpu: 22,
    mem: 0.35,
    traffic: { limit: 1 * TB, mode: "down", resetDay: 0, rx: 0.22 * TB, tx: 0.08 * TB },
  }),
];

/** 已归档的历史周期：从本周期起点逐月往前推，用量围绕当前值波动。 */
export function mockTrafficCycles(s: MockServer, n = 6): TrafficCycle[] {
  // 不分周期就没有归档；新建的机器还没跑满一个周期
  if (!s.traffic.cycle_start || (!s.traffic.rx && !s.traffic.tx)) return [];
  const rows: TrafficCycle[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(s.traffic.cycle_start);
    d.setUTCMonth(d.getUTCMonth() - i);
    const k = 0.55 + hashRnd(s.id, 91, i) * 0.85;
    const rx = Math.round(s.traffic.rx * k);
    const tx = Math.round(s.traffic.tx * k);
    rows.push({ cycle_start: d.getTime(), rx, tx, used: usedBy(s.traffic.mode, rx, tx) });
  }
  return rows;
}

/**
 * 整机指标曲线：按请求的时间窗与点数合成，形状只取决于时间戳，反复拉取不跳变。
 * 与主控一致 —— 原始样本（15 秒一条）多于请求点数时按桶聚合：主字段是均值，另带桶内峰值。
 */
export function mockMetricSeries(serverId: number, sinceMs: number, points = 288): MetricPoint[] {
  const cfg = serverBase.get(serverId);
  const srv = mockServers.find((s) => s.id === serverId);
  if (!cfg || !srv) return [];
  const end = Date.now();
  const cutoff = srv.online ? end : srv.last_seen;
  const span = Math.max(10 * 60_000, end - sinceMs);
  const n = clamp(Math.round(points), 2, 1000);
  const agg = span / 15_000 > n;
  const memTotal = 16 * 1024 ** 3;
  const diskTotal = 1024 * 1024 ** 3;
  const rows: MetricPoint[] = [];
  for (let i = n; i >= 0; i--) {
    const ts = Math.round(end - (i * span) / n);
    if (ts > cutoff) continue;
    const r = hashRnd(serverId, 7, i);
    // 以天为周期的起伏 + 稳定抖动，长范围下也有明显的忙闲差别
    const day = Math.sin((ts / 86_400_000) * Math.PI * 2) * cfg.cpu * 0.22;
    const cpu = clamp(cfg.cpu + day + Math.sin(i / 7 + serverId) * cfg.cpu * 0.1 + (r - 0.5) * 6, 1, 99);
    const netIn = Math.round((20 + hashRnd(serverId, 11, i) * 110) * 1024);
    const netOut = Math.round((40 + hashRnd(serverId, 13, i) * 360) * 1024);
    const load1 = clamp(cpu / 22 + (hashRnd(serverId, 17, i) - 0.4) * 0.9, 0.05, 12);
    const row: MetricPoint = {
      ts,
      cpu,
      mem_used: Math.round(memTotal * cfg.mem * (1 + Math.sin(i / 9 + serverId) * 0.06)),
      mem_total: memTotal,
      disk_used: Math.round(diskTotal * (0.35 + (serverId % 5) * 0.09) + (n - i) * 40_000_000),
      disk_total: diskTotal,
      net_in: netIn,
      net_out: netOut,
      load1,
      uptime: Math.max(60, Math.round((ts - (end - 5 * 86_400_000)) / 1000)),
    };
    if (agg) {
      // 桶内峰值：偶发尖刺不会被均值抹平
      row.cpu_max = clamp(cpu + (r > 0.88 ? 18 + r * 28 : 3 + r * 8), 1, 100);
      row.net_in_max = Math.round(netIn * (1.3 + r * 1.2));
      row.net_out_max = Math.round(netOut * (1.25 + r * 1.1));
      row.load1_max = clamp(load1 * (1.25 + r * 0.8), 0.05, 16);
    }
    rows.push(row);
  }
  return rows;
}

function makeProbe(
  id: number,
  name: string,
  target: string,
  protocol: "tcp" | "icmp",
  port: number | null,
  serverIds: number[],
  baseLatency: number,
  lossRate: number,
  enabled = true,
  bands: LatencyBand[] | null = null,
  schemeId: number | null = null,
): MockProbe {
  return {
    id,
    name,
    target,
    protocol,
    port,
    timeout_ms: 5000,
    interval_s: 60,
    enabled,
    server_ids: serverIds,
    base_latency_ms: baseLatency,
    loss_rate: lossRate,
    latency_bands: bands,
    latency_scheme_id: schemeId,
  };
}

/**
 * 命名配色方案：把「优化线路 / 跨洋直连」这类分组落到阈值上，
 * 同类线路引用同一套，改方案就等于改所有引用它的目标。
 */
export const mockLatencySchemes: LatencyScheme[] = [
  {
    id: 1,
    name: "优化线路",
    bands: [{ max_ms: 60, color: "#22c55e" }, { max_ms: 120, color: "#f59e0b" }, { color: "#ef4444" }],
  },
  {
    id: 2,
    name: "跨洋直连",
    bands: [
      { max_ms: 140, color: "#22c55e" },
      { max_ms: 260, color: "#3b82f6" },
      { max_ms: 400, color: "#f59e0b" },
      { color: "#ef4444" },
    ],
  },
];

/** 探测目标跨客户端复用：同一个目标可以对比不同机房的延迟。 */
export const mockProbes: MockProbe[] = [
  makeProbe(1, "主站 HTTPS", "www.example.com", "tcp", 443, [1, 2, 3, 5], 38, 0.004),
  makeProbe(2, "主站 ICMP", "www.example.com", "icmp", null, [1, 2, 3, 5, 6], 32, 0.05),
  makeProbe(3, "数据库", "10.0.0.5", "tcp", 3306, [1, 5], 11, 0),
  // 跨洋链路本来就慢，引用放宽了阈值的方案
  makeProbe(4, "备用节点", "2001:db8::1", "tcp", 22, [3, 4], 96, 0.02, true, null, 2),
  // 优化线路，阈值比全局默认更严
  makeProbe(5, "CDN 边缘", "cdn.example.com", "icmp", null, [2, 3], 19, 0.001, true, null, 1),
  makeProbe(6, "旧监控入口", "old.example.com", "tcp", 80, [], 0, 0, false),
];

/**
 * 某探测在某客户端上的延迟曲线：抖动 + 偶发尖刺 + 成片丢包。
 * 离线客户端的数据停在最后一次上报之前，和真实情况一致。
 * 同样跟随主控的聚合规则：样本数超过请求点数时给出桶内均值 / 峰值 / 丢包比例。
 */
export function mockProbeSeries(
  probeId: number,
  serverId: number,
  sinceMs: number,
  points = 240,
): ProbePoint[] {
  const p = mockProbes.find((x) => x.id === probeId);
  const srv = mockServers.find((s) => s.id === serverId);
  // 每台机器一个稳定的基线倍率与丢包倍率：多节点同图对比时几条线不会叠在一起
  const level = 0.65 + hashRnd(serverId, 7, 13) * 1.15;
  const base = Math.max(4, ((p?.base_latency_ms ?? 40) + (serverId % 4) * 7) * level);
  const loss = (p?.loss_rate ?? 0) * (0.3 + hashRnd(serverId, 3, 29) * 2.4);
  const end = Date.now();
  const cutoff = srv && !srv.online ? srv.last_seen : end;
  const span = Math.max(10 * 60_000, end - sinceMs);
  const agg = span / ((p?.interval_s ?? 60) * 1000) > points;
  const rows: ProbePoint[] = [];
  let burst = 0;
  for (let i = points; i >= 0; i--) {
    const r = hashRnd(probeId, serverId, i);
    // 丢包按“突发”出现，比逐点随机更接近真实网络
    if (burst > 0) burst--;
    else if (r < loss) burst = 1 + Math.floor(hashRnd(i, probeId, serverId) * 3);
    const ts = Math.round(end - (i * span) / points);
    if (ts > cutoff) continue;
    const wave = Math.sin(i / 9 + serverId) * base * 0.16;
    const jitter = (hashRnd(serverId, i, probeId) - 0.5) * base * 0.3;
    const spike = hashRnd(probeId, i, serverId) > 0.975 ? base * (0.8 + r) : 0;
    const ms = Math.max(1, base + wave + jitter + spike);
    if (!agg) {
      const ok = burst === 0;
      rows.push({ ts, ok, latency_ms: ok ? ms : null });
      continue;
    }
    // 聚合桶：突发期成片丢包，平时偶尔掉一两个包
    const frac = burst > 0 ? Math.min(1, 0.3 + r * 0.9) : r < loss * 4 ? 0.02 + r * 0.08 : 0;
    rows.push(
      frac >= 1
        ? { ts, ok: false, latency_ms: null, loss: 1 }
        : { ts, ok: true, latency_ms: ms, latency_max: ms * (1.2 + r * 0.9), loss: frac },
    );
  }
  return rows;
}

/** 由曲线反推最近 24h 统计，保证列表数字和图表对得上。 */
export function mockProbeStat(probeId: number, serverId: number) {
  const rows = mockProbeSeries(probeId, serverId, Date.now() - 24 * HOUR, 288);
  if (rows.length === 0) return { last: null, ok_24h: null, avg_latency_ms: null };
  const ok = rows.filter((r) => r.latency_ms != null);
  const lost = rows.reduce((a, r) => a + (r.loss ?? (r.ok ? 0 : 1)), 0);
  return {
    last: rows[rows.length - 1],
    ok_24h: 1 - lost / rows.length,
    avg_latency_ms: ok.length ? ok.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / ok.length : null,
  };
}

export const mockStatus: StatusResp = {
  total: mockServers.length,
  online: mockServers.filter((s) => s.online).length,
  offline: mockServers.filter((s) => !s.online).length,
  probes: mockProbes.filter((p) => p.enabled).length,
  expiring: mockServers
    .filter((s) => s.days_to_expire != null && s.days_to_expire <= 7)
    .map((s) => ({
      id: s.id,
      name: s.name,
      days_to_expire: s.days_to_expire,
      expire_date: s.expire_date,
      renew_price: s.renew_price,
      renew_cycle: s.renew_cycle,
      currency: s.currency,
    })),
};

export const mockAlertRules: AlertRules = {
  cpu_threshold: 85,
  mem_threshold: 85,
  disk_threshold: 90,
  latency_threshold_ms: 300,
  expire_days: 7,
  traffic_threshold_pct: 80,
  cpu_enabled: true,
  mem_enabled: true,
  disk_enabled: false,
  latency_enabled: true,
  offline_enabled: true,
  expire_enabled: true,
  traffic_enabled: true,
};

export const mockNotifiers = [
  {
    id: 1,
    name: "运维 Telegram",
    type: "telegram",
    enabled: true,
    config: { bot_token: "123456:ABC-DEF...", chat_id: "-1001234567890" },
  },
];

/** 模拟实时事件流：每几秒推一条指标 / 探测更新。 */
export function subscribeMockEvents(onEvent: (e: UiEvent) => void): () => void {
  const srv = mockServers[0];
  const probes = mockProbes.filter((p) => p.enabled && p.server_ids.includes(srv.id));
  const last = srv.metrics[srv.metrics.length - 1];
  let cpu = last.cpu;
  let i = 0;
  const timer = window.setInterval(() => {
    i++;
    const ts = Date.now();
    if (i % 2 === 0) {
      cpu = Math.max(1, Math.min(99, cpu + (rnd() - 0.5) * 8));
      onEvent({
        type: "metrics",
        server_id: srv.id,
        ts,
        cpu,
        mem_used: last.mem_used,
        mem_total: last.mem_total,
        disk_used: last.disk_used,
        disk_total: last.disk_total,
        net_in: last.net_in,
        net_out: last.net_out,
        load1: last.load1,
        uptime: last.uptime + i * 5,
        // 用量只增不减，能看出进度条在动
        traffic_used: Math.round(srv.traffic.used + i * 3 * 1024 ** 2),
      });
    } else if (probes.length > 0) {
      const p = probes[i % probes.length];
      const ok = rnd() > p.loss_rate;
      onEvent({
        type: "probe",
        probe_id: p.id,
        server_id: srv.id,
        ts,
        ok,
        latency_ms: ok ? p.base_latency_ms + (rnd() - 0.5) * 14 : null,
      });
    }
  }, 3000);
  return () => window.clearInterval(timer);
}
