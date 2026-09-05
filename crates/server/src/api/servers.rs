//! 服务器与探测目标管理、指标历史查询、状态总览。

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::api::probes::{BandResolver, ProbeView, probe_view};
use crate::api::{ApiErr, ApiResult, internal};
use crate::models::{RenewCycle, ServerAttrs, TrafficMode, TrafficPlan};
use crate::state::{
    AppState, ServerView, clear_traffic_alerts, is_server_online, latest_metric, server_view, traffic_view,
};
use crate::ws;

#[derive(Deserialize)]
pub struct ServerReq {
    pub name: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub expire_date: Option<String>,
    /// 永不到期，为真时忽略 `expire_date`。
    #[serde(default)]
    pub never_expire: bool,
    #[serde(default)]
    pub renew_price: f64,
    #[serde(default)]
    pub renew_cycle: RenewCycle,
    /// 续费价格的币种，ISO 4217 三字母码。
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default = "default_interval")]
    pub report_interval_s: u64,
    /// 周期流量限额（字节），0 / 不传 = 不限制。
    #[serde(default)]
    pub traffic_limit_bytes: u64,
    #[serde(default)]
    pub traffic_mode: TrafficMode,
    /// 每月重置日 1-28，0 = 不重置。
    #[serde(default = "default_reset_day")]
    pub traffic_reset_day: u32,
}

fn default_true() -> bool {
    true
}
fn default_interval() -> u64 {
    5
}
fn default_reset_day() -> u32 {
    1
}
fn default_currency() -> String {
    "CNY".into()
}

impl ServerReq {
    fn plan(&self) -> TrafficPlan {
        TrafficPlan {
            limit_bytes: self.traffic_limit_bytes,
            mode: self.traffic_mode,
            reset_day: self.traffic_reset_day,
        }
    }

    /// 落库前的规范化：永不到期就不留日期、免费就不留价格，库里只有一种表示，
    /// 前端与告警都不用再判断「这个字段此刻算不算数」。
    fn attrs(&self) -> ServerAttrs {
        ServerAttrs {
            name: self.name.trim().to_string(),
            country: self.country.clone(),
            note: self.note.clone(),
            expire_date: if self.never_expire {
                None
            } else {
                self.expire_date.clone()
            },
            never_expire: self.never_expire,
            currency: self.currency.trim().to_uppercase(),
            renew_price: if self.renew_cycle == RenewCycle::Free {
                0.0
            } else {
                self.renew_price
            },
            renew_cycle: self.renew_cycle,
            report_interval_s: self.report_interval_s,
            traffic: self.plan(),
        }
    }
}

fn validate_server_req(r: &ServerReq) -> Result<(), String> {
    if r.name.trim().is_empty() {
        return Err("服务器名称不能为空".into());
    }
    if r.renew_price < 0.0 {
        return Err("续费价格不能为负数".into());
    }
    if r.report_interval_s == 0 || r.report_interval_s > 3600 {
        return Err("上报间隔需在 1-3600 秒之间".into());
    }
    // 永不到期时日期字段作废，不必再挑格式
    if let (false, Some(d)) = (r.never_expire, &r.expire_date) {
        if chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() {
            return Err("到期日期格式应为 YYYY-MM-DD".into());
        }
    }
    // 只认三字母码：币种只用来选符号与格式，不做汇率换算，多余的校验没有意义
    let code = r.currency.trim();
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err("币种应为三位字母代码，如 CNY / USD".into());
    }
    // 29-31 号并非每月都有，统一限制到 28，避免「这个月不重置」的意外
    if r.traffic_reset_day > 28 {
        return Err("流量重置日需在 1-28 之间，或填 0 表示不重置".into());
    }
    if r.traffic_limit_bytes > 0 && r.traffic_limit_bytes < 1024 * 1024 {
        return Err("流量限额太小，请至少设置 1 MB".into());
    }
    Ok(())
}

/// 生成 Agent 连接密钥。
fn gen_secret() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 服务器列表（含在线状态）。
pub async fn list(State(st): State<AppState>, _: crate::auth::AuthUser) -> ApiResult<Vec<ServerView>> {
    // 流量一次查完，避免每台机器再来一条 SQL
    let traffic = st.db.all_traffic();
    let views: Vec<ServerView> = st
        .db
        .list_servers()
        .iter()
        .map(|s| {
            server_view(
                s,
                is_server_online(&st, s.id),
                latest_metric(&st, s.id),
                &traffic.get(&s.id).copied().unwrap_or_default(),
            )
        })
        .collect();
    Ok(Json(views))
}

