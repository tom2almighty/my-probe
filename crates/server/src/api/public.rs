//! 公开只读接口：不需要登录，只暴露展示所需的字段。
//!
//! 这里刻意不返回接入密钥、到期日期、续费价格、备注等后台信息，
//! 也不接受任何写操作。查询参数一律夹紧，结果带短时缓存，
//! 避免匿名请求把主控拖去扫全表。

use std::sync::Arc;

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

pub async fn overview(State(st): State<AppState>) -> ApiResult<Arc<PublicOverview>> {
    // 组装总览要为每个 (探测, 机器) 组合查两次库，热点页面缓存几秒。
    let data = st.public_cache.overview.get_or_insert(String::new(), || {
        let servers: Vec<PublicServerView> = st
            .db
            .list_servers()
            .iter()
            .filter(|s| s.enabled)
            .map(|s| public_server_view(s, is_server_online(&st, s.id), latest_metric(&st, s.id)))
            .collect();
        let online = servers.iter().filter(|s| s.online).count();
        PublicOverview {
            total: servers.len(),
            online,
            servers,
            probes: probe_items(&st, true),
            ts: chrono::Utc::now().timestamp_millis(),
        }
    });
    Ok(Json(data))
}

/// 某台机器的指标曲线。被禁用的机器不对外提供。
pub async fn metrics(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<MetricQuery>,
) -> ApiResult<Arc<Vec<MetricPoint>>> {
    let srv = st
        .db
        .get_server(id)
        .filter(|s| s.enabled)
        .ok_or(ApiErr::new(axum::http::StatusCode::NOT_FOUND, "服务器不存在"))?;
    let (since_ms, points) = q.clamped();
    let key = window_key(&srv.id.to_string(), since_ms, points);
    Ok(Json(st.public_cache.metrics.get_or_insert(key, || {
        st.db.metric_history(srv.id, since_ms, points)
    })))
}

/// 某个探测在某台机器上的延迟曲线。只暴露启用的探测与启用的机器。
pub async fn probe_history(
    State(st): State<AppState>,
    Path(pid): Path<i64>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Arc<Vec<ProbePoint>>> {
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
    let (since_ms, points) = q.clamped();
    let key = window_key(&format!("{pid}:{server_id}"), since_ms, points);
    Ok(Json(st.public_cache.probe_history.get_or_insert(key, || {
        st.db.probe_history(pid, server_id, since_ms, points)
    })))
}

/// 缓存键。since_ms 每次请求都在变，按 10 秒对齐才能真正命中。
fn window_key(prefix: &str, since_ms: i64, points: usize) -> String {
    format!("{prefix}:{}:{points}", since_ms / 10_000)
}
