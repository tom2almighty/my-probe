# MyProbe

轻量服务器监控与延迟探测系统。主控是一个自带前端的单文件二进制，被监控机器上运行 Agent，通过一条长连接 WebSocket 主动回连主控上报数据。

- **整机指标**：CPU、内存、磁盘、网卡速率、1 分钟负载、运行时长
- **延迟探测**：按目标配置 TCP 握手或 ICMP ping，可设超时与间隔，历史曲线 + 24 小时可用率；探测目标与机器解耦，一个目标可指派多台机器同时跑
- **公开状态页**：`/` 无需登录即可看到所有节点的在线状态与占用，点进 `/s/:id` 是单机详情 —— 1 小时 / 6 小时 / 1 天 / 7 天的占用率、网络速率、平均负载，以及这台机器到各目标的延迟对比（丢包与抖动直接可见，曲线可切平滑）；按目标横向比较的「线路对比」折叠在同一页下方，后台入口在右上角
- **亮色 / 暗色 / 跟随系统**：公开页、登录页与后台都能切换，选择记在浏览器本地
- **资产信息**：到期日期、续费价格与续费周期（按月 / 季 / 半年 / 年 / 不续费），到期前提醒
- **告警通知**：离线、CPU / 内存 / 磁盘超阈值、探测延迟超阈值、即将到期；渠道当前支持 Telegram，接口对其他渠道通用
- **单文件部署**：前端与 SQLite 都编译进二进制，主控与 Agent 均支持二进制或 Docker 运行

## 架构

```
浏览器 ──HTTP/WS──> 主控 myprobe-server ──WS──< Agent myprobe-agent（被监控机器主动外连）
                        │
                        └── SQLite（data/myprobe.db）
```

Agent 只向外发起连接，被监控机器无需开放任何入站端口。主控与 Agent 之间的消息协议见 `crates/shared/src/protocol.rs`。

## 快速开始

### 方式一：一键脚本（Linux）

主控 / 客户端、二进制 / Docker 四种组合都由同一个脚本管理：

```bash
curl -fsSL https://raw.githubusercontent.com/tom2almighty/my-probe/main/scripts/myprobe.sh -o myprobe.sh
sudo bash myprobe.sh                 # 交互菜单
```

也可以一条命令跑完：

```bash
# 主控：Docker 方式，映射到宿主 8000
sudo bash myprobe.sh install-server --mode docker --port 8000 --password '换成你的密码' --yes

# 被监控机器：二进制方式
sudo bash myprobe.sh install-agent \
  --server ws://<主控 IP>:8000/ws/agent --secret <接入密钥> --yes
```

其余子命令：`status`、`logs <组件>`、`restart <组件>`、`update <组件>`、`uninstall <组件>`，`-h` 看完整用法。

脚本会写好 systemd 单元（或 docker 容器）、`/etc/myprobe/*.env` 和数据目录 `/var/lib/myprobe`，二进制默认取静态链接的 musl 版本并校验 SHA256，服务以非 root 的 `myprobe` 用户运行，ICMP 所需的 `CAP_NET_RAW` 单独授予。HTTPS 反向代理不在脚本职责内，按需自行配置。

### 方式二：预编译二进制

