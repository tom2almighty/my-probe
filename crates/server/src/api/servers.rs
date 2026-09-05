//! 服务器与探测目标管理、指标历史查询、状态总览。

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::api::probes::{ProbeView, probe_view};
use crate::api::{ApiErr, ApiResult, internal};
use crate::models::RenewCycle;
use crate::state::{AppState, ServerView, is_server_online, latest_metric, server_view};
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
    #[serde(default)]
    pub renew_price: f64,
    #[serde(default)]
    pub renew_cycle: RenewCycle,
    #[serde(default = "default_interval")]
    pub report_interval_s: u64,
}

fn default_true() -> bool {
    true
}
fn default_interval() -> u64 {
    5
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
    if let Some(d) = &r.expire_date {
        if chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() {
            return Err("到期日期格式应为 YYYY-MM-DD".into());
        }
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
    let views: Vec<ServerView> = st
        .db
        .list_servers()
        .iter()
        .map(|s| server_view(s, is_server_online(&st, s.id), latest_metric(&st, s.id)))
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
        .create_server(
            req.name.trim(),
            &secret,
            &req.country,
            &req.note,
            req.expire_date.as_deref(),
            req.renew_price,
            req.renew_cycle,
            req.report_interval_s as i64,
        )
        .map_err(|e| ApiErr::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let srv = st
        .db
        .get_server(id)
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "创建失败"))?;
    st.ui_broadcast();
    Ok(Json(CreateResp {
        view: server_view(&srv, false, None),
        secret,
    }))
}

/// 服务器详情 + 该客户端执行的探测目标。
#[derive(Serialize)]
pub struct ServerDetail {
    #[serde(flatten)]
    pub server: ServerView,
    pub probes: Vec<ProbeView>,
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
    let views: Vec<ProbeView> = st
        .db
        .probes_for_server(id)
        .iter()
        .map(|p| probe_view(&st, p, id))
        .collect();
    Ok(Json(ServerDetail {
        server: server_view(&srv, is_server_online(&st, id), latest_metric(&st, id)),
        probes: views,
    }))
}

pub async fn update(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ServerReq>,
) -> ApiResult<serde_json::Value> {
    let _srv = st
        .db
        .get_server(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    validate_server_req(&req).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    st.db
        .update_server(
            id,
            req.name.trim(),
            &req.country,
            &req.note,
            req.enabled,
            req.expire_date.as_deref(),
            req.renew_price,
            req.renew_cycle,
            req.report_interval_s as i64,
        )
        .map_err(|e| ApiErr::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    st.ui_broadcast();
    // 间隔/开关变化需要重新下发配置
    ws::push_config(&st, id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn destroy(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    st.db.delete_server(id).map_err(internal)?;
    st.live.remove(id);
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
    let views: Vec<ProbeView> = st
        .db
        .probes_for_server(id)
        .iter()
        .map(|p| probe_view(&st, p, id))
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
