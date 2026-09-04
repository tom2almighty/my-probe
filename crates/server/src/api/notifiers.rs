//! 通知渠道配置与发送测试。

use axum::Json;
use axum::extract::State;

use crate::api::{ApiResult, internal};
use crate::auth::AuthUser;
use crate::models::NotifierConfig;
use crate::notify::from_config;
use crate::state::AppState;

pub async fn get(State(st): State<AppState>, _: AuthUser) -> ApiResult<Vec<NotifierConfig>> {
    Ok(Json(st.db.get_notifiers()))
}

/// 全量替换通知渠道配置（前端负责维持 id 与顺序）。
pub async fn update(
    State(st): State<AppState>,
    _: AuthUser,
    Json(list): Json<Vec<NotifierConfig>>,
) -> ApiResult<serde_json::Value> {
    // 兜底赋 id（若前端未提供）
    let list: Vec<NotifierConfig> = list
        .into_iter()
        .enumerate()
        .map(|(i, mut c)| {
            if c.id <= 0 {
                c.id = i as i64 + 1;
            }
            c
        })
        .collect();
    st.db.set_notifiers(&list).map_err(internal)?;
    st.notify.reload(&list);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 发送一条测试通知（用请求里的单个渠道配置即时测试）。
pub async fn test(
    State(_): State<AppState>,
    _: AuthUser,
    Json(cfg): Json<NotifierConfig>,
) -> ApiResult<serde_json::Value> {
    let Some(notifier) = from_config(&cfg) else {
        return Ok(Json(
            serde_json::json!({ "ok": false, "error": "渠道配置无效或未启用" }),
        ));
    };
    let msg = format!(
        "<b>MyProbe 测试通知</b>\n渠道：{name}\n如果你看到这条消息，说明配置正确。",
        name = cfg.name
    );
    match notifier.notify("测试通知", &msg).await {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "ok": false, "error": e }))),
    }
}
