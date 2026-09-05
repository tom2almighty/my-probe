//! 全局共享状态、Agent 连接注册表、实时事件（UI 广播）、告警去重状态。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use crate::db::Db;
use crate::models;
use crate::notify::NotifyService;

/// 广播给浏览器的实时事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    /// 服务器在线状态变化。
    ServerStatus { id: i64, online: bool, ts: i64 },
    /// 最新整机指标。
    Metrics {
        server_id: i64,
        ts: i64,
        cpu: f32,
        mem_used: u64,
        mem_total: u64,
        disk_used: u64,
        disk_total: u64,
        net_in: u64,
        net_out: u64,
        load1: f64,
        uptime: u64,
    },
    /// 最新延迟探测结果。
    Probe {
        probe_id: i64,
        server_id: i64,
        ts: i64,
        ok: bool,
        latency_ms: Option<f64>,
    },
    /// 服务器 / 探测目标增删改，前端需要重新拉取列表。
    ServersChanged,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub jwt_secret: String,
    pub notify: NotifyService,
    pub agents: AgentRegistry,
    pub ui_tx: broadcast::Sender<UiEvent>,
    pub alerts: AlertState,
    /// 最新指标内存缓存。
    pub live: LiveMetrics,
    /// 公开接口的短时缓存。
    pub public_cache: Arc<PublicCache>,
    pub offline_after_s: u64,
    /// 全局 id 计数器（用于临时生成的告警 key 等）。
    #[allow(dead_code)]
    pub next_id: Arc<AtomicU64>,
    #[allow(dead_code)]
    pub started_at: Instant,
}

impl AppState {
    pub fn ui_broadcast(&self) {
        let _ = self.ui_tx.send(UiEvent::ServersChanged);
    }

    pub fn push(&self, event: UiEvent) {
        let _ = self.ui_tx.send(event);
    }
}

/// 每个 Agent 连接占用的槽位。
struct AgentSlot {
    /// 连接唯一标识，用于防误删（断线重连时旧连接要释放）。
    conn_id: u64,
    /// 与该连接的写入通道。发现断开的另一端即关闭当前连接。
    tx: mpsc::Sender<Message>,
    last_activity: Instant,
}

/// Agent 在线连接注册表。主控 -> Agent 的配置下发都从这里拿通道。
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<Mutex<HashMap<i64, AgentSlot>>>,
    conn_seq: Arc<AtomicU64>,
}

impl AgentRegistry {
    /// 注册一个连接，返回 conn_id。若同一 server 已有连接则被替代。
    pub fn register(&self, server_id: i64, tx: mpsc::Sender<Message>) -> u64 {
        let conn_id = self.conn_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut map = self.inner.lock().unwrap();
        map.insert(
            server_id,
            AgentSlot {
                conn_id,
                tx,
                last_activity: Instant::now(),
            },
        );
        conn_id
    }

    /// 注销连接（只有 conn_id 匹配时才移除，防止误删新连接）。
    pub fn unregister(&self, server_id: i64, conn_id: u64) {
        let mut map = self.inner.lock().unwrap();
        if let Some(slot) = map.get(&server_id) {
            if slot.conn_id == conn_id {
                map.remove(&server_id);
            }
        }
    }

    pub fn touch(&self, server_id: i64) {
        if let Some(slot) = self.inner.lock().unwrap().get_mut(&server_id) {
            slot.last_activity = Instant::now();
        }
    }

    /// 服务器当前是否有活跃连接（按阈值判定）。
    pub fn is_online(&self, server_id: i64, max_idle: std::time::Duration) -> bool {
        match self.inner.lock().unwrap().get(&server_id) {
            Some(slot) => slot.last_activity.elapsed() <= max_idle,
            None => false,
        }
    }

    #[allow(dead_code)]
    pub fn online_ids(&self) -> Vec<i64> {
        self.inner.lock().unwrap().keys().copied().collect()
    }

