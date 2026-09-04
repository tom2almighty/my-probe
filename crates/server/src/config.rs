//! 主控运行配置。全部来自环境变量，方便 docker / 单文件部署。

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP 监听地址，默认 0.0.0.0:8000
    pub addr: SocketAddr,
    /// 数据目录（存放 myprobe.db），默认 ./data
    pub data_dir: PathBuf,
    /// 管理员初始密码。未提供时首次启动自动生成并打印到日志。
    pub admin_password: Option<String>,
    /// JWT 签名密钥。未提供时自动生成并持久化。
    pub jwt_secret: Option<String>,
    /// 指标保留天数，超出自动清理，默认 14 天。
    pub retention_days: u32,
    /// Agent 心跳超时阈值（秒），超过判定离线，默认 30。
    pub offline_after_s: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let bind = std::env::var("MYPROBE_ADDR").unwrap_or_else(|_| "0.0.0.0:8000".into());
        let addr = bind
            .parse::<SocketAddr>()
            .map_err(|e| format!("MYPROBE_ADDR 解析失败: {e}"))?;
        let data_dir = PathBuf::from(std::env::var("MYPROBE_DATA_DIR").unwrap_or_else(|_| "data".into()));
        let retention_days = std::env::var("MYPROBE_RETENTION_DAYS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(14);
        let offline_after_s = std::env::var("MYPROBE_OFFLINE_AFTER")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);

        Ok(Config {
            addr,
            data_dir,
            admin_password: std::env::var("MYPROBE_ADMIN_PASSWORD")
                .ok()
                .filter(|s| !s.is_empty()),
            jwt_secret: std::env::var("MYPROBE_JWT_SECRET").ok().filter(|s| !s.is_empty()),
            retention_days,
            offline_after_s,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("myprobe.db")
    }
}
