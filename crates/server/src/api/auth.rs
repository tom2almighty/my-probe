//! 登录、当前用户、改密。

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::api::{ApiErr, ApiResult, err};
use crate::auth::{AuthUser, hash_password, issue_token, verify_password};
use crate::db::Db;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResp {
    pub token: String,
    pub username: String,
}

pub async fn login(State(st): State<AppState>, Json(req): Json<LoginReq>) -> ApiResult<LoginResp> {
    let admin = admin_username(&st.db);
    let hash = admin_password_hash(&st.db);

    // 轻微延迟，减缓爆破
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let ok = req.username == admin && verify_password(&req.password, &hash);
    if !ok {
        return Err(err(StatusCode::UNAUTHORIZED, "用户名或密码错误"));
    }
    match issue_token(&st.jwt_secret, &req.username) {
        Ok(token) => Ok(Json(LoginResp {
            token,
            username: req.username,
        })),
        Err(e) => Err(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("签发 token 失败: {e}"),
        )),
    }
}

#[derive(Serialize)]
pub struct MeResp {
    pub username: String,
}

pub async fn me(State(st): State<AppState>, user: AuthUser) -> ApiResult<MeResp> {
    let username = if st.db.get_setting("admin_username").is_some() {
        admin_username(&st.db)
    } else {
        user.sub.clone()
    };
    Ok(Json(MeResp { username }))
}

#[derive(Deserialize)]
pub struct ChangePasswordReq {
    pub old_password: String,
    pub new_password: String,
}

pub async fn change_password(
    State(st): State<AppState>,
    _user: AuthUser,
    Json(req): Json<ChangePasswordReq>,
) -> ApiResult<serde_json::Value> {
    if req.new_password.len() < 8 {
        return Err(err(StatusCode::BAD_REQUEST, "新密码至少 8 位"));
    }
    let hash = admin_password_hash(&st.db);
    if !verify_password(&req.old_password, &hash) {
        return Err(err(StatusCode::BAD_REQUEST, "旧密码错误"));
    }
    let new_hash = hash_password(&req.new_password)
        .map_err(|e| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, format!("密码加密失败: {e}")))?;
    st.db
        .set_setting("admin_password_hash", &new_hash)
        .map_err(|e| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn admin_username(db: &Db) -> String {
    db.get_setting("admin_username")
        .unwrap_or_else(|| "admin".to_string())
}

fn admin_password_hash(db: &Db) -> String {
    db.get_setting("admin_password_hash")
        .unwrap_or_else(|| "!".to_string())
}
