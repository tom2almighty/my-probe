//! 告警规则配置。

use axum::Json;
use axum::extract::State;

use crate::api::{ApiResult, internal};
use crate::auth::AuthUser;
use crate::models::AlertRules;
use crate::state::AppState;

pub async fn get(State(st): State<AppState>, _: AuthUser) -> ApiResult<AlertRules> {
    Ok(Json(st.db.get_alert_rules()))
}

pub async fn update(
    State(st): State<AppState>,
    _: AuthUser,
    Json(rules): Json<AlertRules>,
) -> ApiResult<serde_json::Value> {
    // 基本范围校验
    let mut r = rules;
    r.cpu_threshold = r.cpu_threshold.clamp(0.0, 100.0);
    r.mem_threshold = r.mem_threshold.clamp(0.0, 100.0);
    r.disk_threshold = r.disk_threshold.clamp(0.0, 100.0);
    st.db.set_alert_rules(&r).map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
