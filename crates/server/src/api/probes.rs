//! 延迟探测目标：独立于服务器管理，通过指派关系决定由哪些客户端执行。

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use myprobe_shared::protocol::ProbeProtocol;
use serde::{Deserialize, Serialize};

use crate::api::{ApiErr, ApiResult, internal};
use crate::models::{LatencyBand, Probe, ProbePoint};
use crate::state::{AppState, is_server_online};
use crate::ws;

/// 探测目标在某个客户端上的运行情况。
#[derive(Serialize)]
pub struct ProbeTargetStat {
    pub server_id: i64,
    pub server_name: String,
    /// 两位国家码（可能为空串），前端图例 / 对比表里画国旗。
    pub country: String,
    pub online: bool,
    pub last: Option<ProbePoint>,
    /// 最近 24h 可用率（0-1），无数据为 null。
    pub ok_24h: Option<f64>,
    pub avg_latency_ms: Option<f64>,
}

/// 探测列表条目：探测本身 + 每个执行客户端的最新状态。
#[derive(Serialize)]
pub struct ProbeItem {
    pub id: i64,
    pub name: String,
    pub target: String,
    pub protocol: ProbeProtocol,
    pub port: Option<u16>,
    pub timeout_ms: u64,
    pub interval_s: u64,
    pub enabled: bool,
    /// 该目标自己的配色；null 表示跟随全局默认（编辑表单要靠它区分）。
    pub latency_bands: Option<Vec<LatencyBand>>,
    /// 生效的配色（已回退过全局默认），展示端直接用这个。
    pub bands: Vec<LatencyBand>,
    pub server_ids: Vec<i64>,
    pub targets: Vec<ProbeTargetStat>,
}

/// 单个客户端视角的探测视图（服务器详情页用）。
#[derive(Serialize)]
pub struct ProbeView {
    pub id: i64,
    pub name: String,
    pub target: String,
    pub protocol: ProbeProtocol,
    pub port: Option<u16>,
    pub timeout_ms: u64,
    pub interval_s: u64,
    pub enabled: bool,
    pub latency_bands: Option<Vec<LatencyBand>>,
    /// 生效的配色（已回退过全局默认）。
    pub bands: Vec<LatencyBand>,
    /// 最近一条结果。
    pub last: Option<ProbePoint>,
    /// 最近 24h 可用率（0-1），无数据时为 None。
    pub ok_24h: Option<f64>,
    /// 最近 24h 平均延迟（ms）。
    pub avg_latency_ms: Option<f64>,
}

/// 组装某客户端执行某探测的统计。`defaults` 是全局配色，调用方一次取好传进来。
pub fn probe_view(st: &AppState, p: &Probe, server_id: i64, defaults: &[LatencyBand]) -> ProbeView {
    let last = st.db.probe_latest(p.id, server_id);
    let (ok, avg) = st.db.probe_summary(p.id, server_id, 86_400).unwrap_or((0.0, 0.0));
    let has_data = last.is_some();
    ProbeView {
        id: p.id,
        name: p.name.clone(),
        target: p.target.clone(),
        protocol: p.protocol,
        port: p.port,
        timeout_ms: p.timeout_ms,
        interval_s: p.interval_s,
        enabled: p.enabled,
        latency_bands: p.latency_bands.clone(),
        bands: effective_bands(p, defaults),
        last,
        ok_24h: has_data.then_some(ok),
        avg_latency_ms: has_data.then_some(avg),
    }
}

/// 目标自己的配色，没配就用全局默认。
pub fn effective_bands(p: &Probe, defaults: &[LatencyBand]) -> Vec<LatencyBand> {
    match &p.latency_bands {
        Some(b) if !b.is_empty() => b.clone(),
        _ => defaults.to_vec(),
    }
}

/// 全部探测目标 + 指派情况。
pub async fn list(State(st): State<AppState>, _: crate::auth::AuthUser) -> ApiResult<Vec<ProbeItem>> {
    Ok(Json(probe_items(&st, false)))
}

/// 全局默认延迟配色。未单独配置的目标都用它，改了立即对这些目标生效。
pub async fn bands_default(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
) -> ApiResult<Vec<LatencyBand>> {
    Ok(Json(st.db.get_latency_bands_default()))
}