/// 新建服务器，返回完整视图 + 一次性明文密钥。
#[derive(Serialize)]
pub struct CreateResp {
    #[serde(flatten)]
    pub view: ServerView,
    /// 该密钥仅此一次完整返回，请保存到 Agent 配置。
    pub secret: String,
}

pub async fn create(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Json(req): Json<ServerReq>,
) -> ApiResult<CreateResp> {
    validate_server_req(&req).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    let secret = gen_secret();
    let id = st
        .db
        .create_server(&secret, &req.attrs())
        .map_err(|e| ApiErr::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let srv = st
        .db
        .get_server(id)
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "创建失败"))?;
    st.ui_broadcast();
    Ok(Json(CreateResp {
        view: server_view(&srv, false, None, &Default::default()),
        secret,
    }))
}

/// 服务器详情 + 该客户端执行的探测目标。
#[derive(Serialize)]
pub struct ServerDetail {
    #[serde(flatten)]
    pub server: ServerView,
    pub probes: Vec<ProbeView>,
    /// 已归档的历史计费周期，最近的在前。
    pub traffic_history: Vec<TrafficCycle>,
}

/// 一个已结束的计费周期。
#[derive(Serialize)]
pub struct TrafficCycle {
    pub cycle_start: i64,
    pub rx: u64,
    pub tx: u64,
    /// 按当前计费口径折算的用量。
    pub used: u64,
}

