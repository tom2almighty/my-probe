//! Agent 长连接处理：认证注册、指标接收、配置下发、离线判定。

use std::collections::HashMap;
use std::time::Instant;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use myprobe_shared::protocol::{AgentToServer, ServerConfig, ServerToAgent, SystemInfo};
use tokio::sync::mpsc;

use crate::models::Server;
use crate::state::AppState;
use crate::{alert, state::UiEvent};

pub mod ui;

/// Agent WebSocket 端点。
pub async fn ws_agent(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| agent_conn(st, socket))
}

/// 上报间隔秒数 -> 数据库落盘节流的毫秒数。
const PERSIST_EVERY_MS: u128 = 15_000;
/// 同一个探测目标两次落库的最小间隔。按目标各自计时，
/// 一台机器同时跑多个探测时不会互相挤掉。
const PROBE_PERSIST_EVERY_MS: u128 = 1_000;
/// 每台服务器最多保留的指标条数（15s 一条 ≈ 10 天）。
const MAX_METRIC_ROWS: usize = 60_000;
/// 每台服务器最多保留的探测结果条数（该机器上所有探测共享，
/// 10 个目标各 60s 一次 ≈ 13 天）。
const MAX_PROBE_ROWS: usize = 200_000;
/// 每写入多少条做一次行数上限清理。清理要扫索引，没必要每条都做，
/// 超期数据另有 retention_loop 兜底。
const PRUNE_EVERY: u32 = 200;

/// 单条 Agent 连接的落库节流状态。
struct PersistState {
    /// 上次写入指标的时间，None 表示这条连接还没写过。
    last_metric: Option<Instant>,
    /// 每个探测目标各自的上次落库时间。
    last_probe: HashMap<i64, Instant>,
    metric_writes: u32,
    probe_writes: u32,
}

impl PersistState {
    fn new() -> Self {
        PersistState {
            last_metric: None,
            last_probe: HashMap::new(),
            metric_writes: 0,
            probe_writes: 0,
        }
    }

    fn metric_due(&self) -> bool {
        due(self.last_metric.as_ref(), PERSIST_EVERY_MS)
    }

    fn probe_due(&self, probe_id: i64) -> bool {
        due(self.last_probe.get(&probe_id), PROBE_PERSIST_EVERY_MS)
    }
}

/// 距上次落库是否已超过 gap 毫秒。从未落过就直接放行，连上立刻留一条。
fn due(last: Option<&Instant>, gap: u128) -> bool {
    last.is_none_or(|t| t.elapsed().as_millis() >= gap)
}

async fn agent_conn(st: AppState, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(128);

    // ---------- 1. 等待 Hello 完成认证 ----------
    let first = match ws_rx.next().await {
        Some(Ok(Message::Text(t))) => t,
        Some(Ok(_)) => {
            let _ = ws_tx
                .send(Message::Text(
                    "{\"type\":\"auth_failed\",\"reason\":\"协议错误：首条消息应为 hello\"}".into(),
                ))
                .await;
            return;
        }
        _ => return,
    };

    let parsed: Option<AgentToServer> = serde_json::from_str(&first).ok();
    let (secret, info): (String, SystemInfo) = match parsed {
        Some(AgentToServer::Hello { secret, info }) => (secret, info),
        _ => {
            let _ = ws_tx
                .send(Message::Text(
                    "{\"type\":\"auth_failed\",\"reason\":\"协议错误：缺少 hello\"}".into(),
                ))
                .await;
            return;
        }
    };

    let Some(server) = st.db.get_server_by_secret(&secret) else {
        let _ = ws_tx
            .send(Message::Text(
                "{\"type\":\"auth_failed\",\"reason\":\"密钥无效，请检查 MYPROBE_AGENT_SECRET\"}".into(),
            ))
            .await;
        tracing::warn!("Agent 认证失败: 未知 secret");
        return;
    };
    if !server.enabled {
        let _ = ws_tx
            .send(Message::Text(
                "{\"type\":\"auth_failed\",\"reason\":\"服务器已被禁用\"}".into(),
            ))
            .await;
        return;
    }

    let server_id = server.id;
    st.db
        .touch_last_seen(server_id, chrono::Utc::now().timestamp_millis());

    // ---------- 2. 下发 Welcome + 完整配置 ----------
    let interval = server.report_interval_s.max(1);
    let welcome = serde_json::to_string(&ServerToAgent::Welcome {
        server_id,
        interval_s: interval,
    })
    .unwrap();
    if ws_tx.send(Message::Text(welcome.into())).await.is_err() {
        return;
    }
    send_config(&st, &server, &mut ws_tx).await;

    // 通知 UI 该服务器已上线
    st.push(UiEvent::ServerStatus {
        id: server_id,
        online: true,
        ts: chrono::Utc::now().timestamp_millis(),
    });
    tracing::info!("Agent 已连接: {} ({}) {}", server.name, server_id, info.hostname);

    // ---------- 3. 注册连接并进入消息循环 ----------
    let conn_id = st.agents.register(server_id, tx);
    let agents = st.agents.clone();

    let mut persist = PersistState::new();

    loop {
        tokio::select! {
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        handle_text(&st, server_id, &t, &mut persist).await;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        // 回复 pong，保持底层链路存活
                        let _ = ws_tx.send(Message::Pong(p)).await;
                    }
                    Some(Ok(_)) | Some(Err(_)) | None => break,
                }
                st.agents.touch(server_id);
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(msg) => {
                        if ws_tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    agents.unregister(server_id, conn_id);

    // 若没有新连接顶上，则广播离线并触发告警（AlertState 会去重）。
    let online = st
        .agents
        .is_online(server_id, std::time::Duration::from_secs(st.offline_after_s));
    if !online {
        if let Some(srv) = st.db.get_server(server_id) {
            st.push(UiEvent::ServerStatus {
                id: server_id,
                online: false,
                ts: chrono::Utc::now().timestamp_millis(),
            });
            alert::notify_offline(&st, &srv, true).await;
        }
    }
    tracing::info!("Agent 断开: {} ({server_id})", server.name);
}

/// 向某个 Agent 发送完整配置。
pub async fn send_config(
    st: &AppState,
    server: &Server,
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) {
    if let Some(text) = build_config_msg(st, server) {
        let _ = ws_tx.send(Message::Text(text.into())).await;
    }
}

/// 配置变更后向在线 Agent 推送新配置。
pub fn push_config(st: &AppState, server_id: i64) {
    if let Some(server) = st.db.get_server(server_id) {
        if let Some(text) = build_config_msg(st, &server) {
            st.agents.send(server_id, Message::Text(text.into()));
        }
    }
}

/// 探测指派变化会同时影响多个客户端，逐个推送。
pub fn push_config_many(st: &AppState, server_ids: &[i64]) {
    for id in server_ids {
        push_config(st, *id);
    }
}

fn build_config_msg(st: &AppState, server: &Server) -> Option<String> {
    let probes: Vec<_> = st
        .db
        .probes_for_server(server.id)
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| myprobe_shared::protocol::ProbeConfig::from(&p))
        .collect();
    let cfg = ServerConfig {
        server_id: server.id,
        name: server.name.clone(),
        interval_s: server.report_interval_s.max(1),
        probes,
    };
    serde_json::to_string(&ServerToAgent::Config(cfg)).ok()
}

