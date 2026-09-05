//! 主控 <-> Agent 之间的 WebSocket 消息协议。
//!
//! 传输格式为 JSON，所有消息使用 `type` 字段区分种类。
//! 该协议同时被 server 与 agent crate 依赖，改动需保持两端同步。

use serde::{Deserialize, Serialize};

/// 延迟探测使用的传输协议。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProbeProtocol {
    /// TCP 连接耗时（无需特殊权限，任意用户可用）。
    #[default]
    Tcp,
    /// ICMP echo（需要 root / cap_net_raw）。
    Icmp,
}

impl ProbeProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProbeProtocol::Tcp => "tcp",
            ProbeProtocol::Icmp => "icmp",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "tcp" => Some(ProbeProtocol::Tcp),
            "icmp" => Some(ProbeProtocol::Icmp),
            _ => None,
        }
    }
}

/// 一个延迟探测任务的配置（由主控下发给 Agent）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProbeConfig {
    pub id: i64,
    pub name: String,
    /// 目标地址：域名或 IP。
    pub target: String,
    pub protocol: ProbeProtocol,
    /// TCP 模式下的目标端口。
    pub port: Option<u16>,
    /// 单次探测超时（毫秒）。
    pub timeout_ms: u64,
    /// 探测间隔（秒）。
    pub interval_s: u64,
}

/// 某个服务器（Agent）需要的完整运行配置。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerConfig {
    pub server_id: i64,
    pub name: String,
    /// 指标上报间隔（秒）。
    pub interval_s: u64,
    pub probes: Vec<ProbeConfig>,
}

/// Agent 侧的静态系统信息（连接时注册用）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SystemInfo {
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub kernel: String,
    pub cpu_model: String,
    pub cpu_cores: usize,
    pub total_memory: u64,
    pub agent_version: String,
}

/// 磁盘分区使用情况。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskSample {
    pub mount: String,
    pub total: u64,
    pub used: u64,
}

/// Agent 周期性上报的整机指标。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MetricsSample {
    /// unix 毫秒
    pub ts: i64,
    pub cpu_usage: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disks: Vec<DiskSample>,
    /// 网卡总上行/下行速率，单位 bytes/s。
    pub net_in_rate: u64,
    pub net_out_rate: u64,
    /// 计入统计的网卡累计收发字节数。
    ///
    /// sysinfo 只承诺这是「累计值」，没说清起点是开机还是 `Networks` 实例创建，
    /// 所以主控只取相邻两次上报的差值，不依赖绝对语义。
    /// 老 Agent 不发这两个字段，`serde(default)` 保证新主控仍能解析。
    #[serde(default)]
    pub net_rx_total: u64,
    #[serde(default)]
    pub net_tx_total: u64,
    pub load_one: f64,
    pub load_five: f64,
    pub load_fifteen: f64,
    /// 系统运行时长（秒）。
    pub uptime_s: u64,
}

/// 一次延迟探测的结果。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProbeResult {
    pub ts: i64,
    pub probe_id: i64,
    pub ok: bool,
    /// 成功时往返耗时（毫秒）。
    pub latency_ms: Option<f64>,
    /// 失败原因，如超时 / 无权限 / 目标不可达。
    pub error: Option<String>,
}

/// Agent -> 主控。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToServer {
    /// 连接后的第一条消息，用于认证与注册。
    Hello { secret: String, info: SystemInfo },
    /// 周期整机指标。
    Metrics(MetricsSample),
    /// 单次延迟探测结果。
    ProbeResult(ProbeResult),
    /// 心跳回复。
    Pong { ts: i64 },
}

/// 主控 -> Agent。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToAgent {
    /// 认证通过，附服务器 ID 与指标上报间隔。
    Welcome { server_id: i64, interval_s: u64 },
    /// 完整配置下发（新增目标 / 修改探测时重推）。
    Config(ServerConfig),
    /// 心跳。
    Ping { ts: i64 },
    /// 认证失败（secret 不存在或已被禁用）。
    AuthFailed { reason: String },
}