pub async fn set_bands_default(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Json(bands): Json<Vec<LatencyBand>>,
) -> ApiResult<serde_json::Value> {
    validate_bands(&bands).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    st.db.set_latency_bands_default(&bands).map_err(internal)?;
    st.ui_broadcast();
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// probe_items 同时服务后台与公开视图；public 只保留启用的探测与服务器。
pub fn probe_items(st: &AppState, public: bool) -> Vec<ProbeItem> {
    let servers = st.db.list_servers();
    let assignments = st.db.probe_assignments();
    let defaults = st.db.get_latency_bands_default();
    st.db
        .list_probes()
        .into_iter()
        .filter(|p| !public || p.enabled)
        .map(|p| {
            let server_ids: Vec<i64> = assignments
                .iter()
                .filter(|(pid, _)| *pid == p.id)
                .map(|(_, sid)| *sid)
                .collect();
            let targets: Vec<ProbeTargetStat> = servers
                .iter()
                .filter(|s| server_ids.contains(&s.id))
                .filter(|s| !public || s.enabled)
                .map(|s| {
                    let v = probe_view(st, &p, s.id, &defaults);
                    ProbeTargetStat {
                        server_id: s.id,
                        server_name: s.name.clone(),
                        country: s.country.clone(),
                        online: is_server_online(st, s.id),
                        last: v.last,
                        ok_24h: v.ok_24h,
                        avg_latency_ms: v.avg_latency_ms,
                    }
                })
                .collect();
            ProbeItem {
                id: p.id,
                name: p.name.clone(),
                target: p.target.clone(),
                protocol: p.protocol,
                port: p.port,
                timeout_ms: p.timeout_ms,
                interval_s: p.interval_s,
                enabled: p.enabled,
                latency_bands: p.latency_bands.clone(),
                bands: effective_bands(&p, &defaults),
                server_ids,
                targets,
            }
        })
        .collect()
}

#[derive(Deserialize)]
pub struct ProbeReq {
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub protocol: ProbeProtocol,
    pub port: Option<u16>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_probe_interval")]
    pub interval_s: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 执行该探测的客户端，可为空（先建好、之后再指派）。
    #[serde(default)]
    pub server_ids: Vec<i64>,
    /// 延迟配色分段；不传或 null = 跟随全局默认。
    #[serde(default)]
    pub latency_bands: Option<Vec<LatencyBand>>,
}

fn default_true() -> bool {
    true
}
fn default_timeout() -> u64 {
    5000
}
fn default_probe_interval() -> u64 {
    60
}

fn validate(r: &ProbeReq) -> Result<(), String> {
    if r.name.trim().is_empty() {
        return Err("探测名称不能为空".into());
    }
    if r.target.trim().is_empty() {
        return Err("目标地址不能为空".into());
    }
    if r.protocol == ProbeProtocol::Tcp && r.port.is_none() {
        return Err("TCP 探测需要指定端口".into());
    }
    if r.timeout_ms == 0 || r.timeout_ms > 60_000 {
        return Err("超时时间需在 1-60000 ms".into());
    }
    if r.interval_s == 0 || r.interval_s > 3600 {
        return Err("探测间隔需在 1-3600 秒".into());
    }
    if let Some(bands) = &r.latency_bands {
        validate_bands(bands)?;
    }
    Ok(())
}

/// 6 位 hex 颜色。只收这一种写法，避免 `oklch(...)` 之类被塞进前端 style。
fn valid_color(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|x| x.is_ascii_hexdigit())
}

/// 校验延迟配色分段：2-5 段、阈值严格递增、最后一段无上限。
pub fn validate_bands(bands: &[LatencyBand]) -> Result<(), String> {
    if !(2..=5).contains(&bands.len()) {
        return Err("延迟配色需要 2-5 段".into());
    }
    let mut prev = 0u64;
    for (i, b) in bands.iter().enumerate() {
        if !valid_color(&b.color) {
            return Err(format!("第 {} 段颜色需为 #RRGGBB", i + 1));
        }
        let last = i + 1 == bands.len();
        match (b.max_ms, last) {
            (Some(_), true) => return Err("最后一段不设上限".into()),
            (None, false) => return Err(format!("第 {} 段需要填阈值", i + 1)),
            (Some(v), false) => {
                if !(1..=60_000).contains(&v) {
                    return Err("阈值需在 1-60000 ms".into());
                }
                if v <= prev {
                    return Err("阈值必须从小到大递增".into());
                }
                prev = v;
            }
            (None, true) => {}
        }
    }
    Ok(())
}

