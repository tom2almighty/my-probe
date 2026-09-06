//! 与主控后端对应的 TS 类型。

export type RenewCycle = "month" | "quarter" | "half_year" | "year" | "none" | "free";

/** 流量计费口径。 */
export type TrafficMode = "up" | "down" | "sum" | "max";

/** 一台机器本周期的流量用量与限额。 */
export interface Traffic {
  /** 本周期下行累计（字节） */
  rx: number;
  /** 本周期上行累计（字节） */
  tx: number;
  /** 按计费口径折算的已用量 */
  used: number;
  /** 周期限额（字节），0 = 不限制 */
  limit: number;
  mode: TrafficMode;
  /** 每月重置日 1-28，0 = 不重置 */
  reset_day: number;
  /** 已用百分比；未设限额时为 null */
  pct: number | null;
  /** 当前周期起点（unix 毫秒），0 = 不分周期 */
  cycle_start: number;
  /** 下次重置时刻（unix 毫秒），不重置时为 null */
  next_reset: number | null;
}

/** 一个已结束的计费周期。 */
export interface TrafficCycle {
  cycle_start: number;
  rx: number;
  tx: number;
  /** 按当前计费口径折算的用量 */
  used: number;
}

export interface Server {
  id: number;
  name: string;
  country: string;
  note: string;
  enabled: boolean;
  expire_date: string | null;
  /** 永不到期：为真时 expire_date 恒为 null，days_to_expire 也是 null */
  never_expire: boolean;
  renew_price: number;
  renew_cycle: RenewCycle;
  /** 续费价格的币种，ISO 4217 三字母码 */
  currency: string;
  report_interval_s: number;
  created_at: string;
  last_seen: number;
  online: boolean;
  days_to_expire: number | null;
  secret_preview: string;
  /** Agent 上报的自身版本，从未连接过时为 null */
  agent_version: string | null;
  /** 本周期流量用量与限额 */
  traffic: Traffic;
  /** 最新一次上报的整机指标 */
  latest: MetricPoint | null;
}

/** 新建 / 编辑服务器的请求体（对应后端 ServerReq）。 */
export interface ServerInput {
  name: string;
  country: string;
  note: string;
  enabled: boolean;
  expire_date: string | null;
  never_expire: boolean;
  renew_price: number;
  renew_cycle: RenewCycle;
  currency: string;
  report_interval_s: number;
  /** 周期流量限额（字节），0 = 不限制 */
  traffic_limit_bytes: number;
  traffic_mode: TrafficMode;
  /** 每月重置日 1-28，0 = 不重置 */
  traffic_reset_day: number;
}

export interface CreateServerResp extends Server {
  secret: string;
}

export type Protocol = "tcp" | "icmp";

/** 延迟配色的一段：`max_ms` 为该段上限（含），最后一段省略表示无上限。 */
export interface LatencyBand {
  max_ms?: number | null;
  /** 6 位 hex，如 #22c55e */
  color: string;
}

/** 命名配色方案：同类线路共用一套阈值，改方案等于改所有引用它的目标。 */
export interface LatencyScheme {
  id: number;
  name: string;
  bands: LatencyBand[];
}

export interface Probe {
  id: number;
  name: string;
  target: string;
  protocol: Protocol;
  port: number | null;
  timeout_ms: number;
  interval_s: number;
  enabled: boolean;
  /** 该目标自定义的配色；null = 往下看方案 */
  latency_bands: LatencyBand[] | null;
  /** 引用的命名方案；null = 跟随全局默认。公开视图里恒为 null */
  latency_scheme_id: number | null;
}

export interface ProbeView extends Probe {
  /** 生效配色（后端已回退过方案与全局默认） */
  bands: LatencyBand[];
  last: ProbePoint | null;
  ok_24h: number | null;
  avg_latency_ms: number | null;
}

/** 探测目标在某个客户端上的运行情况。 */
export interface ProbeTargetStat {
  server_id: number;
  server_name: string;
  /** 两位国家码，可能为空串 */
  country: string;
  online: boolean;
  last: ProbePoint | null;
  ok_24h: number | null;
  avg_latency_ms: number | null;
  /** 这条指派生效的配色（指派覆盖 → 方案 → 全局默认），前端逐节点着色用 */
  bands: LatencyBand[];
  /** 指派上的覆盖状态，编辑弹窗靠它区分「跟随 / 方案 / 自定义」；未覆盖为 null */
  assign_bands: LatencyBand[] | null;
  assign_scheme_id: number | null;
}

/** 设置指派级配色的请求体。两者都为 null 表示清除覆盖、跟随目标配置。 */
export interface AssignmentBandsInput {
  bands: LatencyBand[] | null;
  scheme_id: number | null;
}

