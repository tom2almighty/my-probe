//! 领域模型（数据库表映射 + REST DTO）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 服务器（对应一台被探针 Agent 的机器）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: i64,
    pub name: String,
    /// Agent 连接的密钥（不通过 API 返回明文之外的完整值）。
    pub secret: String,
    /// ISO-3166 alpha-2 国家码，用于展示旗帜。
    pub country: String,
    pub note: String,
    pub enabled: bool,
    /// 到期日期（YYYY-MM-DD），可为空。
    pub expire_date: Option<String>,
    /// 续费价格。
    pub renew_price: f64,
    /// 续费周期。
    pub renew_cycle: RenewCycle,
    /// 指标上报间隔（秒）。
    pub report_interval_s: u64,
    pub created_at: DateTime<Utc>,
    /// 最近一次在线时间（agent 心跳），unix 毫秒，0 表示从未在线。
    pub last_seen: i64,
    pub online: bool,
}

impl Server {
    /// 距离到期的天数。None 表示未配置到期日。
    pub fn days_to_expire(&self) -> Option<i64> {
        let d = DateTime::parse_from_str(
            &format!("{}T00:00:00+00:00", self.expire_date.as_ref()?),
            "%Y-%m-%dT%H:%M:%S%z",
        )
        .ok()?
        .with_timezone(&Utc);
        let today = Utc::now().date_naive();
        let expire = d.date_naive();
        Some(expire.signed_duration_since(today).num_days())
    }
}

/// 续费周期。序列化名称与数据库存储、前端类型保持一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum RenewCycle {
    #[default]
    #[serde(rename = "month")]
    Month,
    #[serde(rename = "quarter")]
    Quarter,
    #[serde(rename = "half_year")]
    HalfYear,
    #[serde(rename = "year")]
    Year,
    #[serde(rename = "none")]
    NoRenew,
}

impl RenewCycle {
    pub fn as_str(&self) -> &'static str {
        match self {
            RenewCycle::Month => "month",
            RenewCycle::Quarter => "quarter",
            RenewCycle::HalfYear => "half_year",
            RenewCycle::Year => "year",
            RenewCycle::NoRenew => "none",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "quarter" => RenewCycle::Quarter,
            "half_year" => RenewCycle::HalfYear,
            "year" => RenewCycle::Year,
            "none" => RenewCycle::NoRenew,
            _ => RenewCycle::Month,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            RenewCycle::Month => "按月",
            RenewCycle::Quarter => "按季度",
            RenewCycle::HalfYear => "按半年",
            RenewCycle::Year => "按年",
            RenewCycle::NoRenew => "不续费",
        }
    }
    /// 周期对应天数。
    #[allow(dead_code)]
    pub fn days(&self) -> i64 {
        match self {
            RenewCycle::Month => 30,
            RenewCycle::Quarter => 90,
            RenewCycle::HalfYear => 180,
            RenewCycle::Year => 365,
            RenewCycle::NoRenew => 0,
        }
    }
}

/// 探测目标。独立实体，通过 probe_assignments 指派给一到多个客户端执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probe {
    pub id: i64,
    pub name: String,
    pub target: String,
    pub protocol: myprobe_shared::protocol::ProbeProtocol,
    pub port: Option<u16>,
    pub timeout_ms: u64,
    pub interval_s: u64,
    pub enabled: bool,
}

/// 主控下发给 agent 的探测配置（去掉主控侧独有字段）。
impl From<&Probe> for myprobe_shared::protocol::ProbeConfig {
    fn from(p: &Probe) -> Self {
        myprobe_shared::protocol::ProbeConfig {
            id: p.id,
            name: p.name.clone(),
            target: p.target.clone(),
            protocol: p.protocol,
            port: p.port,
            timeout_ms: p.timeout_ms,
            interval_s: p.interval_s,
        }
    }
}

/// 一条整机指标样本（用于历史图表）。
///
/// 长时间范围的查询在 SQL 里按时间桶聚合，主字段是桶内均值，`*_max` 是桶内峰值；
/// 未聚合的原始点上峰值字段为 None，序列化时直接省略。
#[derive(Debug, Clone, Serialize)]
pub struct MetricPoint {
    pub ts: i64,
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub net_in: u64,
    pub net_out: u64,
    pub load1: f64,
    pub uptime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_max: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_in_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_out_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load1_max: Option<f64>,
}

/// 一条延迟探测样本（用于历史图表）。聚合点上 `latency_ms` 为桶内均值，
/// 额外带上峰值与丢包比例；原始点只有成功/失败与单次延迟。
#[derive(Debug, Clone, Serialize)]
pub struct ProbePoint {
    pub ts: i64,
    pub ok: bool,
    pub latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_max: Option<f64>,
    /// 桶内丢包比例（0-1）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loss: Option<f64>,
}

/// 告警规则（全局，存 settings JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AlertRules {
    /// CPU 使用率阈值（0-100）。0 表示关闭。
    pub cpu_threshold: f32,
    /// 内存使用率阈值（0-100）。
    pub mem_threshold: f32,
    /// 磁盘使用率阈值（0-100）。
    pub disk_threshold: f32,
    /// 延迟超过该毫秒数告警（ms）。
    pub latency_threshold_ms: u64,
    /// 到期前多少天提醒。
    pub expire_days: u64,
    /// 聚合所有启用开关。
    pub cpu_enabled: bool,
    pub mem_enabled: bool,
    pub disk_enabled: bool,
    pub latency_enabled: bool,
    pub offline_enabled: bool,
    pub expire_enabled: bool,
}

/// 通知渠道配置。type 目前为 telegram，接口与其他渠道通用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifierConfig {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub enabled: bool,
    /// 各渠道自定义参数。
    pub config: serde_json::Value,
}

impl Default for AlertRules {
    fn default() -> Self {
        AlertRules {
            cpu_threshold: 90.0,
            mem_threshold: 90.0,
            disk_threshold: 90.0,
            latency_threshold_ms: 500,
            expire_days: 7,
            cpu_enabled: false,
            mem_enabled: false,
            disk_enabled: false,
            latency_enabled: false,
            offline_enabled: true,
            expire_enabled: true,
        }
    }
}
