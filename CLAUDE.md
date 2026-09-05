# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MyProbe 是服务器监控与延迟探测系统：主控（`myprobe-server`）是自带前端的单文件程序，被监控机器上跑 Agent（`myprobe-agent`），由 Agent 主动连回主控，被监控端无需开放入站端口。

注释、日志、接口错误文案、界面文字与提交信息一律用中文，提交格式为中文 Conventional Commits（`feat: 优化延迟监测展示`、`fix(ci): 修复服务端构建错误`）。Rust 每个文件顶部有 `//!` 模块说明，注释偏向解释「为什么这样做」，新代码保持同样密度。

## 常用命令

前置：Rust stable 与 [bun](https://bun.sh)，首次 `cd web && bun install`。

```bash
cargo run -p myprobe-server                 # 主控，http://127.0.0.1:8000
cd web && bun run dev                       # 前端，http://localhost:5173（/api 与 /ws 已代理到 8000）
cargo run -p myprobe-agent -- --server ws://127.0.0.1:8000/ws/agent --secret <密钥>
```

只调前端样式不用起后端：访问 `http://localhost:5173/?mock`，走 `web/src/lib/api.ts` 里的 `mockApi`，登录页随便填密码。`?mock` 只在 dev 下有效——判断裹了 `import.meta.env.DEV`，生产构建里折叠成 false，mock 与样本数据一起被摇掉，线上没法用一个查询参数把界面顶成假数据。要发一份纯演示站得显式 `VITE_MOCK=1 bun run build`。

提交前检查（与 `.github/workflows/ci.yml` 完全一致）：

```bash
cd web && bun run lint && bun run check && cd ..   # biome check + tsc --noEmit
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`bun run fmt` 是 biome 写回格式化。行宽两边都是 110（`rustfmt.toml` / `web/biome.json`）。

目前 workspace 里没有任何测试，`cargo test` 只是守住编译。新增测试用 crate 内联 `#[cfg(test)] mod tests`；跑单个：`cargo test -p myprobe-server <name>`，精确匹配加 `-- --exact`，看输出加 `-- --nocapture`。

## 编译顺序

`crates/server/src/static_assets.rs` 用 rust-embed 在**编译期**读 `web/dist`，并 `include_str!("../../../scripts/myprobe.sh")`：

- 改完前端必须先 `cd web && bun run build` 再 `cargo build -p myprobe-server`，否则二进制里还是旧页面（不报错，静默旧版）。
- `web/dist` 不存在时主控编译直接失败；改 `scripts/myprobe.sh` 也要重编主控，`/install.sh` 才会变。
- 只改 Agent（`cargo build -p myprobe-agent`）不需要前端产物。
- `web/src/flags.generated.css` 由 `web/scripts/gen-flags.mjs` 从 `web/src/lib/countries.ts` 生成（gitignored，`bun run dev`/`build` 会自动跑）。它只挑用到的国旗，直接引全量 flag-icons 会往二进制里塞进 ~5MB。

## 架构

### 三个 crate

- `crates/shared`：`protocol.rs` 是两端唯一的契约（`AgentToServer::{Hello,Metrics,ProbeResult,Pong}` / `ServerToAgent::{Welcome,Config,Ping,AuthFailed}`，`#[serde(tag = "type")]` snake_case）。
- `crates/server`：axum 0.8 + rusqlite（bundled SQLite，WAL）+ rust-embed，`api/` 是 REST，`ws/` 是三个 WebSocket 端点。
- `crates/agent`：sysinfo 采集 + TCP/ICMP 探测，tokio-tungstenite 连出去。

Agent 会每天自动更新，但主控也可能比 Agent 新或旧，**协议改动必须双向兼容**：新字段一律带 `#[serde(default)]`（例：`MetricsSample.net_rx_total/net_tx_total`），不要改已有字段的含义或 tag 名。

### 连接与配置下发

Agent 连上后第一条必须是 `Hello{secret}`，主控按 `servers.secret` 查机器（停用的机器直接拒），回 `Welcome` + `Config`。上报间隔、探测目标全部由主控下发，改完配置由 REST handler 调 `ws::push_config` / `push_config_many` 推给在线 Agent，**Agent 侧立即生效、无需重启**——新增可下发的配置项时记得在对应 handler 里补一次推送。Agent 断线自己重连，2s→60s 退避。

### 在线判定只有一个地方

`AgentRegistry` 里 `conn_id` 防止旧连接的清理误删新连接的槽位；在线与否看独立的 `seen` 心跳表（`MYPROBE_OFFLINE_AFTER`，默认 30s），**不看连接是否存在**——Agent 重启/自动更新才不会闪一下离线。`main.rs` 的 `offline_sweeper`（5s 一轮）是唯一做在线/离线状态翻转并发离线与恢复告警的地方，WS 断开路径故意什么都不判。

### 写入节流与历史

每条上报都会更新内存里的 `LiveMetrics` 并 broadcast，但落库是节流的：指标每连接 15s（`PERSIST_EVERY_MS`），探测每目标 1s（`PROBE_PERSIST_EVERY_MS`），每 200 次写入按行数上限剪表（`MAX_METRIC_ROWS` / `MAX_PROBE_ROWS`），另有 `retention_loop` 每小时按 `MYPROBE_RETENTION_DAYS` 清理。所以库里是稀疏历史，实时性靠 WS + `LiveMetrics`（`latest_metric` 先查内存再回落数据库）。历史查询在 SQL 里按 `(ts - ?) / bucket` 分桶取 `AVG` 与 `MAX`（峰值单独返回 `*_max`），不要改成把原始行拉到内存里聚合。

### 流量计费

Agent 报的是累计计数器（重启会归零、口径不定），主控只取差值：`db.bump_traffic` 用 `traffic_usage.last_rx/last_tx` 做 diff，这条写入**不参与节流**（历史曲线可以稀疏，用量不能丢）。周期边界按 UTC，`reset_day` 取 1-28、0 表示不重置；跨周期在下一次上报时懒滚动并归档到 `traffic_history`，展示时 `traffic_view` 再把过期周期按 0 显示。四种计费口径（仅上传/仅下载/相加/取大）在 `models.rs` 的 `TrafficMode::used`。

### 资产字段与排序

服务器写库前统一过 `api/servers.rs` 的 `ServerReq::attrs()` 规范化：`never_expire` 为真就不存到期日期，`renew_cycle` 是 `Free` 就把价格压成 0，币种 trim 后大写。互斥关系在这一层兜住，库里不会出现「永不到期却带着日期」这种状态——表单里同步清值只是让界面看到的就是最终存下去的东西，别把这类校验只留在前端。`days_to_expire()` 对永不到期返回 `None`，到期提醒与列表展示都靠它短路。

列表顺序是手工的：`servers.sort_order`，查询一律 `ORDER BY sort_order, id`，新机器在 SQL 里取 `MAX(sort_order)+1` 排到末尾。`PUT /api/servers/reorder` 收**整份** id 数组，在一个事务里按下标重写 `sort_order`，没出现在数组里的机器保持原值、由 `ORDER BY` 兜底；改完广播 `ServersChanged` 让其他标签页跟上。前端拖完提交全序，不做增量补丁。

### 延迟配色

三级回退，且**只在主控实现一次**：探测目标自定义的 `probes.latency_bands` → 它引用的命名方案 `latency_schemes.bands` → `settings` 里的全局默认。求值集中在 `api/probes.rs` 的 `BandResolver`（`load` 把方案表与默认值一次性读进来，`resolve` 再逐个目标算），所以接口返回的 `bands` 一定是能直接画的，前端不需要再兜一次。空数组当成「没配」，方案被删（外键 `ON DELETE SET NULL`）或 JSON 坏掉都会自然往下落一级。

方案就是「一套阈值 + 一个名字」，分组（优化 / 不优化、跨洋 / 同城）靠名字表达，没有 tag 概念；改一个方案等于改所有引用它的目标，这正是它存在的理由。图表里**线色表示身份、色带表示快慢**，所以背景 `ReferenceArea` 只在一张图里所有线的 bands 完全一致时才画（`lib/latency.ts` 的 `commonBands` 深比较），否则快慢只留在数字上——阈值不同还铺一层背景是没有唯一含义的。

### 告警

`AlertState` 负责去重：`threshold()` 只在状态翻转时发（键形如 `cpu:{id}`、`traffic:{id}`），`once()` 用于带日期的一次性键（到期提醒）。阈值配置改动后要用 `clear_traffic_alerts` / `clear_timed_alerts` 清掉相关键，否则旧状态会压住新告警。告警状态全在内存，重启后重新武装。发送走 `notify.rs` 的 `Notifier` trait（对象安全，返回 `BoxFuture`），新渠道加在 `from_config` 里。告警发送一律 `tokio::spawn`，不能阻塞消息循环。

### 公开面与后台面

`/ws/ui`（JWT 从 `?token=` 传，浏览器不能给 WS 加头）和 `/ws/public`（免鉴权）订阅的是**同一个 `broadcast::Sender<UiEvent>`**，区别只在鉴权——所以任何进 `UiEvent` 的字段都等于公开，密钥、到期日期、价格、备注不能放进去。REST 侧靠两套 view 结构区分（`state.rs` 的 `ServerView` / `PublicServerView`，密钥用 `mask_secret`）；公开历史接口用 `clamp_history` 夹紧（最多 1000 点、31 天）并过 `PublicCache`（概览 3s、指标与探测历史 10s）。新增字段时先决定它属于哪一面：探测目标两面都返回解析好的 `bands`（两面都要画图），但 `latency_scheme_id` 只给后台，方案名更是从不进 `UiEvent`——方案 CRUD 只 `ui_broadcast()` 一个 `ServersChanged`。

### 数据库

`db.rs` 里 `SCHEMA` 是幂等 `CREATE TABLE IF NOT EXISTS`，加字段/改结构还要在 `Db::open` 的手写迁移链里补一步（`migrate_probes` → `migrate_servers` → `migrate_probe_cols`，用 `has_column` 判断，顺序有依赖：`migrate_probes` 先重建旧表，`migrate_probe_cols` 才能往上加列；整条链跑完才打开 `foreign_keys`，所以 `ADD COLUMN … REFERENCES` 是合法的——新列默认 NULL）。`SERVER_COLS` 被三处查询共用，列顺序必须和 `row_to_server` 对齐。`latency_schemes` 与 `probes.latency_scheme_id` 是外键关系（`ON DELETE SET NULL`），删方案只会让引用它的目标回退，不会连带删目标。告警规则、通知渠道、默认延迟配色、`jwt_secret` 都是 `settings` 表里的 JSON，不是列。整个进程共用一个 `Mutex<Connection>`，所有 DB 方法是同步的，别在热路径里放长查询。

### 前端

React 19 + react-router-dom 7 + Vite 8 + Tailwind 4 + Radix（`components/ui/*` 是 shadcn 风格），路径别名 `@` → `src`。路由在 `App.tsx`：`/` 与 `/s/:id` 是公开状态页，其余在 `RequireAuth` + `Layout` 下。

`lib/api.ts` 用一个 `ApiClient` 接口挂两套实现，模块加载时按 `MOCK` 常量（dev 下的 `?mock`，或 `VITE_MOCK=1` 构建）选一个——**新增接口必须同时补 `realApi` 和 `mockApi`**，否则 mock 模式直接崩。token 在 `localStorage["mp_token"]`，401 抛 `AuthError`，`connectWs` 3s 自动重连。数据获取与事件订阅走 `lib/hooks.ts`（`useAsync` / `useUiEvents` / `usePublicEvents` / `useErrorHandler`）。

### 双端重复实现的逻辑

这几处是故意在前端镜像了 Rust 的算法（为了 mock 与本地展示），改一边要改另一边：

| Rust | TypeScript |
| --- | --- |
| `models.rs` `TrafficMode::used` / `TrafficPlan::cycle_start`+`next_reset` / `state.rs` `traffic_view` | `lib/traffic.ts` `usedBy` / `cycleStart`+`nextReset` / `makeTraffic` |
| `models.rs` `default_latency_bands` / `api/probes.rs` `validate_bands`（2-5 段、`#RRGGBB`、阈值 1-60000ms 递增、末段无上限） | `lib/latency.ts` `DEFAULT_BANDS` / `validateBands` |
| `api/probes.rs` `BandResolver::resolve`（自定义 → 方案 → 全局默认） | `lib/api.ts` `effectiveBands`（只给 mock 用） |
| `api/servers.rs` `ServerReq::attrs` 的字段规范化 | `lib/api.ts` `normalized`（只给 mock 用） |
| `state.rs` `UiEvent` 与各 view 结构 | `lib/types.ts` |

## 发布

推 `v*` tag 触发 `release.yml`：并行跑主控 / 客户端 / 镜像三条流水线，二进制进 Release（附 `SHA256SUMS`），镜像进 GHCR。Linux 目标是 musl 静态链接，bundled SQLite 需要 `CC_*_unknown_linux_musl: musl-gcc`。产物名不带版本号，`releases/latest/download/<名字>` 才能长期可用——一键脚本的自动更新依赖这一点。
