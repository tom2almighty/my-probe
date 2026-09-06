//! 延迟探测目标：独立于服务器管理，通过指派关系决定由哪些客户端执行。

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use myprobe_shared::protocol::ProbeProtocol;
use serde::{Deserialize, Serialize};

use crate::api::{ApiErr, ApiResult, internal};
use crate::models::{LatencyBand, LatencyScheme, Probe, ProbePoint};
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
    /// 这条指派生效的配色（指派覆盖 → 方案 → 全局默认），前端逐节点着色用。
    pub bands: Vec<LatencyBand>,
    /// 指派上的覆盖状态：编辑弹窗靠它区分「跟随 / 方案 / 自定义」，没覆盖时为 null。
    pub assign_bands: Option<Vec<LatencyBand>>,
    pub assign_scheme_id: Option<i64>,
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
    /// 该目标自己的配色；null 表示没自定义（编辑表单要靠它区分）。
    pub latency_bands: Option<Vec<LatencyBand>>,
    /// 引用的命名方案 id；null 表示跟随全局默认。
    pub latency_scheme_id: Option<i64>,
    /// 生效的配色（自定义 → 方案 → 全局默认都回退过），展示端直接用这个。
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
    pub latency_scheme_id: Option<i64>,
    /// 生效的配色（自定义 → 方案 → 全局默认都回退过）。
    pub bands: Vec<LatencyBand>,
    /// 最近一条结果。
    pub last: Option<ProbePoint>,
    /// 最近 24h 可用率（0-1），无数据时为 None。
    pub ok_24h: Option<f64>,
    /// 最近 24h 平均延迟（ms）。
    pub avg_latency_ms: Option<f64>,
}

/// 组装某客户端执行某探测的统计。`bands` 是配色解析器，调用方一次取好传进来。
pub fn probe_view(st: &AppState, p: &Probe, server_id: i64, bands: &BandResolver) -> ProbeView {
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
        latency_scheme_id: p.latency_scheme_id,
        bands: bands.resolve(p),
        last,
        ok_24h: has_data.then_some(ok),
        avg_latency_ms: has_data.then_some(avg),
    }
}

/// 配色解析器。方案表与全局默认一次读好，一张列表里的所有探测复用同一份，
/// 也保证「自定义 → 方案 → 全局默认」这条优先级只有这里一个实现。
pub struct BandResolver {
    schemes: Vec<LatencyScheme>,
    defaults: Vec<LatencyBand>,
}

impl BandResolver {
    pub fn load(st: &AppState) -> Self {
        Self {
            schemes: st.db.list_latency_schemes(),
            defaults: st.db.get_latency_bands_default(),
        }
    }

    /// 空数组一律当没配：方案被删（id 已被外键置空）或数据坏掉时继续往下回退，
    /// 前端拿到的 `bands` 永远是可以直接画的。
    ///
    /// 优先级：指派覆盖 → 指派方案 → 目标自定义 → 目标方案 → 全局默认。
    /// 前两级来自 probe_assignments（probes_for_server / probe_items 已填到 Probe 上），
    /// 让「同一目标在美西和欧洲可以各有一套健康标准」成为可能。
    pub fn resolve(&self, p: &Probe) -> Vec<LatencyBand> {
        if let Some(b) = p.assign_bands.as_ref().filter(|b| !b.is_empty()) {
            return b.clone();
        }
        if let Some(b) = p
            .assign_scheme_id
            .and_then(|id| self.schemes.iter().find(|s| s.id == id))
            .map(|s| s.bands.clone())
            .filter(|b| !b.is_empty())
        {
            return b;
        }
        if let Some(b) = p.latency_bands.as_ref().filter(|b| !b.is_empty()) {
            return b.clone();
        }
        p.latency_scheme_id
            .and_then(|id| self.schemes.iter().find(|s| s.id == id))
            .map(|s| s.bands.clone())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| self.defaults.clone())
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

#[derive(Deserialize)]
pub struct SchemeReq {
    pub name: String,
    pub bands: Vec<LatencyBand>,
}

/// 命名配色方案列表。方案名只在后台用，不进 UiEvent / 公开视图。
pub async fn schemes(State(st): State<AppState>, _: crate::auth::AuthUser) -> ApiResult<Vec<LatencyScheme>> {
    Ok(Json(st.db.list_latency_schemes()))
}

pub async fn create_scheme(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Json(req): Json<SchemeReq>,
) -> ApiResult<LatencyScheme> {
    let name = scheme_name(&req.name)?.to_string();
    validate_bands(&req.bands).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    let id = st.db.create_latency_scheme(&name, &req.bands).map_err(dup_name)?;
    st.ui_broadcast();
    Ok(Json(LatencyScheme {
        id,
        name,
        bands: req.bands,
    }))
}

/// 改方案会连带改掉所有引用它的探测目标，所以要广播一次让前端重新拉。
pub async fn update_scheme(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<SchemeReq>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_latency_scheme(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "配色方案不存在"))?;
    let name = scheme_name(&req.name)?;
    validate_bands(&req.bands).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    st.db
        .update_latency_scheme(id, name, &req.bands)
        .map_err(dup_name)?;
    st.ui_broadcast();
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 删除方案。引用它的探测目标由外键置空，回退到全局默认，不必再逐个改。
pub async fn destroy_scheme(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_latency_scheme(id)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "配色方案不存在"))?;
    st.db.delete_latency_scheme(id).map_err(internal)?;
    st.ui_broadcast();
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 方案名去空格后的公共校验。名字要在下拉里显示，太长会撑破选择框。
fn scheme_name(raw: &str) -> Result<&str, ApiErr> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ApiErr::new(StatusCode::BAD_REQUEST, "方案名称不能为空"));
    }
    if name.chars().count() > 24 {
        return Err(ApiErr::new(StatusCode::BAD_REQUEST, "方案名称不超过 24 个字"));
    }
    Ok(name)
}