[Releases](https://github.com/tom2almighty/my-probe/releases) 里每个平台一个压缩包，`myprobe-server-*` 是主控，`myprobe-agent-*` 是客户端，`*-musl` 为静态链接版本（不挑 glibc 版本，老系统优先选它），校验和见 `SHA256SUMS`。

```bash
tar -xzf myprobe-server-x86_64-unknown-linux-musl.tar.gz
MYPROBE_ADMIN_PASSWORD='换成你的密码' ./myprobe-server

tar -xzf myprobe-agent-x86_64-unknown-linux-musl.tar.gz
./myprobe-agent --server ws://<主控 IP>:8000/ws/agent --secret <接入密钥>
```

ICMP 探测需要抓包权限，Agent 以普通用户运行时执行一次：

```bash
sudo setcap cap_net_raw+ep ./myprobe-agent
```

只用 TCP 探测则不需要额外权限。

### 方式三：Docker

预构建镜像在 GHCR，支持 linux/amd64 与 linux/arm64：

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

想自己构建就用仓库里的 `Dockerfile`（主控）与 `Dockerfile.agent`（Agent）。

或者用 `docker-compose.yml`（把密钥写进同目录的 `.env`）：

```bash
echo "MYPROBE_ADMIN_PASSWORD=换成你的密码" >> .env
echo "MYPROBE_AGENT_SECRET=<接入密钥>" >> .env
docker compose up -d
```

Agent 容器需要 `--network host` 才能读到宿主机网卡速率，`--pid host` 用于进程视图；磁盘用量来自挂载进来的宿主根目录（容器自身的 overlay 层不计入统计）。`--cap-add NET_RAW` 仅 ICMP 探测需要。

### 首次登录

浏览器打开 `http://<主控 IP>:8000`，默认落在公开状态页，右上角进后台，用户名 `admin`。未设置 `MYPROBE_ADMIN_PASSWORD` 时会自动生成初始密码并打印到日志（`myprobe.sh logs server` / `docker logs myprobe-server`），登录后请在左下角用户菜单里「修改密码」。

之后按需要配置：

1. 「服务器 → 新建」创建一台机器，页面给出该机器的接入密钥（只展示一次），拿去启动 Agent
2. 「延迟探测 → 新建」填目标地址与协议（TCP / ICMP），勾选由哪些机器去探测；同一个目标可以挂多台机器对比
3. 「告警与通知」配置阈值与 Telegram 渠道

公开状态页展示所有「启用」状态的服务器与探测目标，不含接入密钥、到期日期、续费价格和备注；把某台机器停用即从公开页移除。公开接口的时间范围与点数有上限（≤1000 点 / ≤31 天）并带几秒缓存，长范围曲线由主控按时间桶聚合，图上虚线是桶内峰值。

## 配置

### 主控（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MYPROBE_ADDR` | `0.0.0.0:8000` | HTTP 监听地址 |
| `MYPROBE_DATA_DIR` | `data` | 数据目录，SQLite 存放在 `<dir>/myprobe.db` |
| `MYPROBE_ADMIN_PASSWORD` | 自动生成 | 首次启动的管理员密码，仅在未初始化时生效 |
| `MYPROBE_JWT_SECRET` | 自动生成并持久化 | 登录令牌签名密钥，改动会使已签发令牌失效 |
| `MYPROBE_RETENTION_DAYS` | `14` | 指标与探测历史保留天数，超期自动清理 |
| `MYPROBE_OFFLINE_AFTER` | `30` | 超过该秒数没有心跳判定为离线 |

### Agent（环境变量或命令行参数）

| 变量 | 参数 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MYPROBE_AGENT_SERVER` | `--server` | `ws://127.0.0.1:8000/ws/agent` | 主控地址，HTTPS 部署时用 `wss://` |
| `MYPROBE_AGENT_SECRET` | `--secret` | 必填 | 后台创建服务器时发放的接入密钥 |
| `MYPROBE_AGENT_NAME` | `--name` | 空 | 展示名，留空则用后台配置的名称 |

上报间隔、探测目标、探测协议都由主控下发，改动后 Agent 立即生效，无需重启。

### 反向代理

对外提供服务建议自己在前面套一层 HTTPS 反向代理（Nginx / Caddy 都行），只要放行 WebSocket 升级即可（`/ws/agent`、`/ws/ui`、`/ws/public`），Agent 侧对应改成 `wss://你的域名/ws/agent`。

## 告警

后台「告警」页配置阈值与通知渠道。Telegram 渠道需要两个参数：

- `bot_token`：向 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 获取
- `chat_id`：先给你的 bot 发一条消息，再访问 `https://api.telegram.org/bot<token>/getUpdates` 从返回里取 `chat.id`

配置完可以点「测试」发一条测试消息确认打通。

## 本地开发

```bash
# 终端 1：主控（默认 8000）
cargo run -p myprobe-server

# 终端 2：前端 dev server（5173，API 与 WS 已代理到 8000）
cd web && bun run dev
```

只想看前端样式时，用内置 mock 数据免后端：访问 `http://localhost:5173/?mock`（或设 `VITE_MOCK=1`），登录页任意密码即可进入，数据与实时事件都是模拟的。

其他常用命令：

```bash
cd web
bun run check   # tsc 类型检查
bun run lint    # biome 检查
bun run fmt     # biome 格式化
```

## 从源码构建

需要 Rust 与 bun。前端产物由 `rust-embed` 在编译期嵌入主控，所以顺序不能反：

```bash
cd web && bun install && bun run build && cd ..
cargo build --release
# 产物：target/release/myprobe-server、target/release/myprobe-agent
```

CI 与发版都在 GitHub Actions 上：`ci.yml` 每次提交跑前后端检查，`build-server.yml` / `build-agent.yml` 出各平台单文件，`docker-images.yml` 推 GHCR 多架构镜像，`release.yml` 由 `v*` tag 触发，把上面三条流水线的产物汇总成 Release。

## 目录结构

```
crates/shared    主控 <-> Agent 的 WebSocket 协议定义
crates/server    主控：REST API、WS 接入、SQLite、告警、静态资源嵌入
crates/agent     Agent：指标采集、TCP/ICMP 探测、断线重连
web              前端：React + Vite + Tailwind + shadcn/ui
scripts          一键部署脚本
```

`web/dist` 由 `rust-embed` 在编译期嵌入主控二进制，所以改完前端要重新 `bun run build` 再 `cargo build`。



