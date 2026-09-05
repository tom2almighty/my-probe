//! 登录、当前用户、改密改名。

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

#[derive(Deserialize)]
pub struct ChangeUsernameReq {
    pub password: String,
    pub username: String,
}

/// 改用户名。要验当前密码：拿到一个没退出的会话就能改掉登录身份太危险。
/// 鉴权只看 JWT 里的 sub、不比对用户名，所以改完当前会话不会掉线，下次登录用新名字。
pub async fn change_username(
    State(st): State<AppState>,
    _user: AuthUser,
    Json(req): Json<ChangeUsernameReq>,
) -> ApiResult<MeResp> {
    let name = req.username.trim().to_string();
    let len = name.chars().count();
    if !(3..=32).contains(&len) {
        return Err(err(StatusCode::BAD_REQUEST, "用户名长度需为 3-32 个字符"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(err(StatusCode::BAD_REQUEST, "用户名只能包含字母、数字与 _ . -"));
    }
    let hash = admin_password_hash(&st.db);
    if !verify_password(&req.password, &hash) {
        return Err(err(StatusCode::BAD_REQUEST, "密码错误"));
    }
    st.db
        .set_setting("admin_username", &name)
        .map_err(|e| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tracing::info!(username = %name, "管理员用户名已修改");
    Ok(Json(MeResp { username: name }))
}

fn admin_username(db: &Db) -> String {
    db.get_setting("admin_username")
        .unwrap_or_else(|| "admin".to_string())
}

fn admin_password_hash(db: &Db) -> String {
    db.get_setting("admin_password_hash")
        .unwrap_or_else(|| "!".to_string())
}