/// name 上有 UNIQUE 约束，撞名翻成人话，其余错误照旧算内部错误。
fn dup_name(e: rusqlite::Error) -> ApiErr {
    if e.to_string().contains("UNIQUE") {
        ApiErr::new(StatusCode::CONFLICT, "已有同名配色方案")
    } else {
        internal(e)
    }
}

/// probe_items 同时服务后台与公开视图；public 只保留启用的探测与服务器。
pub fn probe_items(st: &AppState, public: bool) -> Vec<ProbeItem> {
    let servers = st.db.list_servers();
    let assignments = st.db.probe_assignments();
    // 指派级配色覆盖一次取齐：逐对查会变成 N×M 条 SQL
    let overrides = st.db.assignment_bands();
    let bands = BandResolver::load(st);
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
                    // 目标是共享的，覆盖跟着指派走：先把覆盖填进探测副本再解析
                    let mut pp = p.clone();
                    if let Some((b, sid)) = overrides.get(&(p.id, s.id)) {
                        pp.assign_bands = b.clone();
                        pp.assign_scheme_id = *sid;
                    }
                    let v = probe_view(st, &pp, s.id, &bands);
                    ProbeTargetStat {
                        server_id: s.id,
                        server_name: s.name.clone(),
                        country: s.country.clone(),
                        online: is_server_online(st, s.id),
                        last: v.last,
                        ok_24h: v.ok_24h,
                        avg_latency_ms: v.avg_latency_ms,
                        bands: v.bands,
                        assign_bands: pp.assign_bands,
                        assign_scheme_id: pp.assign_scheme_id,
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
                // 方案 id 只有后台编辑表单要用，公开面有解析好的 bands 就够
                latency_scheme_id: if public { None } else { p.latency_scheme_id },
                bands: bands.resolve(&p),
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
    /// 延迟配色分段；不传或 null = 往下看方案。
    #[serde(default)]
    pub latency_bands: Option<Vec<LatencyBand>>,
    /// 引用的命名方案；不传或 null = 跟随全局默认。
    #[serde(default)]
    pub latency_scheme_id: Option<i64>,
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

/// 引用的方案必须存在。外键也会拦，但那样只能甩一句 SQL 错误给用户。
fn check_scheme(st: &AppState, id: Option<i64>) -> Result<(), ApiErr> {
    match id {
        Some(id) if st.db.get_latency_scheme(id).is_none() => {
            Err(ApiErr::new(StatusCode::BAD_REQUEST, "配色方案不存在"))
        }
        _ => Ok(()),
    }
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
    check_scheme(&st, req.latency_scheme_id)?;
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
            req.latency_scheme_id,
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
    check_scheme(&st, req.latency_scheme_id)?;
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
            req.latency_scheme_id,
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
pub struct AssignmentBandsReq {
    /// 自定义分段；null = 不用自定义
    #[serde(default)]
    pub bands: Option<Vec<LatencyBand>>,
    /// 引用的命名方案；null = 不引用。两者都为 null 表示清除覆盖、跟随目标配置
    #[serde(default)]
    pub scheme_id: Option<i64>,
}

/// 指派级配色：同一探测目标在某台客户端上的独立阈值。
/// 典型场景是美西与欧洲到同一目标各有各的「健康标准」，配色不再被迫共用。
pub async fn set_assignment_bands(
    State(st): State<AppState>,
    _: crate::auth::AuthUser,
    Path((pid, sid)): Path<(i64, i64)>,
    Json(req): Json<AssignmentBandsReq>,
) -> ApiResult<serde_json::Value> {
    st.db
        .get_probe(pid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "探测目标不存在"))?;
    st.db
        .get_server(sid)
        .ok_or(ApiErr::new(StatusCode::NOT_FOUND, "服务器不存在"))?;
    if let Some(bands) = &req.bands {
        validate_bands(bands).map_err(|m| ApiErr::new(StatusCode::BAD_REQUEST, m))?;
    }
    if let Some(id) = req.scheme_id {
        check_scheme(&st, Some(id))?;
    }
    // 自定义分段与方案互斥、自定义优先，与目标级配置保持同一套语义
    let scheme_id = if req.bands.is_some() { None } else { req.scheme_id };
    let ok = st
        .db
        .set_assignment_bands(pid, sid, req.bands.as_deref(), scheme_id)
        .map_err(internal)?;
    if !ok {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "该探测尚未指派给这台客户端，先指派再配色",
        ));
    }
    // 配色不影响 Agent 行为，广播让浏览器重新拉列表即可
    st.ui_broadcast();
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

#[cfg(test)]
mod tests {
    use super::*;
    use myprobe_shared::protocol::ProbeProtocol;

    fn band(max_ms: Option<u64>, color: &str) -> LatencyBand {
        LatencyBand {
            max_ms,
            color: color.into(),
        }
    }

    fn scheme(id: i64, bands: Vec<LatencyBand>) -> LatencyScheme {
        LatencyScheme {
            id,
            name: format!("方案{id}"),
            bands,
        }
    }

    fn probe(assign_bands: Option<Vec<LatencyBand>>, assign_scheme_id: Option<i64>) -> Probe {
        Probe {
            id: 1,
            name: "p".into(),
            target: "1.1.1.1".into(),
            protocol: ProbeProtocol::Tcp,
            port: Some(443),
            timeout_ms: 5000,
            interval_s: 60,
            enabled: true,
            latency_bands: None,
            latency_scheme_id: None,
            assign_bands,
            assign_scheme_id,
        }
    }

    fn resolver() -> BandResolver {
        BandResolver {
            schemes: vec![
                scheme(1, vec![band(Some(150), "#22c55e"), band(None, "#ef4444")]),
                scheme(2, vec![band(Some(300), "#f59e0b"), band(None, "#ef4444")]),
            ],
            defaults: vec![band(Some(100), "#22c55e"), band(None, "#ef4444")],
        }
    }

    #[test]
    fn 配色按指派_方案_目标_默认逐级回退() {
        let r = resolver();

        // 指派自定义 > 指派方案
        let mut p = probe(
            Some(vec![band(Some(180), "#3b82f6"), band(None, "#ef4444")]),
            Some(1),
        );
        assert_eq!(r.resolve(&p)[0].max_ms, Some(180));
        p.assign_bands = None;
        assert_eq!(r.resolve(&p)[0].max_ms, Some(150));

        // 指派方案 > 目标自定义 > 目标方案 > 全局默认
        p.latency_bands = Some(vec![band(Some(400), "#8b5cf6"), band(None, "#ef4444")]);
        assert_eq!(r.resolve(&p)[0].max_ms, Some(150));
        p.assign_scheme_id = None;
        assert_eq!(r.resolve(&p)[0].max_ms, Some(400));
        p.latency_bands = None;
        p.latency_scheme_id = Some(2);
        assert_eq!(r.resolve(&p)[0].max_ms, Some(300));
        p.latency_scheme_id = None;
        assert_eq!(r.resolve(&p), r.defaults);
    }

    #[test]
    fn 坏掉的覆盖当作没配继续回退() {
        let r = resolver();
        // 空数组一律当没配：方案被删后留下的空壳不该把前端画崩
        let p = probe(Some(vec![]), Some(1));
        assert_eq!(r.resolve(&p)[0].max_ms, Some(150));
    }
}
