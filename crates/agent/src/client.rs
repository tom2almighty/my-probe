//! Agent 主循环：连接主控、认证注册、指标上报、延迟探测。

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use myprobe_shared::protocol::{AgentToServer, ServerConfig, ServerToAgent};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::collector::{Collector, system_info};
use crate::config::Config;
use crate::probe;

/// 永不断开的主循环（退出码只会来自进程被 kill）。
pub async fn run(cfg: &Config) -> ! {
    let mut backoff_s: u64 = 2;
    loop {
        let start = std::time::Instant::now();
        match connect_and_sync(cfg).await {
            Ok(()) => {
                tracing::info!("与主控连接已断开，稍后重连");
                backoff_s = 2;
            }
            Err(e) => {
                tracing::warn!("连接/同步失败: {e}");
            }
        }
        let wait = backoff_s.saturating_sub(start.elapsed().as_secs());
        tokio::time::sleep(Duration::from_secs(wait.max(1))).await;
        backoff_s = (backoff_s * 2).min(60);
    }
}

/// 建立一次连接并同步配置；连接断开时返回 Ok，认证/协议错误返回 Err。
async fn connect_and_sync(cfg: &Config) -> Result<(), String> {
    let (ws, resp) = connect_async(&cfg.server_url).await.map_err(|e| e.to_string())?;
    tracing::info!("已连接主控 {}（HTTP {}）", cfg.server_url, resp.status());

    let (mut ws_write, mut ws_read) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(256);

    // 单独的写入任务：指标/探测/心跳共用一条链路，发送串行化并自动清理
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if ws_write.send(m).await.is_err() {
                break;
            }
        }
    });

    let shared: Arc<RwLock<ServerConfig>> = Arc::new(RwLock::new(ServerConfig {
        server_id: 0,
        name: String::new(),
        interval_s: 5,
        probes: Vec::new(),
    }));

    macro_rules! send_json {
        ($x:expr) => {{
            let text = serde_json::to_string($x).map_err(|e| e.to_string())?;
            tx.send(Message::Text(text.into()))
                .await
                .map_err(|e| e.to_string())?;
        }};
    }

    // 1. Hello 注册
    let hello = system_info();
    send_json!(&AgentToServer::Hello {
        secret: cfg.secret.clone(),
        info: hello,
    });

    let mut metric_started = false;
    let mut probe_started = false;

    // 2. 消息循环：读主控指令 / 心跳
    while let Some(msg) = ws_read.next().await {
        let msg = msg.map_err(|e| e.to_string())?;
        match msg {
            Message::Text(text) => match serde_json::from_str::<ServerToAgent>(&text) {
                Ok(ServerToAgent::Welcome {
                    server_id,
                    interval_s,
                }) => {
                    tracing::info!("认证通过，服务器 ID = {server_id}");
                    {
                        let mut w = shared.write().unwrap();
                        w.server_id = server_id;
                        w.interval_s = interval_s.max(1);
                    }
                    if !metric_started {
                        let (tx2, sh2) = (tx.clone(), shared.clone());
                        tokio::spawn(metric_loop(tx2, sh2));
                        metric_started = true;
                    }
                }
                Ok(ServerToAgent::Config(c)) => {
                    tracing::info!("收到配置：{} 个探测目标", c.probes.len());
                    *shared.write().unwrap() = c;
                    if !probe_started {
                        let (tx2, sh2) = (tx.clone(), shared.clone());
                        tokio::spawn(probe_loop(tx2, sh2));
                        probe_started = true;
                    }
                }
                Ok(ServerToAgent::Ping { ts }) => {
                    send_json!(&AgentToServer::Pong { ts });
                }
                Ok(ServerToAgent::AuthFailed { reason }) => {
                    tracing::error!("主控拒绝认证: {reason}");
                    return Err(format!("认证失败: {reason}"));
                }
                Err(e) => tracing::warn!("主控消息解析失败: {e}"),
            },
            Message::Ping(p) => {
                // 协议层心跳：立即回 pong
                let _ = tx.send(Message::Pong(p)).await;
            }
            Message::Close(_) => {
                tracing::info!("主控关闭了连接");
                return Ok(());
            }
            _ => {}
        }
    }

    tracing::warn!("连接意外关闭");
    writer.abort();
    Ok(())
}

/// 按上报间隔持续采集并发送整机指标。
async fn metric_loop(tx: mpsc::Sender<Message>, shared: Arc<RwLock<ServerConfig>>) {
    let mut collector = Collector::default();
    loop {
        let interval_s = shared.read().unwrap().interval_s.max(1);
        let m = collector.sample();
        let text = match serde_json::to_string(&AgentToServer::Metrics(m)) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if tx.send(Message::Text(text.into())).await.is_err() {
            return; // 链路已断，任务结束
        }
        tokio::time::sleep(Duration::from_secs(interval_s)).await;
    }
}

/// 按各探测目标自己的间隔运行延迟探测，配置热更新即时生效。
async fn probe_loop(tx: mpsc::Sender<Message>, shared: Arc<RwLock<ServerConfig>>) {
    let mut last_run: HashMap<i64, std::time::Instant> = HashMap::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tick.tick().await;
        let probes = shared.read().unwrap().probes.clone();
        let mut due = Vec::new();
        for p in probes {
            let should = match last_run.get(&p.id) {
                Some(t) => t.elapsed().as_secs_f64() >= p.interval_s as f64,
                None => true,
            };
            if should {
                last_run.insert(p.id, std::time::Instant::now());
                due.push(p);
            }
        }
        if due.is_empty() {
            continue;
        }

        // 并发探测，避免单个慢目标拖累队列
        let mut set = tokio::task::JoinSet::new();
        for p in due {
            set.spawn(async move { probe::run_probe(&p).await });
        }
        while let Some(res) = set.join_next().await {
            let r = match res {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("探测任务异常结束: {e}");
                    continue;
                }
            };
            let text = match serde_json::to_string(&AgentToServer::ProbeResult(r)) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if tx.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
    }
}
