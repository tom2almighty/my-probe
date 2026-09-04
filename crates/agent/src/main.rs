//! MyProbe Agent 主程序：采集本机指标 + 向主控上报 + 执行延迟探测。

mod client;
mod collector;
mod config;
mod probe;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // rustls 不带编译期默认后端，这里显式装上 ring，否则 wss:// 握手会直接 panic。
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = match config::Config::parse() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("配置错误: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!(
        "MyProbe Agent {} 启动 ({}), 目标主控 {}",
        env!("CARGO_PKG_VERSION"),
        cfg.name.as_deref().unwrap_or("未命名"),
        cfg.server_url
    );
    client::run(&cfg).await;
}
