//! 通知服务。`Notifier` trait 是统一渠道接口，未来新增钉钉/邮件/Webhook
//! 只需实现该 trait 并在 `from_config` 中注册。

use std::sync::{Arc, RwLock};

use futures_util::future::BoxFuture;

use crate::models::NotifierConfig;

/// 统一通知渠道接口（对象安全，方便按配置动态组装）。
pub trait Notifier: Send + Sync {
    #[allow(dead_code)]
    fn kind(&self) -> &'static str;
    fn name(&self) -> &str;
    /// 发送一条通知。title 与 message 已组装为文本。
    fn notify(&self, title: &str, message: &str) -> BoxFuture<'_, Result<(), String>>;
}

/// Telegram Bot 渠道。
pub struct TelegramNotifier {
    bot_token: String,
    chat_id: String,
}

impl TelegramNotifier {
    async fn send_message(&self, text: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.bot_token);
        let resp = client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": self.chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": true,
            }))
            .send()
            .await
            .map_err(|e| format!("请求 Telegram 失败: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(())
        } else {
            let hint = if body.contains("Unauthorized") || body.contains("token") {
                "请检查 Bot Token".to_string()
            } else if body.contains("chat not found") || body.contains("chat_id") {
                "请检查 Chat ID（可能未向机器人发起过会话）".to_string()
            } else {
                String::new()
            };
            Err(format!(
                "Telegram 返回 {status} {hint}({})",
                body.chars().take(200).collect::<String>()
            ))
        }
    }
}

impl Notifier for TelegramNotifier {
    fn kind(&self) -> &'static str {
        "telegram"
    }
    fn name(&self) -> &str {
        "Telegram"
    }

    fn notify(&self, _title: &str, message: &str) -> BoxFuture<'_, Result<(), String>> {
        let msg = message.to_string();
        Box::pin(async move { self.send_message(&msg).await })
    }
}

/// 由渠道配置构建通知器。
pub fn from_config(cfg: &NotifierConfig) -> Option<Arc<dyn Notifier>> {
    if !cfg.enabled {
        return None;
    }
    match cfg.kind.as_str() {
        "telegram" => {
            let bot_token = cfg.config.get("bot_token")?.as_str()?.to_string();
            let chat_id = cfg.config.get("chat_id")?.as_str()?.to_string();
            if bot_token.is_empty() || chat_id.is_empty() {
                return None;
            }
            Some(Arc::new(TelegramNotifier { bot_token, chat_id }))
        }
        _ => None,
    }
}

/// 持有当前启用的通知渠道列表。
#[derive(Clone)]
pub struct NotifyService {
    inner: Arc<RwLock<Vec<Arc<dyn Notifier>>>>,
}

impl Default for NotifyService {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Vec::new())),
        }
    }
}

impl NotifyService {
    /// 根据配置重建渠道列表。
    pub fn reload(&self, configs: &[NotifierConfig]) {
        let mut list = Vec::new();
        for cfg in configs {
            if let Some(n) = from_config(cfg) {
                tracing::info!("通知渠道已启用: {} ({})", cfg.name, cfg.kind);
                list.push(n);
            }
        }
        *self.inner.write().unwrap() = list;
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.read().unwrap().len()
    }

    /// 向所有启用的渠道发送同一通知。
    pub async fn broadcast(&self, title: &str, message: &str) {
        let notifiers = self.inner.read().unwrap().clone();
        for n in notifiers {
            match n.notify(title, message).await {
                Ok(()) => {}
                Err(e) => tracing::warn!("发送通知失败 [{}]/{}: {}", n.name(), title, e),
            }
        }
    }
}
