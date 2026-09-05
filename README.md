# MyProbe

服务器监控与延迟探测系统。主控是一个自带前端的单文件程序，被监控的机器上运行 Agent，由 Agent 主动连回主控上报，被监控机器无需开放入站端口。

## 功能

- 整机指标：CPU、内存、磁盘、网卡速率、平均负载、运行时长
- 流量统计：按周期累计上下行用量，可设限额、重置日与计费方式（仅上传 / 仅下载 / 上传 + 下载 / 上下行取大），支持手动校正
- 延迟探测：对目标地址做 TCP 或 ICMP 探测，可设间隔与超时，看历史曲线、丢包与可用率；一个目标可指派给多台机器，横向对比各节点；延迟高低的配色阈值可用全局默认、按目标单独设，也可存成命名方案（「优化线路」「跨洋直连」之类）给同类线路共用，改方案即改所有引用它的目标
- 资产信息：到期日期（可标永不到期）、续费价格与币种、续费周期（含免费），到期前提醒；服务器列表可拖动排序，公开页与后台一致
- 告警：离线、CPU / 内存 / 磁盘 / 流量超阈值、探测延迟超阈值、即将到期，通过 Telegram 发送
- 公开状态页：`/` 无需登录查看所有节点，不含接入密钥、到期日期、续费价格与备注
- 界面支持亮色 / 暗色 / 跟随系统
- 单文件部署：前端与 SQLite 都在二进制内，主控与 Agent 也都提供 Docker 镜像

## 部署

### 一键脚本（Linux x86_64 / arm64）

主控 / 客户端、二进制 / Docker 四种组合都由同一个脚本管理。先装主控：

```bash
curl -fsSL https://raw.githubusercontent.com/tom2almighty/my-probe/main/scripts/myprobe.sh -o myprobe.sh
sudo bash myprobe.sh                 # 交互菜单

# 或者一条命令跑完（Docker 方式，映射到宿主 8000）
sudo bash myprobe.sh install-server --mode docker --port 8000 --password '换成你的密码' --yes
```

主控自己会在 `/install.sh` 提供同一份脚本，被监控机器不用再去 GitHub，装出来的版本也天然和面板对齐。在后台添加服务器拿到密钥后，弹窗里的「一键脚本」直接复制：

```bash
curl -fsSL http://<主控 IP>:8000/install.sh | sudo bash -s -- install-agent \
  --server ws://<主控 IP>:8000/ws/agent --secret <接入密钥> --yes
```

不想让密钥进 shell 历史就走环境变量，`MYPROBE_AGENT_SECRET`、`MYPROBE_AGENT_SERVER`、`MYPROBE_ADMIN_PASSWORD` 都与同名参数等价：

```bash
curl -fsSL http://<主控 IP>:8000/install.sh | sudo MYPROBE_AGENT_SECRET=<接入密钥> bash -s -- \
  install-agent --server ws://<主控 IP>:8000/ws/agent --yes
```

脚本会装好 systemd 服务（或 Docker 容器）、写好 `/etc/myprobe/*.env` 与数据目录 `/var/lib/myprobe`，下载的二进制校验 SHA256，服务以非 root 用户运行。安装时脚本会把自己放到 `/usr/local/bin/myprobe`，之后直接敲 `myprobe`：`status`、`logs <组件>`、`restart <组件>`、`update <组件>`、`auto-update <on|off> <组件>`、`uninstall <组件>`，`-h` 看完整用法。

自动更新是一个每天跑一次的 systemd timer：客户端默认开启（`--no-auto-update` 关掉），主控默认关闭（`--auto-update` 打开，升级可能带数据库迁移）。版本没变就不动，更新后服务起不来会自动回滚到上一个版本。

### 预编译二进制