pub async fn detail(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<ServerDetail> {
    let srv = st
        .db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    let bands = BandResolver::load(&st);
    let views: Vec<ProbeView> = st
        .db
        .probes_for_server(id)
        .iter()
        .map(|p| probe_view(&st, p, id, &bands))
        .collect();
    Ok(Json(ServerDetail {
        server: server_view(
            &srv,
            is_server_online(&st, id),
            latest_metric(&st, id),
            &st.db.get_traffic(id),
        ),
        probes: views,
        traffic_history: st
            .db
            .traffic_cycles(id, 12)
            .into_iter()
            .map(|(cycle_start, rx, tx)| TrafficCycle {
                cycle_start,
                rx,
                tx,
                used: srv.traffic.mode.used(rx, tx),
            })
            .collect(),
    }))
}

pub async fn update(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ServerReq>,
) -> ApiResult<serde_json::Value> {
    let srv = st
        .db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    validate_server_req(&req).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    let attrs = req.attrs();
    let plan = attrs.traffic;
    st.db
        .update_server(id, req.enabled, &attrs)
        .map_err(|e| ApiErr::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    // 限额/口径变了，旧的告警去重状态不再有意义
    if srv.traffic != plan {
        clear_traffic_alerts(&st, id);
    }
    st.ui_broadcast();
    // 间隔/开关变化需要重新下发配置
    ws::push_config(&st, id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 列表拖动排序。前端把当前完整顺序整份发上来，比逐条 diff 好对账。
#[derive(Deserialize)]
pub struct ReorderReq {
    pub ids: Vec<i64>,
}

pub async fn reorder(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Json(req): Json<ReorderReq>,
) -> ApiResult<serde_json::Value> {
    st.db.reorder_servers(&req.ids).map_err(internal)?;
    // 顺序变了要让其他标签页跟着刷新；前端收到 servers_changed 会重新拉列表
    st.ui_broadcast();
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 手动校正本周期流量。
///
/// Agent 离线期间的流量必然漏计，换机后累计读数也会错位；没有这个入口，
/// 数字一旦偏了就永远偏着。`used_bytes` 省略表示直接归零。
#[derive(Deserialize)]
pub struct TrafficResetReq {
    #[serde(default)]
    pub used_bytes: Option<u64>,
}

pub async fn traffic_reset(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<TrafficResetReq>,
) -> ApiResult<serde_json::Value> {
    let srv = st
        .db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    if let Some(used) = req.used_bytes {
        if srv.traffic.limit_bytes > 0 && used > srv.traffic.limit_bytes.saturating_mul(100) {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "已用量明显超出限额，请检查数值",
            ));
        }
    }
    let cycle_start = srv.traffic.cycle_start(chrono::Utc::now());
    let usage = st
        .db
        .reset_traffic(
            id,
            cycle_start,
            req.used_bytes,
            srv.traffic.mode,
            chrono::Utc::now().timestamp_millis(),
        )
        .map_err(internal)?;
    clear_traffic_alerts(&st, id);
    st.ui_broadcast();
    Ok(Json(serde_json::json!({
        "ok": true,
        "traffic": traffic_view(&srv.traffic, &usage),
    })))
}

pub async fn destroy(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    st.db.delete_server(id).map_err(internal)?;
    st.live.remove(id);
    // 心跳记录也要清掉，否则 id 被复用时新机器会被判成在线
    st.agents.forget(id);
    st.ui_broadcast();
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize)]
pub struct RotateResp {
    pub secret: String,
}

pub async fn rotate_secret(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<RotateResp> {
    st.db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    let secret = gen_secret();
    st.db.rotate_secret(id, &secret).map_err(internal)?;
    Ok(Json(RotateResp { secret }))
}

// ---------- 客户端 ↔ 探测目标 指派 ----------

/// 该客户端当前执行的探测目标。
pub async fn probes(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<Vec<ProbeView>> {
    st.db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    let bands = BandResolver::load(&st);
    let views: Vec<ProbeView> = st
        .db
        .probes_for_server(id)
        .iter()
        .map(|p| probe_view(&st, p, id, &bands))
        .collect();
    Ok(Json(views))
}

#[derive(Deserialize)]
pub struct AssignProbesReq {
    #[serde(default)]
    pub probe_ids: Vec<i64>,
}

/// 覆盖该客户端执行的探测目标（新增客户端后快速勾选要跑哪些探测）。
pub async fn set_probes(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<AssignProbesReq>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    let mut valid: Vec<i64> = st
        .db
        .list_probes()
        .into_iter()
        .filter(|p| req.probe_ids.contains(&p.id))
        .map(|p| p.id)
        .collect();
    valid.sort_unstable();
    let changed = st.db.set_server_probes(id, &valid).map_err(internal)?;
    if changed {
        st.ui_broadcast();
        ws::push_config(&st, id);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- 历史数据 ----------

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default = "default_history_ms")]
    pub since_ms: i64,
    #[serde(default = "default_points")]
    pub points: usize,
}

impl HistoryQuery {
    /// 夹紧后的 (since_ms, points)。
    pub fn clamped(&self) -> (i64, usize) {
        crate::api::clamp_history(self.since_ms, self.points)
    }
}

fn default_history_ms() -> i64 {
    chrono::Utc::now().timestamp_millis() - 24 * 3600 * 1000
}
fn default_points() -> usize {
    360
}

pub async fn metrics_history(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Vec<crate::models::MetricPoint>> {
    let (since_ms, points) = q.clamped();
    Ok(Json(st.db.metric_history(id, since_ms, points)))
}

// ---------- 状态总览 ----------

#[derive(Serialize)]
pub struct StatusResp {
    pub total: usize,
    pub online: usize,
    pub offline: usize,
    pub probes: usize,
    /// 7 天内到期或已过期的服务器。
    pub expiring: Vec<ExpiringInfo>,
}

#[derive(Serialize)]
pub struct ExpiringInfo {
    pub id: i64,
    pub name: String,
    pub days_to_expire: Option<i64>,
    pub expire_date: Option<String>,
    pub renew_price: f64,
    pub renew_cycle: RenewCycle,
    pub currency: String,
}

pub async fn status(State(st): State<AppState>, _: crate::auth::AuthUser) -> ApiResult<StatusResp> {
    let servers = st.db.list_servers();
    let mut online = 0;
    let mut expiring = Vec::new();
    let probes = st.db.list_probes().iter().filter(|p| p.enabled).count();
    for s in &servers {
        if is_server_online(&st, s.id) {
            online += 1;
        }
        if let Some(days) = s.days_to_expire() {
            if days <= 7 {
                expiring.push(ExpiringInfo {
                    id: s.id,
                    name: s.name.clone(),
                    days_to_expire: Some(days),
                    expire_date: s.expire_date.clone(),
                    renew_price: s.renew_price,
                    renew_cycle: s.renew_cycle,
                    currency: s.currency.clone(),
                });
            }
        }
    }
    Ok(Json(StatusResp {
        total: servers.len(),
        online,
        offline: servers.len() - online,
        probes,
        expiring,
    }))
}
