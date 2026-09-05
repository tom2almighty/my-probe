//! REST API 路由与通用响应辅助。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};

use crate::state::AppState;

pub mod alerts;
pub mod auth;
pub mod notifiers;
pub mod probes;
pub mod public;
pub mod servers;

/// 统一错误响应：`(status, message)`。
pub struct ApiErr(pub StatusCode, pub String);

impl ApiErr {
    pub fn new(code: StatusCode, msg: impl Into<String>) -> Self {
        Self(code, msg.into())
    }
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

pub type ApiResult<T> = Result<Json<T>, ApiErr>;

pub fn err(code: StatusCode, msg: impl Into<String>) -> ApiErr {
    ApiErr::new(code, msg)
}

pub fn internal(e: impl std::fmt::Display) -> ApiErr {
    ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, format!("内部错误: {e}"))
}

/// 历史查询单次最多返回的点数。
const MAX_HISTORY_POINTS: usize = 1_000;
/// 历史查询最长回溯范围（毫秒）。比默认保留天数留了余量。
const MAX_HISTORY_RANGE_MS: i64 = 31 * 86_400_000;

/// 夹紧历史查询参数。公开接口无需登录，范围与点数必须有上限，
/// 否则一次请求就能让主控去扫整张表。
pub fn clamp_history(since_ms: i64, points: usize) -> (i64, usize) {
    let now = chrono::Utc::now().timestamp_millis();
    let earliest = now - MAX_HISTORY_RANGE_MS;
    (since_ms.clamp(earliest, now), points.clamp(1, MAX_HISTORY_POINTS))
}

/// 需要登录的 REST 路由（由 main 挂 JWT 中间件）。
pub fn protected_router() -> Router<AppState> {
    Router::new()
        .route("/api/me", get(auth::me))
        .route("/api/change-password", post(auth::change_password))
        .route("/api/servers", get(servers::list).post(servers::create))
        .route(
            "/api/servers/{id}",
            get(servers::detail).put(servers::update).delete(servers::destroy),
        )
        .route("/api/servers/{id}/rotate-secret", post(servers::rotate_secret))
        .route(
            "/api/servers/{id}/probes",
            get(servers::probes).put(servers::set_probes),
        )
        .route("/api/servers/{id}/metrics", get(servers::metrics_history))
        .route("/api/probes", get(probes::list).post(probes::create))
        .route("/api/probes/{pid}", put(probes::update).delete(probes::destroy))
        .route("/api/probes/{pid}/servers", put(probes::assign))
        .route("/api/probes/{pid}/history", get(probes::history))
        .route("/api/alerts", get(alerts::get).put(alerts::update))
        .route("/api/notifiers", get(notifiers::get).put(notifiers::update))
        .route("/api/notifiers/test", post(notifiers::test))
        .route("/api/status", get(servers::status))
}

/// 无需登录的 REST 路由。公开视图只读，字段已在 public 模块裁剪。
pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/login", post(auth::login))
        .route("/api/public/overview", get(public::overview))
        .route("/api/public/servers/{id}/metrics", get(public::metrics))
        .route("/api/public/probes/{pid}/history", get(public::probe_history))
}
