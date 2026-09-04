//! 登录认证：argon2 密码哈希 + JWT。单管理员账号。

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::RequestPartsExt;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum_extra::TypedHeader;
use axum_extra::headers::authorization::{Authorization, Bearer};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

/// 生成 argon2id 哈希（自动加盐）。
pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
}

/// 校验明文密码与哈希。
pub fn verify_password(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// 用户名（当前固定 "admin"）。
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
}

pub fn issue_token(secret: &str, subject: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: subject.to_string(),
        exp: now + 60 * 60 * 24 * 30, // 30 天
        iat: now,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

fn validate_token(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map(|d| d.claims)
}

/// 仅校验 token 是否有效（不返回 claims）。
pub fn valid_token(token: &str, secret: &str) -> bool {
    validate_token(token, secret).is_ok()
}

/// 通过 Bearer Token 请求身份。密钥由中间件注入到 Request extension。
#[derive(Clone)]
pub struct AuthUser {
    pub sub: String,
}

/// 中间件运行时需要的密钥容器（注入 extension）。
#[derive(Clone)]
pub struct JwtSecret(pub String);

pub struct AuthError(pub &'static str);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (StatusCode::UNAUTHORIZED, self.0).into_response()
    }
}

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let TypedHeader(Authorization(bearer)) = parts
            .extract::<TypedHeader<Authorization<Bearer>>>()
            .await
            .map_err(|_| AuthError("未登录"))?;

        // 密钥由路由层的 middleware 注入 extensions。
        let secret = parts
            .extensions
            .get::<JwtSecret>()
            .ok_or(AuthError("缺少 JWT 密钥配置"))?;

        let claims = validate_token(bearer.token(), &secret.0).map_err(|_| AuthError("凭证无效或已过期"))?;

        Ok(AuthUser { sub: claims.sub })
    }
}