/// 过滤掉不存在的服务器 id，避免外键报错。
fn existing_servers(st: &AppState, ids: &[i64]) -> Vec<i64> {
    let mut out: Vec<i64> = st
        .db
        .list_servers()
        .into_iter()
        .filter(|s| ids.contains(&s.id))
        .map(|s| s.id)
        .collect();
    out.sort_unstable();
    out
}

pub async fn create(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Json(req): Json<ProbeReq>,
) -> ApiResult<Probe> {
    validate(&req).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    let pid = st
        .db
        .create_probe(
            req.name.trim(),
            req.target.trim(),
            req.protocol,
            req.port,
            req.timeout_ms,
            req.interval_s,
            req.enabled,
            req.latency_bands.as_deref(),
        )
        .map_err(|e| ApiErr::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let servers = existing_servers(&st, &req.server_ids);
    let touched = st.db.set_probe_servers(pid, &servers).map_err(internal)?;
    st.ui_broadcast();
    ws::push_config_many(&st, &touched);
    Ok(Json(
        st.db
            .get_probe(pid)
            .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "创建失败"))?,
    ))
}

pub async fn update(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(pid): Path<i64>,
    Json(req): Json<ProbeReq>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_probe(pid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "探测目标不存在"))?;
    validate(&req).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    st.db
        .update_probe(
            pid,
            req.name.trim(),
            req.target.trim(),
            req.protocol,
            req.port,
            req.timeout_ms,
            req.interval_s,
            req.enabled,
            req.latency_bands.as_deref(),
        )
        .map_err(internal)?;
    // 指派关系有变化的客户端 + 原本就在执行的客户端都要重新下发
    let servers = existing_servers(&st, &req.server_ids);
    let mut touched = st.db.set_probe_servers(pid, &servers).map_err(internal)?;
    touched.extend(servers);
    touched.sort_unstable();
    touched.dedup();
    st.ui_broadcast();
    ws::push_config_many(&st, &touched);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn destroy(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(pid): Path<i64>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_probe(pid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "探测目标不存在"))?;
    let affected = st.db.servers_for_probe(pid);
    st.db.delete_probe(pid).map_err(internal)?;
    st.ui_broadcast();
    ws::push_config_many(&st, &affected);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct AssignReq {
    #[serde(default)]
    pub server_ids: Vec<i64>,
}

/// 覆盖某探测目标的客户端列表。
pub async fn assign(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(pid): Path<i64>,
    Json(req): Json<AssignReq>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_probe(pid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "探测目标不存在"))?;
    let servers = existing_servers(&st, &req.server_ids);
    let touched = st.db.set_probe_servers(pid, &servers).map_err(internal)?;
    st.ui_broadcast();
    ws::push_config_many(&st, &touched);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default = "default_history_ms")]
    pub since_ms: i64,
    #[serde(default = "default_points")]
    pub points: usize,
    /// 查看哪个客户端的探测结果，缺省取第一个指派的客户端。
    pub server_id: Option<i64>,
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

/// 探测历史。一个探测可能由多个客户端执行，这里按客户端返回单条曲线。
pub fn history_points(st: &AppState, pid: i64, q: &HistoryQuery) -> Result<Vec<ProbePoint>, ApiErr> {
    st.db
        .get_probe(pid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "探测目标不存在"))?;
    let server_id = match q.server_id {
        Some(id) => id,
        None => *st
            .db
            .servers_for_probe(pid)
            .first()
            .ok_or(ApiErr::new(StatusCode::BAD_REQUEST, "该探测尚未指派客户端"))?,
    };
    let (since_ms, points) = q.clamped();
    Ok(st.db.probe_history(pid, server_id, since_ms, points))
}

pub async fn history(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(pid): Path<i64>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Vec<ProbePoint>> {
    Ok(Json(history_points(&st, pid, &q)?))
}