    /// 发送一条消息给该服务器；返回 false 表示连接已失效。
    pub fn send(&self, server_id: i64, msg: Message) -> bool {
        let slot = match self.inner.lock().unwrap().get(&server_id) {
            Some(s) => (s.tx.clone(), s.conn_id),
            None => return false,
        };
        match slot.0.try_send(msg) {
            Ok(()) => true,
            Err(_) => false,
        }
    }

    /// 找出所有超过阈值没有心跳的连接，返回 (server_id, conn_id)。
    pub fn find_stale(&self, max_idle: std::time::Duration) -> Vec<(i64, u64)> {
        let map = self.inner.lock().unwrap();
        map.iter()
            .filter(|(_, s)| s.last_activity.elapsed() > max_idle)
            .map(|(id, s)| (*id, s.conn_id))
            .collect()
    }
}

/// 服务器在线判定（给 REST 层用）。
pub fn is_server_online(state: &AppState, id: i64) -> bool {
    state
        .agents
        .is_online(id, std::time::Duration::from_secs(state.offline_after_s))
}

/// 告警防抖状态：记录每个 key 是否处于"已触发"状态，
/// 状态翻转（触发 / 恢复）才发送通知，避免重复轰炸。
#[derive(Clone, Default)]
pub struct AlertState {
    fired: Arc<Mutex<HashMap<String, bool>>>,
}

impl AlertState {
    /// 阈值式告警：到达阈值后只发一次，回落后解除。
    pub fn threshold(&self, key: &str, above: bool) -> AlertAction {
        let mut map = self.fired.lock().unwrap();
        let fired = *map.get(key).unwrap_or(&false);
        if above && !fired {
            map.insert(key.to_string(), true);
            AlertAction::Fire
        } else if !above && fired {
            map.insert(key.to_string(), false);
            AlertAction::Recover
        } else {
            AlertAction::None
        }
    }

    /// 一次性事件（如宕机、到期）：以 dedup 为键防重，由调用方保证键含日期/周期。
    pub fn once(&self, dedup: &str) -> bool {
        let mut map = self.fired.lock().unwrap();
        if map.contains_key(dedup) {
            return false;
        }
        map.insert(dedup.to_string(), true);
        true
    }
}

pub enum AlertAction {
    None,
    Fire,
    Recover,
}

impl AlertAction {
    #[allow(dead_code)]
    pub fn is_activity(&self) -> bool {
        !matches!(self, AlertAction::None)
    }
}

/// 服务器信息视图（供 REST / 展示，secret 打码）。
#[derive(Serialize)]
pub struct ServerView {
    pub id: i64,
    pub name: String,
    pub country: String,
    pub note: String,
    pub enabled: bool,
    pub expire_date: Option<String>,
    pub renew_price: f64,
    pub renew_cycle: models::RenewCycle,
    pub report_interval_s: u64,
    pub created_at: String,
    pub last_seen: i64,
    pub online: bool,
    pub days_to_expire: Option<i64>,
    pub secret_preview: String,
    /// 最新一次上报的整机指标（无数据时为 null）。
    pub latest: Option<models::MetricPoint>,
}

pub fn server_view(s: &models::Server, online: bool, latest: Option<models::MetricPoint>) -> ServerView {
    ServerView {
        id: s.id,
        name: s.name.clone(),
        country: s.country.clone(),
        note: s.note.clone(),
        enabled: s.enabled,
        expire_date: s.expire_date.clone(),
        renew_price: s.renew_price,
        renew_cycle: s.renew_cycle,
        report_interval_s: s.report_interval_s,
        created_at: s.created_at.to_rfc3339(),
        last_seen: s.last_seen,
        online,
        days_to_expire: s.days_to_expire(),
        secret_preview: mask_secret(&s.secret),
        latest,
    }
}

