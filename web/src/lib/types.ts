//! 与主控后端对应的 TS 类型。

export type RenewCycle = "month" | "quarter" | "half_year" | "year" | "none";

export interface Server {
  id: number;
  name: string;
  country: string;
  note: string;
  enabled: boolean;
  expire_date: string | null;
  renew_price: number;
  renew_cycle: RenewCycle;
  report_interval_s: number;
  created_at: string;
  last_seen: number;
  online: boolean;
  days_to_expire: number | null;
  secret_preview: string;
  /** 最新一次上报的整机指标 */
  latest: MetricPoint | null;
}

export interface CreateServerResp extends Server {
  secret: string;
}

export type Protocol = "tcp" | "icmp";

export interface Probe {
  id: number;
  name: string;
  target: string;
  protocol: Protocol;
  port: number | null;
  timeout_ms: number;
  interval_s: number;
  enabled: boolean;
}

export interface ProbeView extends Probe {
  last: ProbePoint | null;
  ok_24h: number | null;
  avg_latency_ms: number | null;
}

/** 探测目标在某个客户端上的运行情况。 */
export interface ProbeTargetStat {
  server_id: number;
  server_name: string;
  online: boolean;
  last: ProbePoint | null;
  ok_24h: number | null;
  avg_latency_ms: number | null;
}

/** 探测列表条目：探测本身 + 指派的客户端。 */
export interface ProbeItem extends Probe {
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
}

export interface ServerDetail extends Server {
  probes: ProbeView[];
}

/** 公开视图里的服务器（无密钥与资产信息）。 */
export interface PublicServer {
  id: number;
  name: string;
  country: string;
  online: boolean;
  last_seen: number;
  latest: MetricPoint | null;
}

export interface PublicOverview {
  servers: PublicServer[];
  probes: ProbeItem[];
  online: number;
  total: number;
  ts: number;
}

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
}

export interface ProbePoint {
  ts: number;
  ok: boolean;
  latency_ms: number | null;
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
  }[];
}

export interface AlertRules {
  cpu_threshold: number;
  mem_threshold: number;
  disk_threshold: number;
  latency_threshold_ms: number;
  expire_days: number;
  cpu_enabled: boolean;
  mem_enabled: boolean;
  disk_enabled: boolean;
  latency_enabled: boolean;
  offline_enabled: boolean;
  expire_enabled: boolean;
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
    cpu_enabled: false,
    mem_enabled: false,
    disk_enabled: false,
    latency_enabled: false,
    offline_enabled: true,
    expire_enabled: true,
  };
}

export const RENEW_CYCLE_LABELS: Record<RenewCycle, string> = {
  month: "按月",
  quarter: "按季度",
  half_year: "按半年",
  year: "按年",
  none: "不续费",
};
