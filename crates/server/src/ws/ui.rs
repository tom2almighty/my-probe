//! 浏览器 WebSocket 桥：把实时事件（指标 / 探测 / 在线状态）推给登录用户。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::auth;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct UiWsQuery {
    pub token: Option<String>,
}

/// 浏览器实时数据 WebSocket。使用查询参数携带 JWT（浏览器无法自定义 WS 头）。
pub async fn ws_ui(State(st): State<AppState>, Query(q): Query<UiWsQuery>, ws: WebSocketUpgrade) -> Response {
    let ok = q
        .token
        .as_deref()
        .map(|t| auth::valid_token(t, &st.jwt_secret))
        .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "无效凭证").into_response();
    }
    ws.on_upgrade(|socket| ui_conn(st, socket))
}

/// 公开视图的实时数据 WebSocket，无需登录。
///
/// 推送的事件只有在线状态、整机指标与探测结果，与公开 REST 接口同一层信息，
/// 不含密钥或资产信息；被禁用的机器不会有 Agent 连接，因此也不会产生事件。
pub async fn ws_public(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|socket| ui_conn(st, socket))
}

async fn ui_conn(st: AppState, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut rx = st.ui_tx.subscribe();

    loop {
        tokio::select! {
            // 服务端来消息（浏览器侧通常只用来关闭连接）
            _ = ws_rx.next() => break,
            event = rx.recv() => {
                match event {
                    Ok(ev) => {
                        let text = match serde_json::to_string(&ev) {
                            Ok(t) => t,
                            Err(_) => continue,
                        };
                        if ws_tx.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    // 消费者落后时跳过积压，保持实时性
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}