/// 公开视图：不登录也能看到的字段。资产信息（到期日、续费价格、备注）
/// 与接入密钥一律不出现在这里。
#[derive(Serialize)]
pub struct PublicServerView {
    pub id: i64,
    pub name: String,
    pub country: String,
    pub online: bool,
    pub last_seen: i64,
    pub latest: Option<models::MetricPoint>,
}

pub fn public_server_view(
    s: &models::Server,
    online: bool,
    latest: Option<models::MetricPoint>,
) -> PublicServerView {
    PublicServerView {
        id: s.id,
        name: s.name.clone(),
        country: s.country.clone(),
        online,
        last_seen: s.last_seen,
        latest,
    }
}

/// 最新指标的内存缓存。DB 里的样本是节流写入（15s），
/// 这里保留每台机器最后一次上报，让列表首屏就能显示实时值。
#[derive(Clone, Default)]
pub struct LiveMetrics {
    inner: Arc<Mutex<HashMap<i64, models::MetricPoint>>>,
}

impl LiveMetrics {
    pub fn set(&self, server_id: i64, m: models::MetricPoint) {
        self.inner.lock().unwrap().insert(server_id, m);
    }

    pub fn get(&self, server_id: i64) -> Option<models::MetricPoint> {
        self.inner.lock().unwrap().get(&server_id).cloned()
    }

    pub fn remove(&self, server_id: i64) {
        self.inner.lock().unwrap().remove(&server_id);
    }
}

/// 取一台服务器的最新指标：优先内存缓存，回落到 DB（进程重启后）。
pub fn latest_metric(state: &AppState, server_id: i64) -> Option<models::MetricPoint> {
    state
        .live
        .get(server_id)
        .or_else(|| state.db.latest_metric(server_id))
}

/// 只读结果的短时缓存。公开接口不需要登录，同一时间窗口内的重复请求
/// 压成一次查询，避免被反复刷新拖着扫库。
pub struct TtlCache<T> {
    ttl: Duration,
    inner: Mutex<HashMap<String, (Instant, Arc<T>)>>,
}

impl<T> TtlCache<T> {
    pub fn new(ttl: Duration) -> Self {
        TtlCache {
            ttl,
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 命中未过期的缓存直接返回，否则调用 build 计算并写回。
    /// build 在锁外执行，查询期间不挡住其他 key。
    pub fn get_or_insert(&self, key: String, build: impl FnOnce() -> T) -> Arc<T> {
        {
            let mut map = self.inner.lock().unwrap();
            map.retain(|_, (at, _)| at.elapsed() < self.ttl); // 顺手清掉过期项
            if let Some((_, v)) = map.get(&key) {
                return v.clone();
            }
        }
        let v = Arc::new(build());
        self.inner
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), v.clone()));
        v
    }
}

/// 公开接口的缓存集合。总览的 TTL 更短，因为它同时靠 WS 事件保持实时。
pub struct PublicCache {
    pub overview: TtlCache<crate::api::public::PublicOverview>,
    pub metrics: TtlCache<Vec<models::MetricPoint>>,
    pub probe_history: TtlCache<Vec<models::ProbePoint>>,
}

impl Default for PublicCache {
    fn default() -> Self {
        PublicCache {
            overview: TtlCache::new(Duration::from_secs(3)),
            metrics: TtlCache::new(Duration::from_secs(10)),
            probe_history: TtlCache::new(Duration::from_secs(10)),
        }
    }
}

pub fn mask_secret(s: &str) -> String {
    if s.len() <= 6 {
        "******".to_string()
    } else {
        format!("{}****{}", &s[..4], &s[s.len() - 2..])
    }
}

/// 清理到期类告警的一次性 key，允许相同的"剩余 N 天"告警次日再触发。
pub fn clear_timed_alerts(state: &AppState) {
    // fired 表里以 "expire:" 开头的一次性键每日清理，
    // 每日扫描任务每 24h 触发一次，正好周而复始。
    state
        .alerts
        .fired
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with("expire:"));
}