[Releases](https://github.com/tom2almighty/my-probe/releases) 按平台各一个压缩包：`linux-amd64`、`linux-arm64`、`macos-amd64`、`macos-arm64`、`windows-amd64`，`myprobe-server-*` 是主控，`myprobe-agent-*` 是客户端。Linux 版为静态链接，不依赖系统 glibc；校验和见 `SHA256SUMS`。

```bash
tar -xzf myprobe-server-linux-amd64.tar.gz
MYPROBE_ADMIN_PASSWORD='换成你的密码' ./myprobe-server

tar -xzf myprobe-agent-linux-amd64.tar.gz
./myprobe-agent --server ws://<主控 IP>:8000/ws/agent --secret <接入密钥>
```

ICMP 探测需要抓包权限，Agent 以普通用户运行时执行一次（只用 TCP 探测则不需要）：

```bash
sudo setcap cap_net_raw+ep ./myprobe-agent
```

### Docker

镜像在 GHCR，支持 linux/amd64 与 linux/arm64：

```bash
# 主控。镜像内以 uid 10001 运行，挂进去的数据目录要归它
mkdir -p /var/lib/myprobe && chown 10001:10001 /var/lib/myprobe
docker run -d --name myprobe-server --restart unless-stopped -p 8000:8000 \
  -v /var/lib/myprobe:/data -e MYPROBE_ADMIN_PASSWORD='换成你的密码' \
  ghcr.io/tom2almighty/myprobe-server:latest

# Agent（监控宿主机）
docker run -d --name myprobe-agent --restart unless-stopped \
  --network host --pid host --cap-add NET_RAW -v /:/host:ro \
  -e MYPROBE_AGENT_SERVER=ws://127.0.0.1:8000/ws/agent \
  -e MYPROBE_AGENT_SECRET=<接入密钥> \
  ghcr.io/tom2almighty/myprobe-agent:latest
```

Agent 容器要 `--network host` 才能读到宿主机网卡速率，磁盘用量来自只读挂载进来的宿主根目录，`--cap-add NET_RAW` 仅 ICMP 探测需要。也可以用仓库里的 `docker-compose.yml`，把密码和密钥写进同目录的 `.env` 后 `docker compose up -d`。自己构建镜像用 `Dockerfile`（主控）与 `Dockerfile.agent`（Agent）。

## 使用

浏览器打开 `http://<主控 IP>:8000`，默认落在公开状态页，右上角进后台，默认用户名 `admin`。未设置 `MYPROBE_ADMIN_PASSWORD` 时会自动生成初始密码并打印到日志（`myprobe logs server` / `docker logs myprobe-server`），登录后在左下角用户菜单里改掉，用户名也在那里改。

1. 「服务器 → 新建」创建一台机器，弹窗给出该机器的接入密钥（只显示一次）和现成的安装命令，到那台机器上执行即可
2. 「延迟探测 → 新建」填目标地址与协议（TCP / ICMP），勾选由哪些机器去探测
3. 「告警与通知」配置阈值与 Telegram 渠道

公开状态页只展示启用状态的服务器与探测目标，把某台机器停用即从公开页移除。

## 配置

### 主控（环境变量）

| 变量                     | 默认值           | 说明                                       |
| ------------------------ | ---------------- | ------------------------------------------ |
| `MYPROBE_ADDR`           | `0.0.0.0:8000`   | HTTP 监听地址                              |
| `MYPROBE_DATA_DIR`       | `data`           | 数据目录，SQLite 存放在 `<dir>/myprobe.db` |
| `MYPROBE_ADMIN_PASSWORD` | 自动生成         | 初始管理员密码，仅在未初始化时生效         |
| `MYPROBE_JWT_SECRET`     | 自动生成并持久化 | 登录令牌签名密钥，改动会使已签发令牌失效   |
| `MYPROBE_RETENTION_DAYS` | `14`             | 历史数据保留天数，超期自动清理             |
| `MYPROBE_OFFLINE_AFTER`  | `30`             | 超过该秒数没有心跳判定为离线               |

### Agent（环境变量或命令行参数）

| 变量                       | 参数       | 默认值                         | 说明                              |
| -------------------------- | ---------- | ------------------------------ | --------------------------------- |
| `MYPROBE_AGENT_SERVER`     | `--server` | `ws://127.0.0.1:8000/ws/agent` | 主控地址，HTTPS 部署时用 `wss://` |
| `MYPROBE_AGENT_SECRET`     | `--secret` | 必填                           | 后台创建服务器时发放的接入密钥    |
| `MYPROBE_AGENT_NAME`       | `--name`   | 空                             | 展示名，留空则用后台配置的名称    |
| `MYPROBE_AGENT_NET_IFACES` | —          | 空                             | 只统计这些网卡（逗号分隔）        |

网卡默认自动排除回环与容器 / 网桥 / 隧道口（`lo`、`docker*`、`veth*`、`br-*` 等），这些口上的流量是真实网卡流量的副本，相加会让宿主机速率翻倍。多网卡机器想只统计计费的那张口就显式列出，例如 `MYPROBE_AGENT_NET_IFACES=eth0`。

上报间隔、探测目标与协议都由主控下发，改动后 Agent 立即生效，无需重启。对外提供服务建议自己在前面套一层 HTTPS 反向代理（Nginx / Caddy 都行），放行 `/ws/agent`、`/ws/ui`、`/ws/public` 的 WebSocket 升级即可，Agent 侧改成 `wss://你的域名/ws/agent`。

### Telegram 通知

后台「告警与通知」页配置，需要两个参数：

- `bot_token`：向 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 获取
- `chat_id`：先给你的 bot 发一条消息，再访问 `https://api.telegram.org/bot<token>/getUpdates`，从返回里取 `chat.id`

填完点「测试」发一条测试消息确认打通。

## 开发

需要 Rust stable 与 [bun](https://bun.sh)。前端产物在编译期嵌入主控二进制，所以改完前端要先 `bun run build` 再 `cargo build`，否则二进制里还是旧页面。

```bash
git clone https://github.com/tom2almighty/my-probe.git
cd my-probe/web && bun install && cd ..

cargo run -p myprobe-server      # 主控，http://127.0.0.1:8000
cd web && bun run dev            # 前端，http://localhost:5173（API 与 WS 已代理到 8000）
```

开发时访问 5173，改前端自动热更新。只调样式不用开后端：访问 `http://localhost:5173/?mock` 走内置模拟数据，登录页随便填密码即可进入（`?mock` 只在开发期有效，生产构建里失效）。想接一个真的 Agent，先在后台建一台机器拿到密钥：

```bash
cargo run -p myprobe-agent -- --server ws://127.0.0.1:8000/ws/agent --secret <密钥>
```

提交前检查（和 CI 一致）：

```bash
cd web && bun run lint && bun run check && cd ..
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

发版推一个 `v*` tag，GitHub Actions 构建各平台二进制与多架构镜像并汇总成 Release。
