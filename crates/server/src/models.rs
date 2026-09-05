//! 领域模型（数据库表映射 + REST DTO）。

use chrono::{DateTime, Datelike, NaiveDate, Utc};
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
    /// Agent 在 Hello 里上报的自身版本，从未连接过则为 None。
    pub agent_version: Option<String>,
    /// 流量限额设置。
    pub traffic: TrafficPlan,
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

/// 流量计费口径。各服务商算法不同，四种覆盖常见情况。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrafficMode {
    /// 仅上传。
    Up,
    /// 仅下载。
    Down,
    /// 上传 + 下载。
    #[default]
    Sum,
    /// 上下行取较大值。
    Max,
}

impl TrafficMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrafficMode::Up => "up",
            TrafficMode::Down => "down",
            TrafficMode::Sum => "sum",
            TrafficMode::Max => "max",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "up" => TrafficMode::Up,
            "down" => TrafficMode::Down,
            "max" => TrafficMode::Max,
            _ => TrafficMode::Sum,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            TrafficMode::Up => "仅上传",
            TrafficMode::Down => "仅下载",
            TrafficMode::Sum => "上传 + 下载",
            TrafficMode::Max => "上下行取大",
        }
    }
    /// 按口径把累计收发字节折算成「已用量」。rx = 下载，tx = 上传。
    pub fn used(&self, rx: u64, tx: u64) -> u64 {
        match self {
            TrafficMode::Up => tx,
            TrafficMode::Down => rx,
            TrafficMode::Sum => rx.saturating_add(tx),
            TrafficMode::Max => rx.max(tx),
        }
    }
}

/// 一台机器的流量限额设置。三个字段总是一起读写，打包传递。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrafficPlan {
    /// 周期限额（字节），0 = 不限制。
    pub limit_bytes: u64,
    pub mode: TrafficMode,
    /// 每月重置日 1-28，0 = 不重置。
    pub reset_day: u32,
}

impl Default for TrafficPlan {
    fn default() -> Self {
        TrafficPlan {
            limit_bytes: 0,
            mode: TrafficMode::Sum,
            reset_day: 1,
        }
    }
}

impl TrafficPlan {
    /// 当前计费周期起点（unix 毫秒）。
    ///
    /// 取当月 `reset_day` 日 00:00 UTC；今天还没到那一天就退回上个月。
    /// 时区固定 UTC，与每日任务（`alert.rs run_daily_tasks`）一致，界面上注明。
    /// `reset_day == 0`（不重置）返回 0，表示「只累计、不分周期」。
    pub fn cycle_start(&self, now: DateTime<Utc>) -> i64 {
        if self.reset_day == 0 {
            return 0;
        }
        let today = now.date_naive();
        let this = day_in_month(today.year(), today.month(), self.reset_day);
        let start = if today >= this {
            this
        } else {
            let (y, m) = prev_month(today.year(), today.month());
            day_in_month(y, m, self.reset_day)
        };
        midnight_ms(start)
    }

    /// 下一次重置的时刻（unix 毫秒）。不重置时为 None。
    pub fn next_reset(&self, now: DateTime<Utc>) -> Option<i64> {
        if self.reset_day == 0 {
            return None;
        }
        let today = now.date_naive();
        let this = day_in_month(today.year(), today.month(), self.reset_day);
        let next = if today < this {
            this
        } else {
            let (y, m) = next_month(today.year(), today.month());
            day_in_month(y, m, self.reset_day)
        };
        Some(midnight_ms(next))
    }
}

fn prev_month(y: i32, m: u32) -> (i32, u32) {
    if m == 1 { (y - 1, 12) } else { (y, m - 1) }
}

fn next_month(y: i32, m: u32) -> (i32, u32) {
    if m == 12 { (y + 1, 1) } else { (y, m + 1) }
}

/// 某月的第 `day` 天；该月没有这一天（如 2 月 30 日）则取当月最后一天。
fn day_in_month(y: i32, m: u32, day: u32) -> NaiveDate {
    let (ny, nm) = next_month(y, m);
    let last = NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28);
    NaiveDate::from_ymd_opt(y, m, day.clamp(1, last)).unwrap_or(NaiveDate::MIN)
}

fn midnight_ms(d: NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0)
        .map(|t| t.and_utc().timestamp_millis())
        .unwrap_or(0)
}

/// 当前计费周期的流量累计。
///
/// `last_rx` / `last_tx` 是上一次上报的累计读数，只用来做差分：Agent 的
/// `total_*` 起点语义不明确（开机还是进程启动），所以主控只信相邻两次的差值。
#[derive(Debug, Clone, Copy, Default)]
pub struct TrafficUsage {
    /// 当前周期起点（unix 毫秒）。
    pub cycle_start: i64,
    pub rx: u64,
    pub tx: u64,
    pub last_rx: u64,
    pub last_tx: u64,
    pub updated_at: i64,
}

/// 一次流量累加的结果。`rolled` 表示这一笔跨过了周期边界（旧周期已归档、计数已归零），
/// 调用方据此清掉流量告警的去重键。
#[derive(Debug, Clone, Copy)]
pub struct TrafficBump {
    pub usage: TrafficUsage,
    pub rolled: bool,
}

/// 延迟配色的一段。`max_ms` 为该段上限（含），最后一段省略它表示无上限。
///
/// 同一套断点对「同机房 5ms」和「跨洋 200ms」都不合适，所以配色跟着探测目标走：
/// `probes.latency_bands` 为空时回退到 settings 里的全局默认。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LatencyBand {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_ms: Option<u64>,
    /// 6 位 hex 颜色，如 `#22c55e`。只收 hex，避免任意字符串进到前端 style。
    pub color: String,
}

/// 全局默认配色：<100ms 绿 / 100-160ms 琥珀 / 更慢红。
pub fn default_latency_bands() -> Vec<LatencyBand> {
    vec![
        LatencyBand {
            max_ms: Some(100),
            color: "#22c55e".into(),
        },
        LatencyBand {
            max_ms: Some(160),
            color: "#f59e0b".into(),
        },
        LatencyBand {
            max_ms: None,
            color: "#ef4444".into(),
        },
    ]
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
    /// 自定义延迟配色；None = 跟随全局默认。
    #[serde(default)]
    pub latency_bands: Option<Vec<LatencyBand>>,
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
    /// 周期流量用到限额的百分之多少时提醒（0-100）。每机限额在 servers 表上。
    pub traffic_threshold_pct: f32,
    /// 聚合所有启用开关。
    pub cpu_enabled: bool,
    pub mem_enabled: bool,
    pub disk_enabled: bool,
    pub latency_enabled: bool,
    pub offline_enabled: bool,
    pub expire_enabled: bool,
    pub traffic_enabled: bool,
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
            traffic_threshold_pct: 80.0,
            cpu_enabled: false,
            mem_enabled: false,
            disk_enabled: false,
            latency_enabled: false,
            offline_enabled: true,
            expire_enabled: true,
            traffic_enabled: false,
        }
    }
}
