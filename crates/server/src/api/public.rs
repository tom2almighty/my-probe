//! 公开只读接口：不需要登录，只暴露展示所需的字段。
//!
//! 这里刻意不返回接入密钥、到期日期、续费价格、备注等后台信息，
//! 也不接受任何写操作。

use axum::Json;
use axum::extract::{Path, Query, State};

use crate::api::probes::{HistoryQuery, ProbeItem, probe_items};
use crate::api::servers::HistoryQuery as MetricQuery;
use crate::api::{ApiErr, ApiResult};
use crate::models::{MetricPoint, ProbePoint};
use crate::state::{AppState, PublicServerView, is_server_online, latest_metric, public_server_view};
use serde::Serialize;

/// 公开首页所需的一次性数据。
#[derive(Serialize)]
pub struct PublicOverview {
    pub servers: Vec<PublicServerView>,
    pub probes: Vec<ProbeItem>,
    pub online: usize,
    pub total: usize,
    pub ts: i64,
}

pub async fn overview(State(st): State<AppState>) -> ApiResult<PublicOverview> {
    let servers: Vec<PublicServerView> = st
        .db
        .list_servers()
        .iter()
        .filter(|s| s.enabled)
        .map(|s| public_server_view(s, is_server_online(&st, s.id), latest_metric(&st, s.id)))
        .collect();
    let online = servers.iter().filter(|s| s.online).count();
    Ok(Json(PublicOverview {
        total: servers.len(),
        online,
        servers,
        probes: probe_items(&st, true),
        ts: chrono::Utc::now().timestamp_millis(),
    }))
}

/// 某台机器的指标曲线。被禁用的机器不对外提供。
pub async fn metrics(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<MetricQuery>,
) -> ApiResult<Vec<MetricPoint>> {
    let srv = st
        .db
        .get_server(id)
        .filter(|s| s.enabled)
        .ok_or(ApiErr::new(axum::http::StatusCode::NOT_FOUND, "服务器不存在"))?;
    Ok(Json(st.db.metric_history(srv.id, q.since_ms, q.points)))
}

/// 某个探测在某台机器上的延迟曲线。只暴露启用的探测与启用的机器。
pub async fn probe_history(
    State(st): State<AppState>,
    Path(pid): Path<i64>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Vec<ProbePoint>> {
    st.db
        .get_probe(pid)
        .filter(|p| p.enabled)
        .ok_or(ApiErr::new(axum::http::StatusCode::NOT_FOUND, "探测目标不存在"))?;
    let assigned = st.db.servers_for_probe(pid);
    let visible: Vec<i64> = st
        .db
        .list_servers()
        .into_iter()
        .filter(|s| s.enabled && assigned.contains(&s.id))
        .map(|s| s.id)
        .collect();
    let server_id = match q.server_id {
        Some(id) if visible.contains(&id) => id,
        Some(_) => {
            return Err(ApiErr::new(
                axum::http::StatusCode::NOT_FOUND,
                "该探测未在此机器上运行",
            ));
        }
        None => *visible.first().ok_or(ApiErr::new(
            axum::http::StatusCode::NOT_FOUND,
            "该探测尚未指派客户端",
        ))?,
    };
    Ok(Json(st.db.probe_history(pid, server_id, q.since_ms, q.points)))
}