/// 处理 Agent 发来的一条文本消息。
async fn handle_text(st: &AppState, server_id: i64, text: &str, persist: &mut PersistState) {
    let msg = match serde_json::from_str::<AgentToServer>(text) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("Agent 消息解析失败: {e}");
            return;
        }
    };
    let now = Instant::now();

    match msg {
        AgentToServer::Hello { .. } => {
            // 已在连接时处理，忽略
        }
        AgentToServer::Metrics(m) => {
            let disk_used: u64 = m.disks.iter().map(|d| d.used).sum();
            let disk_total: u64 = m.disks.iter().map(|d| d.total).sum();

            // 最新值进内存缓存，供列表首屏直接展示
            st.live.set(
                server_id,
                crate::models::MetricPoint {
                    ts: m.ts,
                    cpu: m.cpu_usage,
                    mem_used: m.mem_used,
                    mem_total: m.mem_total,
                    disk_used,
                    disk_total,
                    net_in: m.net_in_rate,
                    net_out: m.net_out_rate,
                    load1: m.load_one,
                    uptime: m.uptime_s,
                    cpu_max: None,
                    net_in_max: None,
                    net_out_max: None,
                    load1_max: None,
                },
            );

            // 实时推送给浏览器
            st.push(UiEvent::Metrics {
                server_id,
                ts: m.ts,
                cpu: m.cpu_usage,
                mem_used: m.mem_used,
                mem_total: m.mem_total,
                disk_used,
                disk_total,
                net_in: m.net_in_rate,
                net_out: m.net_out_rate,
                load1: m.load_one,
                uptime: m.uptime_s,
            });

            // 节流落盘 + 清理
            if persist.metric_due() {
                if let Err(e) = st.db.insert_metric(server_id, &m) {
                    tracing::warn!("写指标失败: {e}");
                } else {
                    st.db.touch_last_seen(server_id, m.ts);
                    persist.last_metric = Some(now);
                    persist.metric_writes += 1;
                    if persist.metric_writes % PRUNE_EVERY == 0 {
                        st.db.prune_metrics(server_id, MAX_METRIC_ROWS);
                    }
                }
            }

            // 告警求值（不阻塞消息循环）
            if let Some(srv) = st.db.get_server(server_id) {
                let st2 = st.clone();
                tokio::spawn(async move {
                    alert::maybe_alert_metric(&st2, &srv, &m).await;
                });
            }
        }
        AgentToServer::ProbeResult(r) => {
            st.push(UiEvent::Probe {
                probe_id: r.probe_id,
                server_id,
                ts: r.ts,
                ok: r.ok,
                latency_ms: r.latency_ms,
            });

            if persist.probe_due(r.probe_id) {
                if let Err(e) = st.db.insert_probe_result(server_id, &r) {
                    tracing::warn!("写探测结果失败: {e}");
                } else {
                    persist.last_probe.insert(r.probe_id, now);
                    persist.probe_writes += 1;
                    if persist.probe_writes % PRUNE_EVERY == 0 {
                        st.db.prune_probe_results(server_id, MAX_PROBE_ROWS);
                    }
                }
            }

            if let Some(srv) = st.db.get_server(server_id) {
                let st2 = st.clone();
                tokio::spawn(async move {
                    alert::maybe_alert_probe(&st2, &srv, &r).await;
                });
            }
        }
        AgentToServer::Pong { .. } => {
            // 活动已由上层 touch 更新
        }
    }
}
