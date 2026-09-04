//! 延迟探测：TCP 连接耗时 / ICMP echo（需要 root 或 cap_net_raw）。

use std::net::IpAddr;
use std::time::{Duration, Instant};

use myprobe_shared::protocol::{ProbeConfig, ProbeProtocol, ProbeResult};
use surge_ping::{Client as PingClient, Config as PingConfig, PingIdentifier, PingSequence};

const PAYLOAD: &[u8] = b"myprobe-probe";

pub async fn run_probe(cfg: &ProbeConfig) -> ProbeResult {
    let ts = now_ms();
    let outcome = match cfg.protocol {
        ProbeProtocol::Tcp => {
            let Some(port) = cfg.port else {
                return ProbeResult {
                    ts,
                    probe_id: cfg.id,
                    ok: false,
                    latency_ms: None,
                    error: Some("TCP 探测缺少端口".into()),
                };
            };
            probe_tcp(&cfg.target, port, cfg.timeout_ms).await
        }
        ProbeProtocol::Icmp => probe_icmp(&cfg.target, cfg.timeout_ms).await,
    };
    match outcome {
        Ok(ms) => ProbeResult {
            ts,
            probe_id: cfg.id,
            ok: true,
            latency_ms: Some(ms),
            error: None,
        },
        Err(e) => ProbeResult {
            ts,
            probe_id: cfg.id,
            ok: false,
            latency_ms: None,
            error: Some(e),
        },
    }
}

async fn probe_tcp(target: &str, port: u16, timeout_ms: u64) -> Result<f64, String> {
    let addr = format!("{target}:{port}");
    let start = Instant::now();
    let fut = tokio::net::TcpStream::connect(&addr);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(Ok(_stream)) => Ok(start.elapsed().as_secs_f64() * 1000.0),
        Ok(Err(e)) => Err(classify_conn_err(e)),
        Err(_) => Err("连接超时".into()),
    }
}

fn classify_conn_err(e: std::io::Error) -> String {
    let k = e.kind();
    if k == std::io::ErrorKind::ConnectionRefused {
        "连接被拒绝".into()
    } else if k == std::io::ErrorKind::TimedOut {
        "连接超时".into()
    } else if matches!(
        k,
        std::io::ErrorKind::NetworkUnreachable | std::io::ErrorKind::HostUnreachable
    ) {
        "网络不可达".into()
    } else if k == std::io::ErrorKind::PermissionDenied {
        "无权限（防火墙或需 root）".into()
    } else {
        format!("连接失败: {e}")
    }
}

async fn probe_icmp(target: &str, timeout_ms: u64) -> Result<f64, String> {
    let ip = resolve_ip(target).await.ok_or("DNS 解析失败")?;
    let config = PingConfig::builder().build();

    // 创建 raw socket 即需要权限，早失败早提示
    let client = PingClient::new(&config).map_err(icmp_permission_error)?;

    let ident = PingIdentifier(target.bytes().fold(0u16, |acc, b| acc.wrapping_add(b as u16)));
    let mut pinger = client.pinger(ip, ident).await;
    pinger.timeout(Duration::from_millis(timeout_ms.min(5000)));

    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        pinger.ping(PingSequence(0), PAYLOAD),
    )
    .await
    {
        Ok(Ok((_pkt, dur))) => Ok(dur.as_secs_f64() * 1000.0),
        Ok(Err(e)) => Err(format!("ICMP 失败: {e}")),
        Err(_) => Err("Ping 超时".into()),
    }
}

fn icmp_permission_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        "ICMP 需要 root 权限或 cap_net_raw，请在后台把该探测改为 TCP".into()
    } else {
        format!("ICMP 初始化失败: {e}")
    }
}

async fn resolve_ip(target: &str) -> Option<IpAddr> {
    tokio::net::lookup_host((target, 0))
        .await
        .ok()
        .and_then(|mut addrs| addrs.next())
        .map(|s| s.ip())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
