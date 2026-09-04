//! Agent 运行配置：全部来自命令行参数或环境变量。

#[derive(Debug, Clone)]
pub struct Config {
    /// 主控 WebSocket 地址，如 ws://1.2.3.4:8000/ws/agent
    pub server_url: String,
    /// 连接密钥（后台创建服务器时发放）。
    pub secret: String,
    /// 展示名（可选，优先用主控配置的名称）。
    pub name: Option<String>,
}

impl Config {
    /// 从环境变量 + CLI 参数解析。
    pub fn parse() -> Result<Self, String> {
        let mut server_url =
            std::env::var("MYPROBE_AGENT_SERVER").unwrap_or_else(|_| "ws://127.0.0.1:8000/ws/agent".into());
        let mut secret = std::env::var("MYPROBE_AGENT_SECRET").ok();
        let mut name = std::env::var("MYPROBE_AGENT_NAME").ok().filter(|s| !s.is_empty());

        let mut args = std::env::args().skip(1);
        while let Some(a) = args.next() {
            match a.as_str() {
                "--server" => server_url = args.next().ok_or("--server 需要参数")?,
                "--secret" => secret = Some(args.next().ok_or("--secret 需要参数")?),
                "--name" => name = Some(args.next().ok_or("--name 需要参数")?),
                other => return Err(format!("未知参数: {other}")),
            }
        }

        let secret = secret.ok_or("缺少连接密钥，请设置 MYPROBE_AGENT_SECRET 或 --secret")?;
        if !server_url.starts_with("ws://") && !server_url.starts_with("wss://") {
            return Err("MYPROBE_AGENT_SERVER 需以 ws:// 或 wss:// 开头".into());
        }

        Ok(Config {
            server_url,
            secret,
            name,
        })
    }
}