/** 探测列表条目：探测本身 + 指派的客户端。 */
export interface ProbeItem extends Probe {
  /** 生效配色（后端已回退过方案与全局默认） */
  bands: LatencyBand[];
  server_ids: number[];
  targets: ProbeTargetStat[];
}

/** 新建 / 编辑探测目标的请求体。 */
export interface ProbeInput {
  name: string;
  target: string;
  protocol: Protocol;
  port: number | null;
  timeout_ms: number;
  interval_s: number;
  enabled: boolean;
  server_ids: number[];
  /** null = 往下看方案 */
  latency_bands: LatencyBand[] | null;
  /** null = 跟随全局默认配色 */
  latency_scheme_id: number | null;
}

export interface ServerDetail extends Server {
  probes: ProbeView[];
  /** 已归档的历史计费周期，最近的在前 */
  traffic_history: TrafficCycle[];
}

/** 公开视图里的服务器（无密钥与资产信息）。 */
export interface PublicServer {
  id: number;
  name: string;
  country: string;
  online: boolean;
  last_seen: number;
  traffic: Traffic;
  latest: MetricPoint | null;
}

export interface PublicOverview {
  servers: PublicServer[];
  probes: ProbeItem[];
  online: number;
  total: number;
  ts: number;
}

/**
 * 一条整机指标样本。
 *
 * 长时间范围的历史查询由主控在 SQL 里按时间桶聚合：主字段是桶内均值，
 * `*_max` 是桶内峰值。未聚合的原始点不带峰值字段。
 */
export interface MetricPoint {
  ts: number;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  load1: number;
  uptime: number;
  cpu_max?: number;
  net_in_max?: number;
  net_out_max?: number;
  load1_max?: number;
}

/** 一条延迟探测样本。聚合点的 `latency_ms` 是桶内均值，另带峰值与丢包比例。 */
export interface ProbePoint {
  ts: number;
  ok: boolean;
  latency_ms: number | null;
  latency_max?: number;
  /** 桶内丢包比例（0-1）；原始点没有这个字段，用 ok 判断即可。 */
  loss?: number;
}

export interface StatusResp {
  total: number;
  online: number;
  offline: number;
  probes: number;
  expiring: {
    id: number;
    name: string;
    days_to_expire: number | null;
    expire_date: string | null;
    renew_price: number;
    renew_cycle: RenewCycle;
    currency: string;
  }[];
}

export interface AlertRules {
  cpu_threshold: number;
  mem_threshold: number;
  disk_threshold: number;
  latency_threshold_ms: number;
  expire_days: number;
  /** 本周期已用流量占限额的百分比阈值 */
  traffic_threshold_pct: number;
  cpu_enabled: boolean;
  mem_enabled: boolean;
  disk_enabled: boolean;
  latency_enabled: boolean;
  offline_enabled: boolean;
  expire_enabled: boolean;
  traffic_enabled: boolean;
}

export interface NotifierConfig {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, string>;
}

// 实时事件（来自 /ws/ui 与 /ws/public）
export type UiEvent =
  | { type: "server_status"; id: number; online: boolean; ts: number }
  | {
      type: "metrics";
      server_id: number;
      ts: number;
      cpu: number;
      mem_used: number;
      mem_total: number;
      disk_used: number;
      disk_total: number;
      net_in: number;
      net_out: number;
      load1: number;
      uptime: number;
      /** 本周期已用流量（已按计费口径折算）；老 Agent 不上报累计值时为 0 */
      traffic_used: number;
    }
  | { type: "probe"; probe_id: number; server_id: number; ts: number; ok: boolean; latency_ms: number | null }
  | { type: "servers_changed" };

export interface LoginResp {
  token: string;
  username: string;
}

export function defaultAlertRules(): AlertRules {
  return {
    cpu_threshold: 90,
    mem_threshold: 90,
    disk_threshold: 90,
    latency_threshold_ms: 500,
    expire_days: 7,
    traffic_threshold_pct: 80,
    cpu_enabled: false,
    mem_enabled: false,
    disk_enabled: false,
    latency_enabled: false,
    offline_enabled: true,
    expire_enabled: true,
    traffic_enabled: false,
  };
}

export const TRAFFIC_MODE_LABELS: Record<TrafficMode, string> = {
  up: "仅上传",
  down: "仅下载",
  sum: "上传 + 下载",
  max: "上下行取大",
};

export const RENEW_CYCLE_LABELS: Record<RenewCycle, string> = {
  month: "按月",
  quarter: "按季度",
  half_year: "按半年",
  year: "按年",
  none: "不续费",
  free: "免费",
};
