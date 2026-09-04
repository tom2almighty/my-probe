//! MyProbe 主控服务入口。

mod alert;
mod api;
mod auth;
mod config;
mod db;
mod models;
mod notify;
mod state;
mod static_assets;
mod ws;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Router, middleware};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::auth::JwtSecret;
use crate::state::{AppState, UiEvent, is_server_online};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // rustls 不带编译期默认后端，这里显式装上 ring，通知推送走 https 时才能握手。
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = match config::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("配置错误: {e}");
            std::process::exit(1);
        }
    };

    let db = Arc::new(
        db::Db::open(&cfg.db_path())
            .unwrap_or_else(|e| panic!("无法打开数据库 {}: {e}", cfg.db_path().display())),
    );

    bootstrap_admin(&db, cfg.admin_password.as_deref());

    // JWT 密钥：优先环境变量，否则生成并持久化，重启保持一致。
    let jwt_secret = match cfg.jwt_secret.clone() {
        Some(s) => s,
        None => db.get_or_create_setting("jwt_secret", random_secret),
    };

    let (ui_tx, _) = tokio::sync::broadcast::channel(512);
    let notify = notify::NotifyService::default();
    notify.reload(&db.get_notifiers());

    let st = AppState {
        db: db.clone(),
        jwt_secret,
        notify: notify.clone(),
        agents: state::AgentRegistry::default(),
        ui_tx,
        alerts: state::AlertState::default(),
        live: state::LiveMetrics::default(),
        offline_after_s: cfg.offline_after_s,
        next_id: Arc::new(AtomicU64::new(0)),
        started_at: std::time::Instant::now(),
    };

    // ---- 后台任务 ----
    tokio::spawn(offline_sweeper(st.clone()));
    tokio::spawn(alert::run_daily_tasks(st.clone()));
    tokio::spawn(retention_loop(st.clone(), cfg.retention_days));

    // ---- 路由 ----
    let protected = api::protected_router().layer(middleware::from_fn_with_state(st.clone(), require_auth));
    let public = api::public_router();

    let opt_cors = if cfg_is_local_dev() {
        CorsLayer::permissive()
    } else {
        CorsLayer::new()
    };

    let app = Router::new()
        .merge(protected)
        .merge(public)
        .route("/ws/agent", get(ws::ws_agent))
        .route("/ws/ui", get(ws::ui::ws_ui))
        .route("/ws/public", get(ws::ui::ws_public))
        .layer(opt_cors)
        .layer(TraceLayer::new_for_http())
        .fallback(static_assets::serve_static)
        .with_state(st);

    let listener = tokio::net::TcpListener::bind(cfg.addr)
        .await
        .unwrap_or_else(|e| panic!("绑定监听地址 {} 失败: {e}", cfg.addr));
    tracing::info!(
        "MyProbe 主控已启动: http://{} （数据目录 {}）",
        cfg.addr,
        cfg.data_dir.display()
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("HTTP 服务运行失败");
}

/// 首次启动引导管理员密码。
fn bootstrap_admin(db: &db::Db, env_password: Option<&str>) {
    // 用户名固定 admin（可后续扩展）
    if db.get_setting("admin_username").is_none() {
        let _ = db.set_setting("admin_username", "admin");
    }
    if db.get_setting("admin_password_hash").is_none() {
        let password = match env_password {
            Some(p) => p.to_string(),
            None => {
                let generated = random_password();
                tracing::warn!(
                    "===========================\n\
                     尚未配置管理员密码，已自动生成：\n  {generated}\n\
                     请登录后立即修改。可通过环境变量 MYPROBE_ADMIN_PASSWORD 自定义。\n\
                     ==========================="
                );
                generated
            }
        };
        match auth::hash_password(&password) {
            Ok(hash) => {
                let _ = db.set_setting("admin_password_hash", &hash);
                tracing::info!("管理员账号已初始化（用户名 admin）");
            }
            Err(e) => tracing::error!("初始化管理员密码失败: {e}"),
        }
    }
}

/// 生成随机十六进制密钥。
pub fn random_secret() -> String {
    let mut buf = [0u8; 32];
    use rand::Rng;
    rand::rng().fill_bytes(&mut buf);

    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 生成初始管理员密码：16 位、去掉易混淆字符，便于从日志里手抄。
fn random_password() -> String {
    // 去掉 0/O、1/l/I 等易混淆字符
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..16)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// 登录中间件：把 JWT 密钥塞进 extension 供 AuthUser 提取器读取。
async fn require_auth(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    req.extensions_mut().insert(JwtSecret(st.jwt_secret.clone()));
    next.run(req).await
}

/// 周期检查：更新每台服务器的在线状态，处理在线/离线流转（通知在 alert 层去重）。
async fn offline_sweeper(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tick.tick().await;

    let mut prev: HashMap<i64, bool> = HashMap::new();

    loop {
        tick.tick().await;
        let max_idle = Duration::from_secs(st.offline_after_s);

        // 1) 清理真正失联的连接（Agent 进程崩溃不会触发正常断开）
        for (server_id, conn_id) in st.agents.find_stale(max_idle) {
            st.agents.unregister(server_id, conn_id);
        }

        // 2) 对每台已知服务器做状态流转
        let servers = st.db.list_servers();
        for srv in servers {
            let online = is_server_online(&st, srv.id);
            match prev.get(&srv.id) {
                Some(&old) if old != online => {
                    st.push(UiEvent::ServerStatus {
                        id: srv.id,
                        online,
                        ts: chrono::Utc::now().timestamp_millis(),
                    });
                    // 恢复/离线通知由 alert 层通过阈值去重
                    if online {
                        let (st2, srv2) = (st.clone(), srv.clone());
                        tokio::spawn(async move { alert::notify_offline(&st2, &srv2, false).await });
                    } else {
                        let (st2, srv2) = (st.clone(), srv.clone());
                        tokio::spawn(async move { alert::notify_offline(&st2, &srv2, true).await });
                    }
                    prev.insert(srv.id, online);
                }
                Some(_) => {}
                None => {
                    prev.insert(srv.id, online);
                }
            }
        }
    }
}

/// 定期清理超过保留期的历史样本。
async fn retention_loop(st: AppState, retention_days: u32) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tick.tick().await;
    loop {
        tick.tick().await;
        st.db.purge_old_samples(retention_days as i64);
    }
}

fn cfg_is_local_dev() -> bool {
    std::env::var("MYPROBE_DEV_CORS").is_ok()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("无法监听 Ctrl+C");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("无法注册 SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("正在优雅退出…");
}
